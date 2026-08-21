/* =========================================================
 * rail.js — レール(Catmull-Rom スプライン+弧長テーブル)
 * 各玉は「レール上の距離 d」だけを持ち、posAt(d) で座標へ変換する
 *
 * マルチレーン対応: レールはシングルトンではなく「工場」。
 *   PP.rail.create(course, laneIndex) が独立したレールインスタンスを返す。
 *   各レーンは自分の rail インスタンス(xs/ys/cum/length/holeD/…)を持ち、
 *   N 本のレールを並列に走らせられる。1本コースのときは要素1のレーンが
 *   1つ走るだけなので、従来と同一挙動になる(回帰なし)。
 *
 * 立体交差(overpass)コースでは、build 時にレールの折れ線から自己交差を
 * 自動検出し、交差点付近の「後から通る帯(d が大きい方)」を上と決める。
 * heightAt(d) がその上下(1=上 / 0=下)を返し、描画側が Z 順序に使う。
 *
 * レーン間の橋(どのレーンが上かを作者が明示する立体交差)は、レーン定義の
 *   raised[{from,to}](レール全長に対する割合)で「このレーンが橋=上になる区間」
 * を指定する。raised は overpass の自動検出と同じ overIntervals へ合流するので、
 * heightAt/描画/当たり判定はレーン間交差でもそのまま働く(上に来るレーンの玉が
 * ballOver、下のレーンの玉が ballUnder、橋の桁がその間に入って下の玉を隠す)。
 * 交差が多いコースでは数値の代わりに
 *   raisedOver:[相手レーンindex,…]  「この相手と交差する所では自分が上」
 * と書ける。交差点の位置は実測するので、制御点を動かしても追従する。
 *
 * トンネル(tunnel)は、レーン定義の tunnels[{from,to}](レール全長に対する
 * 割合)を弧長区間へ変換して持つ。tunnelAt(d) が「隠れる区間か」を返し、
 * 描画側は玉を覆いの下に隠し、砲台側は当たり判定から除外する(撃てない)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // レーン定義(course.lanes[laneIndex])から制御点を取り出す。
  // 旧来の course.ctrl 直指定や PP.CTRL へのフォールバックも維持する。
  function ctrlOf(course, laneIndex) {
    laneIndex = laneIndex || 0;
    return (course && course.lanes && course.lanes[laneIndex] && course.lanes[laneIndex].ctrl) ||
           (course && course.ctrl) || PP.CTRL;
  }

  // 2本の折れ線 A(aXs/aYs/aCum)と B(bXs/bYs/bCum)の交点を列挙する純関数。
  // self=true のときは A===B の自己交差(非隣接セグメントのみ・弧長が MIN_GAP 未満
  // しか離れていない対は無視)。自己交差でない(レーン間)ときは全セグメント対を見る。
  // 各交点は {da, db, x, y}(da=A 上の弧長, db=B 上の弧長, x/y=交点座標)。
  function findIntersections(aXs, aYs, aCum, bXs, bYs, bCum, self) {
    var out = [];
    var MIN_GAP = PP.D * 4;
    var na = aXs.length - 1, nb = bXs.length - 1;
    for (var i = 0; i < na; i++) {
      var ax = aXs[i], ay = aYs[i], bx = aXs[i + 1], by = aYs[i + 1];
      // セグメント i の外接矩形を先に出しておき、重ならない相手は除算入りの
      // segHit を呼ばずに落とす。全セグメント対の総当たり(4レーンのコースで
      // 約100万対)は変わらないが、直線サンプリングの折れ線では大半の対が
      // ここで弾かれるので、レベル開始時の一発ハングが実測で桁落ちする
      var ix0 = ax < bx ? ax : bx, ix1 = ax < bx ? bx : ax;
      var iy0 = ay < by ? ay : by, iy1 = ay < by ? by : ay;
      for (var j = self ? i + 2 : 0; j < nb; j++) {
        if (self && bCum[j] - aCum[i] < MIN_GAP) continue;
        var jx = bXs[j], jx2 = bXs[j + 1], jy = bYs[j], jy2 = bYs[j + 1];
        if ((jx < ix0 && jx2 < ix0) || (jx > ix1 && jx2 > ix1) ||
            (jy < iy0 && jy2 < iy0) || (jy > iy1 && jy2 > iy1)) continue;
        var t = segHit(ax, ay, bx, by, jx, jy, jx2, jy2);
        if (t < 0) continue;
        var db = bCum[j] + t * (bCum[j + 1] - bCum[j]);
        var x = bXs[j] + t * (bXs[j + 1] - bXs[j]);
        var y = bYs[j] + t * (bYs[j + 1] - bYs[j]);
        // A 側の弧長 da は交点をセグメント i へ射影して求める
        var sx = bx - ax, sy = by - ay, sl2 = sx * sx + sy * sy || 1;
        var s = ((x - ax) * sx + (y - ay) * sy) / sl2;
        var da = aCum[i] + s * (aCum[i + 1] - aCum[i]);
        out.push({ da: da, db: db, x: x, y: y });
      }
    }
    return out;
  }

  // レール折れ線(xs/ys/cum)から自己交差を検出し、上に来る帯の弧長区間を返す。
  // 交差する2帯のうち d が大きい方(後から通る=橋)を上にする(従来どおり)。
  function detectCrossings(xs, ys, cum) {
    var out = [];
    var W = PP.D * 1.5;                 // 交差点の前後この距離を「上」にする
    var hits = findIntersections(xs, ys, cum, xs, ys, cum, true);
    for (var i = 0; i < hits.length; i++) out.push([hits[i].db - W, hits[i].db + W]);
    return out;
  }

  // コース内の全交差(自己交差 + レーン間交差)を列挙する。作者向け検証で使う。
  // 各要素 {laneA, laneB, da, db, x, y}。laneA===laneB は自己交差。
  function courseCrossings(course) {
    var lanes = (course && course.lanes) || [{ ctrl: course && course.ctrl }];
    var pls = [];
    for (var i = 0; i < lanes.length; i++) pls.push(measure(course, i));
    var out = [];
    for (var a = 0; a < pls.length; a++) {
      for (var b = a; b < pls.length; b++) {
        var hits = findIntersections(pls[a].xs, pls[a].ys, pls[a].cum,
          pls[b].xs, pls[b].ys, pls[b].cum, a === b);
        for (var k = 0; k < hits.length; k++) {
          out.push({ laneA: a, laneB: b, da: hits[k].da, db: hits[k].db, x: hits[k].x, y: hits[k].y });
        }
      }
    }
    return out;
  }

  // 線分 p1-p2 と p3-p4 の交差判定。交差すれば第2線分上の媒介変数 t、
  // 交差しなければ -1 を返す。判定は半開区間 [0,1) にしてある: 直角の街路では
  // 交差点が片方の道の頂点にちょうど乗ることが多く、端点を両側とも弾くと
  // (t=0 と t=1 の隣接2セグメント両方で落ちて)検出漏れになる。半開なら
  // 頂点に乗る交差を「そこから始まる側」で1回だけ拾える。
  function segHit(x1, y1, x2, y2, x3, y3, x4, y4) {
    var d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (d === 0) return -1;            // 平行
    var s = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    var t = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    if (s < 0 || s >= 1 || t < 0 || t >= 1) return -1;
    return t;
  }

  // 滑らかなスプライン(既定)。制御点を Catmull-Rom で結ぶ
  // 出力は引数で渡された配列 ox/oy に積む(build と measure が共有する)
  function buildSpline(CTRL, ox, oy) {
    function pt(i) { return CTRL[Math.max(0, Math.min(CTRL.length - 1, i))]; }
    // 3要素目が 0(=角)の点は「カクッと折れる角」。その点では接線を切って
    // 端点と同じ扱いにし、滑らかに丸めない(角にしない点は従来どおり通過する)。
    function sharp(i) { var p = CTRL[i]; return !!p && p.length > 2 && p[2] <= 0.5; }
    function catmull(p0, p1, p2, p3, t) {
      var t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * p1) + (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
    for (var i = 0; i < CTRL.length - 1; i++) {
      // 点 i が角なら「出る接線」を、点 i+1 が角なら「入る接線」を端点扱いに寄せる
      var p0 = pt(sharp(i) ? i : i - 1);
      var p1 = pt(i), p2 = pt(i + 1);
      var p3 = pt(sharp(i + 1) ? i + 1 : i + 2);
      var steps = 24;
      for (var s = 0; s < steps; s++) {
        var t = s / steps;
        ox.push(catmull(p0[0], p1[0], p2[0], p3[0], t));
        oy.push(catmull(p0[1], p1[1], p2[1], p3[1], t));
      }
    }
    ox.push(CTRL[CTRL.length - 1][0]);
    oy.push(CTRL[CTRL.length - 1][1]);
  }

  // 直角の街路(ローマの街並み風)。制御点=角の折れ点として直線で結び、
  // 各角には半径 rc の小さな角丸(二次ベジェ)を入れて球が急に跳ねないようにする。
  function buildSharp(CTRL, rc, xs, ys) {
    var SP = 6;                        // 直線のサンプル間隔 px
    function push(x, y) {
      // 直前の点と近すぎるなら間引く(弧長テーブルの重複を避ける)
      var n = xs.length;
      if (n > 0) { var dx = x - xs[n - 1], dy = y - ys[n - 1]; if (dx * dx + dy * dy < 0.25) return; }
      xs.push(x); ys.push(y);
    }
    function line(ax, ay, bx, by) {
      var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
      var n = Math.max(1, Math.round(len / SP));
      for (var k = 1; k <= n; k++) { var t = k / n; push(ax + dx * t, ay + dy * t); }
    }
    function quad(ax, ay, cxp, cyp, bx, by) {    // 角の丸め(制御点=角)
      var n = 8;
      for (var k = 1; k <= n; k++) {
        var t = k / n, u = 1 - t;
        push(u * u * ax + 2 * u * t * cxp + t * t * bx,
             u * u * ay + 2 * u * t * cyp + t * t * by);
      }
    }
    function norm(dx, dy) { var l = Math.sqrt(dx * dx + dy * dy) || 1; return [dx / l, dy / l]; }

    push(CTRL[0][0], CTRL[0][1]);
    for (var i = 1; i < CTRL.length - 1; i++) {
      var A = CTRL[i - 1], B = CTRL[i], C = CTRL[i + 1];
      var d1 = norm(B[0] - A[0], B[1] - A[1]);
      var d2 = norm(C[0] - B[0], C[1] - B[1]);
      var lenIn = Math.hypot(B[0] - A[0], B[1] - A[1]);
      var lenOut = Math.hypot(C[0] - B[0], C[1] - B[1]);
      // 角丸半径は点ごとの指定(B[2])が優先。未指定ならコース既定の rc。0=直角。
      var pr = (B.length > 2 && isFinite(B[2])) ? B[2] : rc;
      var r = Math.min(pr, lenIn / 2, lenOut / 2);
      var t1x = B[0] - d1[0] * r, t1y = B[1] - d1[1] * r;   // 角の手前
      var t2x = B[0] + d2[0] * r, t2y = B[1] + d2[1] * r;   // 角の先
      line(xs.length ? xs[xs.length - 1] : A[0], ys.length ? ys[ys.length - 1] : A[1], t1x, t1y);
      quad(t1x, t1y, B[0], B[1], t2x, t2y);                 // 角丸
    }
    var last = CTRL[CTRL.length - 1];
    line(xs[xs.length - 1], ys[ys.length - 1], last[0], last[1]);
  }

  // コースのレーンを折れ線(xs/ys)と弧長テーブル(cum)へ変換する純関数。
  // モジュールの状態には一切触れないので、ゲーム進行中でも安全に呼べる。
  // エディタのプレビュー描画とコース検証(全長・座標)が使う。
  // laneIndex 省略時は 0(従来 API 互換)。
  function measure(course, laneIndex) {
    var CTRL = ctrlOf(course, laneIndex);
    var ox = [], oy = [], oc = [0];
    if (course && course.sharp) buildSharp(CTRL, course.corner || 26, ox, oy);
    else buildSpline(CTRL, ox, oy);
    for (var i = 1; i < ox.length; i++) {
      var dx = ox[i] - ox[i - 1], dy = oy[i] - oy[i - 1];
      oc.push(oc[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return { xs: ox, ys: oy, cum: oc, length: oc[oc.length - 1] || 0, ctrl: CTRL };
  }

  // レーン定義の tunnels(レール全長に対する割合)を弧長区間 [[dLo,dHi],…] へ。
  // 受け付ける形は {from,to} でも [from,to] でも可。範囲は 0..1 にクランプし、
  // from<=to に正規化する。length は measure 済みのレール全長。
  function tunnelsOf(course, laneIndex, length) {
    var lane = course && course.lanes && course.lanes[laneIndex];
    var spec = (lane && lane.tunnels) || (course && course.tunnels) || [];
    var out = [];
    for (var i = 0; i < spec.length; i++) {
      var t = spec[i];
      var a = (t && t.from !== undefined) ? t.from : (t && t[0]);
      var b = (t && t.to !== undefined) ? t.to : (t && t[1]);
      if (a === undefined || b === undefined) continue;
      a = Math.max(0, Math.min(1, a));
      b = Math.max(0, Math.min(1, b));
      if (a > b) { var tmp = a; a = b; b = tmp; }
      out.push([a * length, b * length]);
    }
    return out;
  }

  // レーン定義の raised(このレーンが橋=上になる区間。全長に対する割合)を
  // 弧長区間 [[dLo,dHi],…] へ。形は {from,to} でも [from,to] でも可。tunnelsOf と同形。
  function raisedOf(course, laneIndex, length) {
    var lane = course && course.lanes && course.lanes[laneIndex];
    var spec = (lane && lane.raised) || (course && course.raised) || [];
    var out = [];
    for (var i = 0; i < spec.length; i++) {
      var t = spec[i];
      var a = (t && t.from !== undefined) ? t.from : (t && t[0]);
      var b = (t && t.to !== undefined) ? t.to : (t && t[1]);
      if (a === undefined || b === undefined) continue;
      a = Math.max(0, Math.min(1, a));
      b = Math.max(0, Math.min(1, b));
      if (a > b) { var tmp = a; a = b; b = tmp; }
      out.push([a * length, b * length]);
    }
    return out;
  }

  // courseCrossings は全レーンを measure し直す O(n^2)。raisedOver はレーンごとに
  // create() から引くので、直前と同じコースなら結果を使い回す。
  var _ccCourse = null, _ccResult = null;
  function cachedCrossings(course) {
    if (course !== _ccCourse) { _ccCourse = course; _ccResult = courseCrossings(course); }
    return _ccResult;
  }

  // レーン定義の raisedOver:[相手レーンindex,…] を弧長区間 [[dLo,dHi],…] へ。
  // 「このレーンが、指定した相手レーンと交差する所では橋(上)になる」という宣言。
  // raised が「全長比の数値」で場所を書くのに対し、こちらは相手を書くだけでよい:
  // 交差点の位置は courseCrossings が実測するので、制御点を動かしても勝手に追従する
  // (交差が4つある四叉の激流のようなコースは、数値直書きだと調整のたびに壊れる)。
  function raisedOverOf(course, laneIndex) {
    var lane = course && course.lanes && course.lanes[laneIndex];
    var over = lane && lane.raisedOver;
    if (!over || !over.length) return [];
    var W = PP.D * 1.5;                 // 橋にする幅。detectCrossings と揃える
    var cs = cachedCrossings(course);
    var out = [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.laneA === c.laneB) continue;                       // 自己交差は overpass の担当
      if (c.laneA === laneIndex && over.indexOf(c.laneB) >= 0) out.push([c.da - W, c.da + W]);
      else if (c.laneB === laneIndex && over.indexOf(c.laneA) >= 0) out.push([c.db - W, c.db + W]);
    }
    return out;
  }

  // レール1本のインスタンスを作る。返すオブジェクトが1レーンぶんのレール。
  function create(course, laneIndex) {
    laneIndex = laneIndex || 0;
    var pl = measure(course, laneIndex);
    var xs = pl.xs, ys = pl.ys, cum = pl.cum;
    var length = pl.length;
    var holeD = length - 6;            // ゲームオーバー地点(レール上の距離)

    // 上に来る帯(=橋)の弧長区間。overpass の自動検出と、レーン定義の raised
    // (作者が明示する上下)を合流させる。heightAt はこの区間で 1(上)を返す。
    var overIntervals = (course && course.overpass) ? detectCrossings(xs, ys, cum) : [];
    var raised = raisedOf(course, laneIndex, length);
    if (raised.length) overIntervals = overIntervals.concat(raised);
    var raisedOver = raisedOverOf(course, laneIndex);
    if (raisedOver.length) overIntervals = overIntervals.concat(raisedOver);
    var tunnels = tunnelsOf(course, laneIndex, length);

    // レール上の距離 d → 座標と接線を out に書き込む(out を返す)。
    // 毎フレーム玉数ぶん・レール光ドット数ぶん呼ばれる = 最も回数の多い関数なので、
    // 戻り値のオブジェクトを新規生成せず、呼び出し側が使い回す out に詰める版を用意する。
    function posAtInto(d, out) {
      if (d <= 0) d = 0;
      if (d >= length) d = length - 0.001;
      var lo = 0, hi = cum.length - 1;
      while (lo + 1 < hi) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid; else hi = mid;
      }
      var seg = cum[hi] - cum[lo] || 1;
      var t = (d - cum[lo]) / seg;
      out.x = xs[lo] + (xs[hi] - xs[lo]) * t;
      out.y = ys[lo] + (ys[hi] - ys[lo]) * t;
      out.tx = (xs[hi] - xs[lo]) / seg;
      out.ty = (ys[hi] - ys[lo]) / seg;
      return out;
    }

    // 従来 API 互換(戻り値を保持したい呼び出し用に毎回新規生成)。
    // ホットループでは posAtInto に使い回しオブジェクトを渡すこと。
    function posAt(d) { return posAtInto(d, {}); }

    // 立体交差の上下: 交差点付近で「上に来る帯」なら 1、それ以外は 0。
    //
    // pad は区間を前後に広げる余裕。玉の描画レイヤーを決めるときは pad=玉半径 を
    // 渡すこと。区間をそのまま(pad=0)使うと、玉の中心が hi を過ぎた瞬間に
    // ballOver → ballUnder へ移るが、玉には半径があるので前半分はまだ桁の上に
    // 乗っている。結果、橋の出入り口で玉が桁に食い込んで欠けて見える。
    // 「玉が桁に少しでも重なっている間は上の層に置く」= pad=R が正しい。
    function heightAt(d, pad) {
      pad = pad || 0;
      for (var i = 0; i < overIntervals.length; i++) {
        if (d >= overIntervals[i][0] - pad && d <= overIntervals[i][1] + pad) return 1;
      }
      return 0;
    }

    // トンネル: d がトンネル区間の内側なら true(隠れる/撃てない)。
    function tunnelAt(d) {
      for (var i = 0; i < tunnels.length; i++) {
        if (d >= tunnels[i][0] && d <= tunnels[i][1]) return true;
      }
      return false;
    }

    return {
      posAt: posAt,
      posAtInto: posAtInto,
      heightAt: heightAt,
      tunnelAt: tunnelAt,
      xs: xs,
      ys: ys,
      length: length,
      holeD: holeD,
      overIntervals: overIntervals,
      tunnels: tunnels
    };
  }

  // PP.rail は「工場+純関数」の名前空間。レールインスタンスは create が返す。
  PP.rail = {
    create: create,
    measure: measure,
    courseCrossings: courseCrossings,  // 作者向け検証(自己交差+レーン間交差の列挙)
    cachedCrossings: cachedCrossings,  // 同上のメモ化版(main.js buildCourse が使う。
                                       // create → raisedOverOf が先に温めるので、
                                       // 直後の橋の作画で O(n^2) を計算し直さない)
    // キャッシュの明示失効。キャッシュはコースオブジェクトの同一性で判定して
    // いるため、エディタが同一オブジェクトの制御点を書き替えて試遊した場合に
    // 古い交差一覧を掴み続ける。コースを組み直す入口(buildCourse)で必ず呼ぶ
    invalidateCrossings: function () { _ccCourse = null; _ccResult = null; }
  };
})();
