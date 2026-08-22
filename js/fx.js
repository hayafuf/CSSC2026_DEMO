/* =========================================================
 * fx.js — パーティクル・フロートテキスト・画面の揺れ
 *
 * 消去は「リング衝撃波 + 飛び散るシャード + きらめき + 瞬間フラッシュ」の
 * 重ね合わせで、当たった手応えを出す。API(particles/burst/floatText/shake/
 * updateShake/resetShake)は従来互換で、中身だけ強化してある。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // ---------- パーティクルプール ----------
  // burst/splash/missileTrail は毎フレーム大量に呼ばれる(特にボス戦の弾トレイル)。
  // 都度 Shape+Graphics+Tween を作ると GC と removeChild(indexOf走査)が支配的に
  // なるため、色ごとに一度だけ焼いた円 canvas を Bitmap で使い回し、自前積分で
  // 動かす。定常状態では割り当てゼロ。
  var MAX_P = 360;             // 同時生存の上限。飽和時は超過スポーンを捨てる
                               // (リング/フラッシュ/シャードもプールに同居する
                               //  ようになったぶん、旧 300 から少し広げてある)
  var DOT_R = 4.5;             // 焼き込み円の半径(呼び出し側の最大値)
  var dotCanvas = {};          // CSS色文字列 → 焼き込み済み canvas
  var dotCanvasN = 0;          // 色マップの肥大ガード用
  var pActive = [];
  // 空き Bitmap は合成モードごとに別のプール/別の Container に分ける。
  // 【なぜ分けるか】StageGL(携帯)の加算合成は gl-patch.js が「lighter⇔通常 の
  // 境界ごとに flush」で実現している。1 つの Container に通常(破片・しぶき)と
  // lighter(リング・閃光・火花)の Bitmap が混ざると、子の並び順は最初に確保
  // された順で固定され、どの枠がどちらのモードかは事実上ランダムになる。
  // 生存 150 個で約 60 回の flush(=60 draw call)が連鎖のたびに走っていた。
  // 通常用 pcontN → lighter 用 pcontL の 2 層に分ければ境界は常に 1 回で済む。
  // 合成モードは Container 側に付け、Bitmap 個別には付けない(gl-patch ★1 の
  // 親継承と Canvas 2D の Container 合成の両方で効く)
  var pFreeN = [], pFreeL = [];
  var recFree = [];            // 使い終わったパーティクルレコードの返却先(spawnDot 参照)
  var pcontN = null, pcontL = null;   // プール専用 Container(fx レイヤーに一度だけ載せる)

  function bakeDot(color) {
    var s = new createjs.Shape();
    s.graphics.beginFill(color).drawCircle(0, 0, DOT_R);
    s.cache(-DOT_R - 1, -DOT_R - 1, DOT_R * 2 + 2, DOT_R * 2 + 2);
    // 焼き込み canvas に「描画原点が canvas 内のどこか」を持たせ、
    // spawnDot が regX/regY に写す(円は中心、トレイルは上端中央など)
    s.cacheCanvas._rx = DOT_R + 1;
    s.cacheCanvas._ry = DOT_R + 1;
    return s.cacheCanvas;
  }

  function ensureCont(lighter) {
    if (!pcontN) {
      pcontN = new createjs.Container();
      pcontN.mouseEnabled = pcontN.mouseChildren = false;
      pcontL = new createjs.Container();
      pcontL.mouseEnabled = pcontL.mouseChildren = false;
      pcontL.compositeOperation = "lighter";
      // 通常→発光の順(発光が手前)。同時に出る破片とリングは元々ほぼ同じ
      // 場所に重なるので、重ね順の入れ替わりは見分けがつかない
      PP.layers.fx.addChild(pcontN, pcontL);
    }
    return lighter ? pcontL : pcontN;
  }

  // 汎用スポーン: (x0,y0)→(tx,ty) へ quadOut で移動、scale も s0→s1 へ補間、
  // alpha は a0→0。img は焼き込み canvas、comp は合成モード(null で通常)。
  // opts は省略可能な拡張(particles の載せ替えで必要になった分だけ):
  //   delay(ms)   出番までの待ち。待機中は visible=false で寝かせる
  //   rot0/rotSpin 開始角(度)と回転量(度)。回転も同じイージングで進む
  //   easeIn      true で quadIn(加速)。血の滴りなど「落ちる」動きに使う
  //   a0          開始 alpha(省略時 1)
  function spawnDot(img, comp, x0, y0, tx, ty, s0x, s0y, s1x, s1y, durMs, opts) {
    // 低負荷モードは天井を下げる(PERF.LOW.maxP)。生成の唯一の入口なので
    // ここ1か所のゲートで全種(リング/フラッシュ/シャード/火花)に効く
    if (pActive.length >= (PP.quality === 0 ? PP.PERF.LOW.maxP : MAX_P)) return;
    // comp は "lighter" か null の 2 値(他の合成モードは GL で表現できない)
    var lighter = comp === "lighter";
    var b = (lighter ? pFreeL : pFreeN).pop();
    if (!b) {
      b = new createjs.Bitmap(null);
      b._ppLighter = lighter;   // 返却時にどちらのプールへ戻すか
      ensureCont(lighter).addChild(b);
    }
    var delay = (opts && opts.delay) ? opts.delay / 1000 : 0;
    var a0 = (opts && opts.a0 !== undefined) ? opts.a0 : 1;
    b.image = img;
    b.regX = img._rx; b.regY = img._ry;
    b.visible = delay <= 0; b.alpha = a0;
    b.x = x0; b.y = y0; b.scaleX = s0x; b.scaleY = s0y;
    b.rotation = (opts && opts.rot0) || 0;
    // レコードの形はいつも同じにする(JS エンジンが同じ「形」のオブジェクトを
    // 高速に扱えるため、使わない拡張フィールドも 0/false で必ず埋める)。
    // レコード自体も Bitmap と同様にプールで使い回す: 連鎖中は毎フレーム
    // 十数個スポーンするので、作り捨てだと GC のゴミが出続ける
    // (GC の一時停止は FPS の谷になり、音の途切れの引き金にもなる)
    var p = recFree.pop();
    if (!p) {
      p = { bmp: null, age: 0, dur: 0, delay: 0, x0: 0, y0: 0, tx: 0, ty: 0,
            s0x: 0, s0y: 0, s1x: 0, s1y: 0, rot0: 0, rotSpin: 0,
            easeIn: false, a0: 1 };
    }
    p.bmp = b; p.age = 0; p.dur = durMs / 1000; p.delay = delay;
    p.x0 = x0; p.y0 = y0; p.tx = tx; p.ty = ty;
    p.s0x = s0x; p.s0y = s0y; p.s1x = s1x; p.s1y = s1y;
    p.rot0 = (opts && opts.rot0) || 0;
    p.rotSpin = (opts && opts.rotSpin) || 0;
    p.easeIn = !!(opts && opts.easeIn);
    p.a0 = a0;
    pActive.push(p);
  }

  function updateParticles(dt) {
    for (var i = pActive.length - 1; i >= 0; i--) {
      var p = pActive[i];
      p.age += dt;
      var t = p.age - p.delay;
      if (t < 0) continue;               // まだ出番前(visible=false のまま待機)
      var k = t / p.dur;
      if (k >= 1) {
        p.bmp.visible = false;
        (p.bmp._ppLighter ? pFreeL : pFreeN).push(p.bmp);
        p.bmp = null;          // Bitmap への参照を切ってからレコードも返却する
        recFree.push(p);
        pActive[i] = pActive[pActive.length - 1];
        pActive.pop();
        continue;
      }
      var b = p.bmp;
      if (!b.visible) b.visible = true;  // 遅延明けの初回にここで目を覚ます
      var e = p.easeIn ? k * k                       // quadIn(加速して落ちる)
                       : 1 - (1 - k) * (1 - k);      // quadOut(従来 Tween と同じ)
      b.x = p.x0 + (p.tx - p.x0) * e;
      b.y = p.y0 + (p.ty - p.y0) * e;
      b.scaleX = p.s0x + (p.s1x - p.s0x) * e;
      b.scaleY = p.s0y + (p.s1y - p.s0y) * e;
      b.rotation = p.rot0 + p.rotSpin * e;
      b.alpha = p.a0 * (1 - e);
    }
  }

  function particleLoad() { return pActive.length / MAX_P; }

  function dotFor(color) {
    var img = dotCanvas[color];
    if (img === undefined) {
      // 色は有限のリテラル集合のはずだが、万一動的生成色が流れ込んでも
      // マップが無限に育たないようガードする(超過分は白で代用)
      if (dotCanvasN >= 64) return dotCanvas["#ffffff"] || (dotCanvas["#ffffff"] = bakeDot("#ffffff"));
      img = dotCanvas[color] = bakeDot(color);
      dotCanvasN++;
    }
    return img;
  }

  // ---------- リング/フラッシュ/シャードの焼き込み ----------
  // どれも「終端(いちばん大きく表示される瞬間)のサイズ」で焼き、開始は縮小
  // 表示にする。拡大終端で等倍=一番見られる瞬間が一番きれい、という向き。
  // 以前のベクタ版も transform の拡大でストロークごと太っていたので、
  // ビットマップの拡大と見た目は一致する。
  // 焼く解像度は「よく使う最大サイズ」に合わせる: リングは r1=34〜120 が大半
  // (ボスの大技の 180 だけは 3 倍拡大になるが、加算合成で消えていく光なので
  //  にじみはむしろ発光に見える)。フラッシュは元々なめらかなグラデなので
  //  多少の拡大では絵が変わらない
  var RING_BAKE = 6;     // 元実装: 半径10・線幅2.4 の円を transform で拡大していた
  var RING_R = 10 * RING_BAKE;
  var FLASH_R = 72;      // flash の最大表示半径(rad110 × 1.6)の約 1/2.4 で焼く
  var ringCanvas = {}, flashCanvas = {}, shardCanvas = {}, extraCanvasN = 0;

  function bakeInto(map, color, draw) {
    var img = map[color];
    if (img === undefined) {
      // dotFor と同じ肥大ガード(動的な色文字列が流れ込んでも無限に育たない)
      if (extraCanvasN >= 64) color = "#ffffff";
      if (map[color] === undefined) { map[color] = draw(color); extraCanvasN++; }
      img = map[color];
    }
    return img;
  }

  function bakeRing(color) {
    var s = new createjs.Shape();
    s.graphics.setStrokeStyle(2.4 * RING_BAKE).beginStroke(color).drawCircle(0, 0, RING_R);
    var half = Math.ceil(RING_R + 1.2 * RING_BAKE + 2);
    s.cache(-half, -half, half * 2, half * 2);
    s.cacheCanvas._rx = half; s.cacheCanvas._ry = half;
    return s.cacheCanvas;
  }

  function bakeFlash(color) {
    var s = new createjs.Shape();
    s.graphics.beginRadialGradientFill([color, "rgba(255,255,255,0)"], [0, 1],
      0, 0, 2, 0, 0, FLASH_R).drawCircle(0, 0, FLASH_R);
    s.cache(-FLASH_R - 1, -FLASH_R - 1, FLASH_R * 2 + 2, FLASH_R * 2 + 2);
    s.cacheCanvas._rx = FLASH_R + 1; s.cacheCanvas._ry = FLASH_R + 1;
    return s.cacheCanvas;
  }

  // シャード(玉が砕けた破片)。基準サイズで焼いて等率 scale で大小を出す。
  // 縮小方向にしか使わないのでボケない。2:1 の縦横比は焼いた形が保つ
  var SHARD_SZ0 = 5.5;   // 呼び出し側のランダムサイズ 2〜5.5 の最大値
  function bakeShard(color) {
    var s = new createjs.Shape();
    s.graphics.beginFill(color).drawRect(-SHARD_SZ0, -SHARD_SZ0 * 0.5, SHARD_SZ0 * 2, SHARD_SZ0);
    s.cache(-SHARD_SZ0 - 1, -SHARD_SZ0 * 0.5 - 1, SHARD_SZ0 * 2 + 2, SHARD_SZ0 + 2);
    s.cacheCanvas._rx = SHARD_SZ0 + 1;
    s.cacheCanvas._ry = SHARD_SZ0 * 0.5 + 1;
    return s.cacheCanvas;
  }

  // リング衝撃波(加算合成で光る輪が広がって消える)。delayMs は内部用
  // (particles が消去の時間差カスケードに使う。公開 API の形は従来どおり)
  function ring(x, y, color, r0, r1, dur, delayMs) {
    var img = bakeInto(ringCanvas, color, bakeRing);
    var s0 = (r0 || 4) / RING_R, s1 = (r1 || 34) / RING_R;
    spawnDot(img, "lighter", x, y, x, y, s0, s0, s1, s1, dur || 360,
      delayMs ? { delay: delayMs } : null);
  }

  // 瞬間フラッシュ(着弾点の光)
  function flash(x, y, color, rad, delayMs) {
    var img = bakeInto(flashCanvas, color, bakeFlash);
    var s0 = (rad || 22) / FLASH_R, s1 = s0 * 1.6;
    spawnDot(img, "lighter", x, y, x, y, s0, s0, s1, s1, 260,
      delayMs ? { delay: delayMs } : null);
  }

  // 消去の華やかな破裂(色シャード + きらめき + リング + フラッシュ)。
  // ※ 以前は玉1個につき Shape 11個 + Tween 11本 + クロージャを作っていて、
  //   10連鎖では1フレームに100個超のゴミが出て GC のカクつきになっていた。
  //   いまは全部プール(spawnDot)経由: 破片の「重力」は物理ではなく着地点を
  //   +16px 下げた quadOut 移動だったので、同じ着地点を渡せば軌道は完全に同一。
  function particles(x, y, colorIndex, delay) {
    var pal = PP.PALETTE[colorIndex] || { light: "#fff", main: "#ffd27a" };
    var color = pal.main, light = pal.light;
    delay = delay || 0;

    // リング + フラッシュは1回だけ(遅延に合わせて出す)
    ring(x, y, light, 4, 30, 340, delay);
    flash(x, y, light, 20, delay);

    // 低負荷モード(PP.quality=0、main.js の低FPS検知)では個数を絞る
    var q = PP.quality === 0 ? PP.PERF.LOW.shardMul : 1;

    // 飛び散る色シャード(重力付き・回転しながら消える)
    // TODO【課題4】玉が消えるときの破片の数。7 を増やすと派手になる
    // (増やしすぎると重くなるので 30 以下がおすすめ)
    var shardN = Math.max(1, Math.round(7 * q));
    for (var i = 0; i < shardN; i++) {
      var img = bakeInto(shardCanvas, Math.random() < 0.4 ? light : color, bakeShard);
      var sz = 2 + Math.random() * 3.5;
      var sc = sz / SHARD_SZ0;
      var ang = Math.random() * Math.PI * 2;
      var dist = 20 + Math.random() * 34;
      spawnDot(img, null, x, y,
        x + Math.cos(ang) * dist, y + Math.sin(ang) * dist + 16,
        sc, sc, sc, sc, 360 + Math.random() * 240,
        { delay: delay, rot0: Math.random() * 360, rotSpin: (Math.random() - 0.5) * 300 });
    }
    // 白いきらめき(加算)
    // TODO【課題4】きらめきの数。破片(上)とセットで増減させるとよい
    var sparkImg = dotFor("rgba(255,252,240,0.95)");
    var sparkN = Math.max(1, Math.round(3 * q));
    for (var j = 0; j < sparkN; j++) {
      var r = 1.4 + Math.random() * 1.6;
      var ssc = r / DOT_R;
      var ang2 = Math.random() * Math.PI * 2, dist2 = 10 + Math.random() * 22;
      spawnDot(sparkImg, "lighter", x, y,
        x + Math.cos(ang2) * dist2, y + Math.sin(ang2) * dist2,
        ssc, ssc, ssc, ssc, 300 + Math.random() * 200, { delay: delay });
    }
  }

  // 汎用バースト(CSS色指定・粉砕/解放演出用)。glow 付きで少し重力。
  // spread(省略時1)で飛距離を倍率で広げられる(爆弾の大爆発などで使う)
  function burst(x, y, color, count, spread) {
    spread = spread || 1;
    var img = dotFor(color);
    for (var i = 0; i < count; i++) {
      var r = 1.5 + Math.random() * 3;
      var sc = r / DOT_R;
      var ang = Math.random() * Math.PI * 2;
      var dist = (22 + Math.random() * 44) * spread;
      spawnDot(img, "lighter", x, y,
        x + Math.cos(ang) * dist, y + Math.sin(ang) * dist + 18,
        sc, sc, sc, sc, 380 + Math.random() * 280);
    }
  }

  // 着弾/割り込みの小さな水しぶき(任意で呼ぶ)
  function splash(x, y, color) {
    ring(x, y, color || "rgba(180,214,236,0.8)", 3, 22, 300);
    var img = dotFor(color || "rgba(200,224,244,0.9)");
    for (var i = 0; i < 5; i++) {
      var r = 1 + Math.random() * 2;
      var sc = r / DOT_R;
      var ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, dist = 10 + Math.random() * 18;
      spawnDot(img, null, x, y,
        x + Math.cos(ang) * dist, y + Math.sin(ang) * dist + 10,
        sc, sc, sc, sc, 300);
    }
  }

  // ミサイルの噴射トレイル(加算合成の縦ストリーク)。毎フレーム呼んで
  // 残像を重ねる。y から下方向に len だけ伸び、すぐフェードして消える。
  // w は破壊回廊の全幅(省略時 6px)。芯の強い光+回廊いっぱいの淡い光の
  // 2層にして、「この幅が薙ぎ払われる」ことが見た目で分かるようにする。
  // 縦グラデ矩形は基準長 TRAIL_LEN0 で一度だけ焼き、scaleY=len/TRAIL_LEN0 で
  // 伸縮する(線形グラデは線形スケールで見た目が一致する)
  var TRAIL_LEN0 = 140, TRAIL_W0 = 40;
  var trailCore = null, trailWide = null;

  function bakeTrail(stops, w) {
    var s = new createjs.Shape();
    s.graphics.beginLinearGradientFill(stops, [0, 0.4, 1], 0, 0, 0, TRAIL_LEN0)
      .drawRect(-w / 2, 0, w, TRAIL_LEN0);
    s.cache(-w / 2 - 1, 0, w + 2, TRAIL_LEN0);
    s.cacheCanvas._rx = w / 2 + 1;
    s.cacheCanvas._ry = 0;
    return s.cacheCanvas;
  }

  function missileTrail(x, y, len, w) {
    if (!trailCore) {
      trailCore = bakeTrail(
        ["rgba(255,244,192,0.85)", "rgba(255,138,42,0.4)", "rgba(255,120,20,0)"], 6);
      trailWide = bakeTrail(
        ["rgba(255,200,120,0.28)", "rgba(255,140,50,0.12)", "rgba(255,120,20,0)"], TRAIL_W0);
    }
    var sy = len / TRAIL_LEN0;
    if (w && w > 12) {
      var sx = w / TRAIL_W0;
      spawnDot(trailWide, "lighter", x, y, x, y, sx, sy, sx * 0.4, sy, 200);
    }
    spawnDot(trailCore, "lighter", x, y, x, y, 1, sy, 0.4, sy, 200);
  }

  // 全画面フラッシュ(特殊攻撃の「発動した!」を画面全体で伝える)。
  // color は CSS 色、alpha は最大の明るさ、dur はフェード時間(ms)。
  // 単色は 8×8 の焼き込みを引き伸ばしても完全に同じ絵になるのでプールに乗せる。
  // 画面より 1.3 倍大きく貼るのは、ビットマップ端の補間で縁が薄まるのを
  // 画面の外へ追い出すため
  var solidCanvas = {};
  function bakeSolid(color) {
    var s = new createjs.Shape();
    s.graphics.beginFill(color).drawRect(0, 0, 8, 8);
    s.cache(0, 0, 8, 8);
    s.cacheCanvas._rx = 4; s.cacheCanvas._ry = 4;
    return s.cacheCanvas;
  }
  function screenFlash(color, alpha, dur) {
    var img = bakeInto(solidCanvas, color, bakeSolid);
    var sx = PP.W * 1.3 / 8, sy = PP.H * 1.3 / 8;
    spawnDot(img, "lighter", PP.W / 2, PP.H / 2, PP.W / 2, PP.H / 2,
      sx, sy, sx, sy, dur || 260, { a0: alpha || 0.3 });
  }

  // 浮かび上がる数字/文言。輪郭付き + 出現ポップ。
  // Text 実体はプールで使い回す: 旧実装は呼び出しごとに Text+Shadow を新規生成し、
  // 都度サイズの cache canvas を確保していた(スコア連鎖中は毎フレーム数個)。
  // 器を最長文言が入る固定領域で一度だけ確保し、以後は text/font/color を
  // 書いて updateCache するだけにする(hud.js cacheHudText と同じ「器は使い回す」
  // 発想。canvas の作り捨ては GC 圧に加え、WebGL ではテクスチャの生成・破棄になる)。
  // ポップで 1.12 倍まで拡大されるので、少し高い解像度(1.25)で焼いてボケを防ぐ
  var floatFree = [];
  function floatText(str, x, y, color, size) {
    var fx = PP.layers.fx;
    var t = floatFree.pop();
    if (!t) {
      t = new createjs.Text("", "", "#fff");
      t.textAlign = "center"; t.textBaseline = "middle";
      t.shadow = new createjs.Shadow("rgba(0,0,0,0.85)", 0, 2, 4);
      t._ppCW = 0; t._ppCH = 0;   // いま確保している cache 領域(下の段階サイズ)
    }
    t.text = str;
    t.color = color;
    t.font = "700 " + (size || 18) + 'px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif';
    // cache 領域は文言の実寸に合わせる(64px 刻みの段階サイズ)。以前は最長文言
    // 用の 480×84(解像度 1.25 で 600×105=約 250KB)を固定で使っていたが、
    // 大半は "+120" 程度の短い数字で、WebGL では updateCache のたびにその全面積を
    // テクスチャとして送り直す。10 連鎖で同じフレームに 10〜20 回呼ばれるので
    // 1 フレーム 2.5〜5MB の転送=連鎖の瞬間に必ずカクつく原因だった。
    // 同じ段階サイズなら updateCache(再確保なし)、違うときだけ cache し直す
    var mw = t.getMeasuredWidth() + 28, mh = (size || 18) * 1.5 + 14;
    var cw = Math.min(480, Math.ceil(mw / 64) * 64);
    var ch = Math.min(84, Math.ceil(mh / 16) * 16);
    if (cw !== t._ppCW || ch !== t._ppCH || !t.cacheCanvas) {
      t._ppCW = cw; t._ppCH = ch;
      t.cache(-cw / 2, -ch / 2, cw, ch, 1.25);
    } else {
      t.updateCache();
    }
    t.x = x; t.y = y;
    t.alpha = 1;
    t.scaleX = t.scaleY = 0.4;
    fx.addChild(t);
    createjs.Tween.get(t, { override: true })   // 再利用時: 前回の Tween を確実に殺す
      .to({ scaleX: 1.12, scaleY: 1.12 }, 130, createjs.Ease.backOut)
      .to({ scaleX: 1, scaleY: 1 }, 90);
    createjs.Tween.get(t)
      .to({ y: y - 42, alpha: 0 }, 960, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(t); floatFree.push(t); });
  }

  // ---------- 画面の揺れ ----------
  var SHAKE_LAYERS = ["path", "railFlow", "bridgeUnder", "ballUnder", "bridge", "ballOver",
    "barrel", "shot", "item", "fx", "cannon"];
  var shakeRefs = null;   // レイヤー参照は初回に解決して使い回す(毎フレームの名前引き回避)
  var shakePow = 0, shakeT = 0, shakeDur = 0;

  function resolveShakeRefs() {
    shakeRefs = [];
    for (var i = 0; i < SHAKE_LAYERS.length; i++) {
      var L = PP.layers[SHAKE_LAYERS[i]];
      if (L) shakeRefs.push(L);
    }
    return shakeRefs;
  }

  // TODO【課題4】画面の揺れ。power=揺れ幅(px)、dur=揺れる時間(秒)。
  // 呼び出し側(例: chain.js の爆発 shake(80, 2))の数値を変えると迫力が変わる
  function shake(power, dur) {
    if (power >= shakePow || shakeT <= 0) {
      shakePow = power; shakeDur = dur || 0.35; shakeT = shakeDur;
    }
  }
  function updateShake(dt) {
    if (shakeT <= 0) return;
    shakeT -= dt;
    var k = Math.max(0, shakeT / shakeDur);
    var amp = shakePow * k * k;
    var ox = (Math.random() * 2 - 1) * amp;
    var oy = (Math.random() * 2 - 1) * amp;
    if (shakeT <= 0) { ox = 0; oy = 0; shakePow = 0; }
    var refs = shakeRefs || resolveShakeRefs();
    for (var i = 0; i < refs.length; i++) { refs[i].x = ox; refs[i].y = oy; }
  }
  function resetShake() {
    shakePow = 0; shakeT = 0;
    var refs = shakeRefs || resolveShakeRefs();
    for (var i = 0; i < refs.length; i++) { refs[i].x = 0; refs[i].y = 0; }
  }

  // その場に灯って消えるグロー1粒(イントロ彗星の尾など)。プール経由なので
  // 呼び捨てでよい。size は表示半径 px、durMs かけて縮みながら alpha a0→0。
  // 消え方は spawnDot の quadOut(旧トレイルの k² フェードと同じ曲線)
  function glowDot(x, y, color, size, durMs, a0, shrink) {
    var s0 = size / DOT_R;
    var s1 = s0 * (shrink === undefined ? 0.5 : shrink);
    spawnDot(dotFor(color), "lighter", x, y, x, y, s0, s0, s1, s1, durMs, { a0: a0 });
  }

  PP.fx = {
    particles: particles, burst: burst, floatText: floatText,
    ring: ring, flash: flash, splash: splash, missileTrail: missileTrail,
    screenFlash: screenFlash, glowDot: glowDot,
    updateParticles: updateParticles, particleLoad: particleLoad,
    shake: shake, updateShake: updateShake, resetShake: resetShake
  };
})();
