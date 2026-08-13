/* =========================================================
 * editor.js — コースを画面上で描くビジュアルエディタ
 *
 * course-api.js の上に乗る薄い UI。編集モードを切り替えて
 * コース(=制御点の並び)を作る:
 *   ✏ 追加・移動 … 空き地クリックで点を足し、ドラッグで動かす
 *   ➕ 挿入       … レール線の途中をクリックして点を割り込ませる
 *   🧹 消しゴム   … 点をクリックして1つずつ消す(右クリック削除も併存)
 *   🚇 トンネル   … レール上を2クリックして「隠れる区間」を作る(区間内クリックで削除)
 *   🌉 橋(raised)… レール上を2クリックして「このレーンが上=橋になる区間」を作る
 *
 * マルチレーン: ＋レーンで N 本まで道を増やせる。◀ ▶ / [ ] で編集対象レーンを
 *   切り替える。編集中でないレーンは細い線でうっすら表示。トンネル/橋は
 *   レーンごとに保持し、course-api の lanes:[{ctrl,tunnels?,raised?}] へ書き出す。
 *
 * Ctrl-Z / Ctrl-Y で取消・やり直し。? キーでショートカット一覧。
 * 下の HTML パネルで「直角/立体交差の切替・試遊・保存・JSON 入出力・
 * URL 共有」ができる。
 *
 * 開き方: 画面下の「🛠 コース作成」ボタン、キーの E、または
 *         index.html?editcourse=1
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var HISTORY_MAX = 50;     // 取消の履歴の上限
  var INSERT_HIT = 40;      // 挿入で線に吸い付く最大距離(px)
  var MARGIN = 170;         // 編集ビューで画面の外側に見せる「のりしろ」(world px)
  var GRID = PP.D;          // グリッド間隔=タイル(玉の直径)。縦横ともこの間隔で引く
  // 編集中に隠すゲームのレイヤー(閉じたら元の表示に戻す)
  // railFlow(溝の光)・bridgeUnder(橋のアーチ・橋脚)・tunnel(覆い)も
  // ゲーム側の作画なので隠す。残すとエディタのプレビューの上に重なって見える。
  var HIDE_LAYERS = ["path", "railFlow", "bridgeUnder", "ballUnder", "bridge",
    "ballOver", "tunnel", "barrel",
    "shot", "item", "fx", "cannon", "crisis", "doom", "hud"];

  var ED = {
    active: false,
    // マルチレーン: lanes が真実のデータ。各レーンは {ctrl, tunnels, raised}。
    //   tunnels/raised は course-api と同形の {from,to}(レール全長比 0..1)の配列。
    // ED.ctrl は「編集中レーン(laneIdx)の ctrl への参照」。既存のハンドル・挿入・
    //   消しゴム・角丸処理は ED.ctrl をそのまま触るので、参照を保つ限り無改修で動く。
    lanes: [{ ctrl: [], tunnels: [], raised: [] }],
    laneIdx: 0,        // 編集中レーンの番号
    ctrl: [],          // = lanes[laneIdx].ctrl(commitCtrl で常に同期)
    spanStart: null,   // トンネル/橋モードの1クリック目の全長比(2クリック目で確定)
    sharp: false,
    corner: 24,
    overpass: false,
    snap: false,
    mode: "edit",      // "edit"(追加・移動) | "insert"(挿入) | "erase"(消しゴム)
                       //   | "tunnel"(トンネル区間) | "bridge"(橋=raised 区間)
    sel: -1,           // 選択中の制御点(-1=なし)
    history: [],       // 取消スタック(snapshot の配列)
    redo: [],          // やり直しスタック
    container: null,   // stage 上の作業レイヤー(スケールしない。backdrop と world を持つ)
    backdrop: null,    // 盤面を暗く覆う板(クリックで点追加を受ける)
    world: null,       // 実座標のレイヤー(縮小表示して画面外の「のりしろ」も映す)
    camScale: 1, camX: 0, camY: 0,  // world の縮尺とオフセット(座標変換に使う)
    baseScale: 1,      // 全体表示(初期)の縮尺。拡大縮小の基準
    guideX: null, guideY: null,     // 整列ガイド(スマートガイド)の world 座標。null=非表示
    eqX: null, eqY: null,           // 等間隔ガイド {a,b,mid}(左右/上下の中間に吸着中)。null=非表示
    layerVis: null,    // 隠したゲームレイヤーの元の表示状態
    frameLabel: null,  // 「画面のふち」の説明ラベル(world 内・rebuild で消さない)
    preview: null,     // レール線・マーカー・グリッド・選択枠の Shape
    panel: null,       // HTML の操作パネル
    status: null,      // 状態表示の DOM
    help: null,        // ショートカット一覧のオーバーレイ DOM
    modeBtns: [],      // モード切替ボタン(色更新用)
    paintModes: null,  // モードボタンの色を塗り直す関数
    laneLabel: null,   // 「レーン i/n」表示の DOM(切替で書き換え)
    _preDrag: null,    // ドラッグ開始時の状態(最初の移動で history へ積む)
    _pushed: false,
    _prevMuted: false, // エディタを開く前の消音状態(閉じたら戻す)
    panelPos: null,    // パネルの表示位置 {left, top}(ドラッグで更新・再構築でも保持)
    collapsed: false   // パネルを折りたたんでいるか(ヘッダだけ表示)
  };

  // グリッド線は板(タイル)の切れ目=境界に来る(0, GRID, 2*GRID, …)。スナップも境界へ。
  function snapToGrid(v) { return Math.round(v / GRID) * GRID; }
  function snap(v) { return ED.snap ? snapToGrid(v) : Math.round(v); }

  // コースデータの複製は API と同じ実装を使う。
  var courseUtils = PP.courseUtils;
  var copyPt = courseUtils.copyPoint;
  var copyCtrl = courseUtils.copyPoints;

  // ---------- レーン(マルチレーン)ヘルパ ----------
  // 区間指定({from,to} の配列)の複製。
  var copySpans = courseUtils.copySpans;
  // レーン1本の深いコピー(ctrl は角丸半径ごと、tunnels/raised は {from,to} を複製)。
  var copyLane = courseUtils.copyEditableLane;
  function copyLanes(a) { return a.map(copyLane); }
  function newLane() { return { ctrl: [], tunnels: [], raised: [] }; }
  // 入力(Course.lanes 等)から ED.lanes を作る。欠けた配列は空で補う。
  function lanesFrom(list) {
    return (list && list.length ? list : [newLane()]).map(copyLane);
  }
  // 編集中レーン。
  function activeLane() { return ED.lanes[ED.laneIdx]; }
  // ED.ctrl(編集中レーンの ctrl 参照)を lanes へ書き戻して整合させる。
  // ED.lanes を読む前(描画・シリアライズ)に必ず呼ぶ。
  function commitCtrl() { if (activeLane()) activeLane().ctrl = ED.ctrl; }
  // 編集中レーンを i に切り替える(現レーンを確定 → ED.ctrl を差し替え)。
  function selectLane(i) {
    commitCtrl();
    ED.laneIdx = Math.max(0, Math.min(ED.lanes.length - 1, i));
    ED.ctrl = activeLane().ctrl;
    ED.sel = -1; ED.spanStart = null;
  }

  // スマートガイド(PowerPoint 風)。ドラッグ中の点(idx)を、
  //  (1) 他の点(同一レーン + 他レーンすべて)と X または Y が近ければその値へ吸着
  //      (= 水平/垂直がピタッと揃う)。
  //  (2) 揃わない軸では、両隣の点のちょうど中間(= 左右/上下 等間隔)にも吸着。
  // 返り値: 吸着後の x/y と、ガイド描画用の gx/gy(整列線)・eqX/eqY(等間隔マーカー)。
  function alignSnap(idx, x, y) {
    if (ED.snap) { x = snapToGrid(x); y = snapToGrid(y); }
    var tol = 8 / ED.camScale;   // 画面上で約8px以内なら吸着(拡大率で変わらない)
    // 自分以外の全点の座標を集める(他レーンも対象)。
    var xs = [], ys = [];
    for (var li = 0; li < ED.lanes.length; li++) {
      var pts = (li === ED.laneIdx) ? ED.ctrl : ED.lanes[li].ctrl;
      for (var i = 0; i < pts.length; i++) {
        if (li === ED.laneIdx && i === idx) continue;   // 自分自身は除く
        xs.push(pts[i][0]); ys.push(pts[i][1]);
      }
    }
    // (1) 整列吸着: 最も近い同値の座標へ。
    var gx = null, gy = null, bx = tol, by = tol;
    for (i = 0; i < xs.length; i++) { var dx = Math.abs(x - xs[i]); if (dx < bx) { bx = dx; gx = xs[i]; } }
    for (i = 0; i < ys.length; i++) { var dy = Math.abs(y - ys[i]); if (dy < by) { by = dy; gy = ys[i]; } }
    if (gx !== null) x = gx;
    if (gy !== null) y = gy;
    // (2) 等間隔吸着: 整列していない軸だけ、両隣の中間点に近ければそこへ。
    var eqX = (gx === null) ? midpointSnap(x, xs, tol) : null;
    var eqY = (gy === null) ? midpointSnap(y, ys, tol) : null;
    if (eqX) x = eqX.mid;
    if (eqY) y = eqY.mid;
    return { x: Math.round(x), y: Math.round(y), gx: gx, gy: gy, eqX: eqX, eqY: eqY };
  }
  // 値 v をまたぐ最も近い下側 a・上側 b を探し、その中間 (a+b)/2 が v から
  // tol 以内なら {a, b, mid} を返す(= a と b の等間隔)。無ければ null。
  function midpointSnap(v, vals, tol) {
    var a = null, b = null;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] < v - 0.5) { if (a === null || vals[i] > a) a = vals[i]; }
      else if (vals[i] > v + 0.5) { if (b === null || vals[i] < b) b = vals[i]; }
    }
    if (a === null || b === null) return null;
    var mid = (a + b) / 2;
    return (Math.abs(v - mid) <= tol) ? { a: a, b: b, mid: mid } : null;
  }

  // 現在の作業内容を Course(course-api)へ。全レーン + トンネル/橋を渡す。
  function currentCourse() {
    commitCtrl();
    return PP.courseAPI.create({
      name: "エディタのコース", sharp: ED.sharp, corner: ED.corner,
      overpass: ED.overpass, lanes: copyLanes(ED.lanes)
    });
  }

  // ---------- 取消・やり直し ----------
  // 変更を加える「直前」に pushHistory() を呼ぶと、その手前の状態が積まれる。
  function snapshot() {
    commitCtrl();   // ED.ctrl の最新を lanes に反映してから丸ごと保存
    return {
      lanes: copyLanes(ED.lanes), laneIdx: ED.laneIdx,
      sharp: ED.sharp, corner: ED.corner, overpass: ED.overpass, sel: ED.sel
    };
  }
  function restore(s) {
    // 旧形式(ctrl だけ)の履歴も一応受ける
    ED.lanes = s.lanes ? copyLanes(s.lanes) : [{ ctrl: copyCtrl(s.ctrl || []), tunnels: [], raised: [] }];
    ED.laneIdx = Math.max(0, Math.min(ED.lanes.length - 1, s.laneIdx || 0));
    ED.ctrl = activeLane().ctrl;
    ED.spanStart = null;
    ED.sharp = s.sharp; ED.corner = s.corner; ED.overpass = s.overpass;
    ED.sel = (typeof s.sel === "number" && s.sel < ED.ctrl.length) ? s.sel : -1;
  }
  function pushSnapshot(s) {
    ED.history.push(s);
    if (ED.history.length > HISTORY_MAX) ED.history.shift();
    ED.redo.length = 0;   // 新しい操作をしたらやり直しは無効
  }
  function pushHistory() { pushSnapshot(snapshot()); }
  function undo() {
    if (!ED.history.length) return;
    ED.redo.push(snapshot());
    restore(ED.history.pop());
    rebuildHandles(); updateStatus(); refreshToggles();
  }
  function redo() {
    if (!ED.redo.length) return;
    ED.history.push(snapshot());
    restore(ED.redo.pop());
    rebuildHandles(); updateStatus(); refreshToggles();
  }

  // ---------- 描画 ----------
  // グリッド・レール線・洞窟/樽マーカー・遊べる領域の枠・選択枠を preview へ描く
  function redrawPreview() {
    var g = ED.preview.graphics.clear();

    // 画面(0..W,0..H)の内側を少し明るく、外側は「画面外(のりしろ)」として暗いまま。
    // 内側を塗ることで、どこがゲーム画面に映る範囲かひと目で分かる。
    g.beginFill("rgba(20,32,48,0.55)").drawRect(0, 0, PP.W, PP.H).endFill();

    if (ED.snap) drawGrid(g);

    // 画面のふち。この外側は画面外=洞窟(始点)を置くと玉がここから流れ込む。
    g.setStrokeStyle(2).beginStroke("rgba(120,180,255,0.85)")
      .drawRect(0, 0, PP.W, PP.H).endStroke();

    // 遊べる領域の目安枠
    g.setStrokeStyle(1).beginStroke("rgba(240,192,64,0.25)")
      .drawRect(40, 50, PP.W - 80, PP.CANNON_Y - 52 - 50).endStroke();

    // 3分割ガイド(三分割法)。左右・上下を3等分する目安線。
    g.setStrokeStyle(1 / ED.camScale).beginStroke("rgba(160,255,200,0.26)");
    g.moveTo(PP.W / 3, 0); g.lineTo(PP.W / 3, PP.H);
    g.moveTo(PP.W * 2 / 3, 0); g.lineTo(PP.W * 2 / 3, PP.H);
    g.moveTo(0, PP.H / 3); g.lineTo(PP.W, PP.H / 3);
    g.moveTo(0, PP.H * 2 / 3); g.lineTo(PP.W, PP.H * 2 / 3);
    g.endStroke();

    // 画面中心の十字線(縦=X の中央 / 横=Y の中央)。左右・上下対称に置く目安。
    // 線幅は縮尺で割り、拡大率によらず画面上でほぼ一定の細さにする。
    g.setStrokeStyle(1.5 / ED.camScale).beginStroke("rgba(120,210,255,0.5)");
    g.moveTo(PP.W / 2, 0); g.lineTo(PP.W / 2, PP.H);
    g.moveTo(0, PP.H / 2); g.lineTo(PP.W, PP.H / 2);
    g.endStroke();

    // レーンを描く。編集中でない(他の)レーンは細い薄線でうっすら見せ、
    // 編集中レーンは従来どおり太いレール+矢印+洞窟/樽+トンネル/橋の帯で描く。
    commitCtrl();
    var course = currentCourse().toCourse();
    for (var li = 0; li < ED.lanes.length; li++) {
      if (ED.lanes[li].ctrl.length < 2) continue;
      var active = li === ED.laneIdx;
      var pl = PP.rail.measure(course, li);
      if (!active) {
        // 他レーン: 細い薄線 + 始点/終点の小さな目印だけ
        g.setStrokeStyle(2 / ED.camScale).beginStroke("rgba(160,190,220,0.35)");
        g.moveTo(pl.xs[0], pl.ys[0]);
        for (var j = 1; j < pl.xs.length; j++) g.lineTo(pl.xs[j], pl.ys[j]);
        g.endStroke();
        drawSpans(g, pl, ED.lanes[li].tunnels, "rgba(20,14,7,0.35)");
        drawSpans(g, pl, ED.lanes[li].raised, "rgba(120,180,255,0.28)");
        // 始点の小さな緑丸。塗りは必ず endFill で閉じる。閉じないと EaselJS では
        // この緑塗りが次に描くレーンのレール折れ線へ流れ込み、レールが緑に塗られる。
        g.beginFill("rgba(77,220,85,0.5)").drawCircle(pl.xs[0], pl.ys[0], PP.R * 0.6).endFill();
        continue;
      }
      // 編集中レーンのレール本体
      g.setStrokeStyle(PP.R * 2, "round", "round").beginStroke("rgba(0,0,0,0.35)");
      g.moveTo(pl.xs[0], pl.ys[0]);
      for (var i = 1; i < pl.xs.length; i++) g.lineTo(pl.xs[i], pl.ys[i]);
      g.endStroke();
      g.setStrokeStyle(2).beginStroke("rgba(240,230,200,0.7)");
      g.moveTo(pl.xs[0], pl.ys[0]);
      for (i = 1; i < pl.xs.length; i++) g.lineTo(pl.xs[i], pl.ys[i]);
      g.endStroke();
      // トンネル(暗い帯)と橋 raised(明るい青の帯)を重ねる
      drawSpans(g, pl, activeLane().tunnels, "rgba(20,14,7,0.62)");
      drawSpans(g, pl, activeLane().raised, "rgba(120,180,255,0.55)");
      // 2クリック中の1点目マーカー
      if (ED.spanStart !== null) {
        var sp0 = pl.xs.length ? posOnRail(pl, ED.spanStart) : null;
        if (sp0) {
          g.setStrokeStyle(2.5).beginStroke("#ffd24a").drawCircle(sp0.x, sp0.y, PP.R + 3).endStroke();
        }
      }
      // 進行方向の矢印(数個)
      for (var f = 0.15; f < 1; f += 0.35) {
        var d = pl.length * f, a = idxAt(pl.cum, d);
        var dx = pl.xs[a + 1] - pl.xs[a], dy = pl.ys[a + 1] - pl.ys[a];
        var L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        var x = pl.xs[a], y = pl.ys[a];
        g.beginFill("#f0c040").moveTo(x + dx * 10, y + dy * 10)
          .lineTo(x - dy * 6, y + dx * 6).lineTo(x + dy * 6, y - dx * 6).closePath();
      }
      // 洞窟(始点)と樽(終点)
      var s = ED.ctrl[0], e2 = ED.ctrl[ED.ctrl.length - 1];
      g.beginFill("rgba(0,0,0,0.7)").drawCircle(s[0], s[1], PP.R + 6).endFill();
      g.setStrokeStyle(3).beginStroke("#5c3d1f").drawCircle(s[0], s[1], PP.R + 6).endStroke();
      // 樽(終点)。塗りを閉じて、後続レーンのレール線へ茶色が流れ込むのを防ぐ。
      g.beginFill("rgba(150,90,40,0.9)").drawCircle(e2[0], e2[1], PP.R + 4).endFill();
    }

    // 選択中の点を黄色い輪で強調(ハンドルより一回り大きく描く)
    if (ED.sel >= 0 && ED.sel < ED.ctrl.length) {
      var sp = ED.ctrl[ED.sel];
      g.setStrokeStyle(3).beginStroke("#ffd24a").drawCircle(sp[0], sp[1], 15).endStroke();
    }

    // スマートガイド(他の点と X/Y が揃ったときのピンクの整列線)。
    // 線幅は縮尺で割って、拡大率によらず画面上でほぼ一定の細さにする。
    var gw = 1.5 / ED.camScale;
    if (ED.guideX !== null) {
      g.setStrokeStyle(gw).beginStroke("rgba(255,70,190,0.95)");
      g.moveTo(ED.guideX, -MARGIN); g.lineTo(ED.guideX, PP.H + MARGIN); g.endStroke();
    }
    if (ED.guideY !== null) {
      g.setStrokeStyle(gw).beginStroke("rgba(255,70,190,0.95)");
      g.moveTo(-MARGIN, ED.guideY); g.lineTo(PP.W + MARGIN, ED.guideY); g.endStroke();
    }
    // 等間隔ガイド(左右/上下の中間に吸着中)。両側の隙間が等しいことを、
    // ドラッグ中の点を挟む2つの区間へ水色の二重矢印(端キャップ付き線)で示す。
    if (ED.sel >= 0 && ED.sel < ED.ctrl.length) {
      var q = ED.ctrl[ED.sel];
      if (ED.eqX) { drawGapMark(g, ED.eqX.a, q[1], q[0], q[1]); drawGapMark(g, q[0], q[1], ED.eqX.b, q[1]); }
      if (ED.eqY) { drawGapMark(g, q[0], ED.eqY.a, q[0], q[1]); drawGapMark(g, q[0], q[1], q[0], ED.eqY.b); }
    }
  }
  // 等間隔を示す1区間の目印: (x1,y1)-(x2,y2) を結ぶ水色の線と、両端の短い直交キャップ。
  function drawGapMark(g, x1, y1, x2, y2) {
    var gw = 1.5 / ED.camScale, cap = 6 / ED.camScale;
    var dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    var nx = -dy / L * cap, ny = dx / L * cap;   // 線に直交するキャップ方向
    g.setStrokeStyle(gw).beginStroke("rgba(90,230,255,0.95)");
    g.moveTo(x1, y1); g.lineTo(x2, y2);
    g.moveTo(x1 - nx, y1 - ny); g.lineTo(x1 + nx, y1 + ny);
    g.moveTo(x2 - nx, y2 - ny); g.lineTo(x2 + nx, y2 + ny);
    g.endStroke();
  }
  // タイル(玉の直径)間隔の方眼。縦横ともに GRID 間隔で引く。
  // 線幅は縮尺で割り、拡大率によらず画面上でほぼ一定の細さにする。
  function drawGrid(g) {
    g.setStrokeStyle(1 / ED.camScale).beginStroke("rgba(255,255,255,0.08)");
    for (var x = 0; x <= PP.W; x += GRID) { g.moveTo(x, 0); g.lineTo(x, PP.H); }
    for (var y = 0; y <= PP.H; y += GRID) { g.moveTo(0, y); g.lineTo(PP.W, y); }
    g.endStroke();
  }
  function idxAt(cum, d) {
    var lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) { var m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    return lo;
  }
  // measure 済みの折れ線 pl 上の全長比 f(0..1)→ 座標 {x,y}。
  function posOnRail(pl, f) {
    var d = Math.max(0, Math.min(1, f)) * pl.length;
    var a = idxAt(pl.cum, d), seg = pl.cum[a + 1] - pl.cum[a] || 1;
    var t = (d - pl.cum[a]) / seg;
    return { x: pl.xs[a] + (pl.xs[a + 1] - pl.xs[a]) * t,
             y: pl.ys[a] + (pl.ys[a + 1] - pl.ys[a]) * t };
  }
  // 区間(tunnels/raised の {from,to} 配列)を、レール上に太い帯として描く。
  function drawSpans(g, pl, spans, color) {
    if (!spans || !spans.length) return;
    for (var i = 0; i < spans.length; i++) {
      var lo = Math.max(0, Math.min(1, spans[i].from)) * pl.length;
      var hi = Math.max(0, Math.min(1, spans[i].to)) * pl.length;
      if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
      var a = idxAt(pl.cum, lo), b = idxAt(pl.cum, hi);
      var p0 = posOnRail(pl, lo / pl.length);
      g.setStrokeStyle(PP.R * 2 + 4, "round", "round").beginStroke(color);
      g.moveTo(p0.x, p0.y);
      for (var k = a + 1; k <= b; k++) g.lineTo(pl.xs[k], pl.ys[k]);
      var p1 = posOnRail(pl, hi / pl.length);
      g.lineTo(p1.x, p1.y);
      g.endStroke();
    }
  }

  // 制御点のハンドル(番号つき)。挙動は現在モードで変わる:
  //   edit  … クリックで選択、ドラッグで移動
  //   erase … クリックでその点を削除
  //   insert… ハンドル上では何もしない(線側で挿入する)
  // ドラッグ中は preview だけ更新し、離した時に全体を組み直す
  // (ドラッグ中の shape を消さないため。選択枠は preview に描くので rebuild 不要)。
  function rebuildHandles() {
    // preview とラベル以外(=前回のハンドル)を world から消す
    for (var i = ED.world.numChildren - 1; i >= 0; i--) {
      var ch = ED.world.getChildAt(i);
      if (ch !== ED.preview && ch !== ED.frameLabel) ED.world.removeChildAt(i);
    }
    var eraseMode = ED.mode === "erase";
    // トンネル/橋モードはレール上のクリックで区間を作るので、点ハンドルは
    // クリックを奪わないように非活性にし、下の backdrop へ通す。
    var spanMode = ED.mode === "tunnel" || ED.mode === "bridge";
    ED.preview.cursor = (ED.mode === "insert" || spanMode) ? "cell" : eraseMode ? "default" : "crosshair";
    ED.ctrl.forEach(function (p, idx) {
      var h = new createjs.Shape();
      var first = idx === 0, last = idx === ED.ctrl.length - 1;
      var col = first ? "#4ddc55" : last ? "#ff4a34" : "#4a9bff";
      // 直角(半径0)の角は四角、それ以外(角丸・端点)は丸で表示して区別する
      if (isHardCorner(idx)) {
        h.graphics.beginFill(col).setStrokeStyle(2).beginStroke("#fff")
          .drawRect(-8, -8, 16, 16).endStroke();
      } else {
        h.graphics.beginFill(col).setStrokeStyle(2).beginStroke("#fff")
          .drawCircle(0, 0, 9).endStroke();
      }
      h.x = p[0]; h.y = p[1];
      h.mouseEnabled = !spanMode;
      h.cursor = eraseMode ? "not-allowed" : "pointer";
      h.on("mousedown", function (ev) {
        if (ev.nativeEvent && ev.nativeEvent.button !== 0) return;   // 左ボタンのみ
        if (ED.mode === "erase") {
          // クリックした点を1つ消す
          pushHistory();
          ED.ctrl.splice(idx, 1);
          ED.sel = -1;
          rebuildHandles(); updateStatus();
          return;
        }
        if (ED.mode === "insert") return;   // 挿入は線の上で(ハンドルは素通り)
        // edit: 選択してドラッグ開始に備える。実際に動いたら履歴へ積む。
        ED.sel = idx;
        ED._preDrag = snapshot();
        ED._pushed = false;
        redrawPreview();   // rebuild するとドラッグ対象の shape が消えるので描画だけ更新
        updateStatus();    // 選択した角の情報(直角/角丸)を反映
      });
      h.on("pressmove", function (ev) {
        if (ED.mode !== "edit") return;
        if (!ED._pushed) { pushSnapshot(ED._preDrag); ED._pushed = true; }
        var a = alignSnap(idx, toWorldX(ev.stageX), toWorldY(ev.stageY));
        p[0] = a.x; p[1] = a.y;
        ED.guideX = a.gx; ED.guideY = a.gy;   // 整列ガイド(揃った線)の表示位置
        ED.eqX = a.eqX; ED.eqY = a.eqY;       // 等間隔ガイド(中間吸着)の表示情報
        h.x = p[0]; h.y = p[1];
        redrawPreview();
      });
      h.on("pressup", function () {
        if (ED.mode !== "edit") return;
        ED.guideX = ED.guideY = null;   // ガイドを消す
        ED.eqX = ED.eqY = null;
        rebuildHandles(); updateStatus();
      });
      ED.world.addChild(h);

      var t = new createjs.Text(String(idx), "bold 11px sans-serif", "#fff");
      t.textAlign = "center"; t.textBaseline = "middle";
      t.x = p[0]; t.y = p[1]; t.mouseEnabled = false;
      ED.world.addChild(t);
    });
    redrawPreview();
  }

  // ---------- 入力(キャンバス) ----------
  // 背景(=preview)を叩いたときの挙動。モードで分岐する。
  function onCanvasDown(ev) {
    // 中ボタン(パン)・右ボタン(削除)では点を足さない。左ボタンのみ。
    if (ev.nativeEvent && ev.nativeEvent.button !== 0) return;
    if (ED.mode === "erase") return;     // 消しゴムは点の上でのみ働く
    var wx = toWorldX(ev.stageX), wy = toWorldY(ev.stageY);
    // トンネル/橋モードはレール上の区間編集(点は足さない。履歴は spanClick 内で積む)
    if (ED.mode === "tunnel") { spanClick(wx, wy, "tunnels"); return; }
    if (ED.mode === "bridge") { spanClick(wx, wy, "raised"); return; }
    pushHistory();
    if (ED.mode === "insert") insertOnSegment(wx, wy);
    else { ED.ctrl.push([snap(wx), snap(wy)]); ED.sel = ED.ctrl.length - 1; }
    rebuildHandles();
    updateStatus();
  }
  // クリック点に最も近い「連続する制御点の線分」を探し、その間へ点を割り込ませる。
  // 線から遠ければ(または点が足りなければ)末尾に足す。
  function insertOnSegment(sx, sy) {
    if (ED.ctrl.length < 2) {
      ED.ctrl.push([snap(sx), snap(sy)]); ED.sel = ED.ctrl.length - 1; return;
    }
    var best = -1, bd = Infinity;
    for (var i = 0; i < ED.ctrl.length - 1; i++) {
      var dd = pointSegDist2(sx, sy, ED.ctrl[i], ED.ctrl[i + 1]);
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best >= 0 && bd <= INSERT_HIT * INSERT_HIT) {
      ED.ctrl.splice(best + 1, 0, [snap(sx), snap(sy)]);
      ED.sel = best + 1;
    } else {
      ED.ctrl.push([snap(sx), snap(sy)]);   // 線から遠い→末尾へ
      ED.sel = ED.ctrl.length - 1;
    }
  }
  // 点(px,py)と線分 a-b の距離の2乗
  function pointSegDist2(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var x = a[0] + dx * t, y = a[1] + dy * t;
    return (px - x) * (px - x) + (py - y) * (py - y);
  }

  // クリック点(world 座標)を、編集中レーンのレール上の「全長比 0..1」へ変換する。
  // レールの折れ線(xs/ys/cum)に対し最寄りセグメントへ射影して弧長を求める。
  // 制御点が足りずレールが引けない/遠すぎる場合は null。
  function railFractionAt(wx, wy) {
    commitCtrl();
    if (activeLane().ctrl.length < 2) return null;   // レールが引けない
    var pl = PP.rail.measure(currentCourse().toCourse(), ED.laneIdx);
    if (!pl.length || pl.xs.length < 2) return null;
    var best = -1, bd = Infinity, bt = 0;
    for (var i = 0; i < pl.xs.length - 1; i++) {
      var ax = pl.xs[i], ay = pl.ys[i], bx = pl.xs[i + 1], by = pl.ys[i + 1];
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      var t = l2 ? ((wx - ax) * dx + (wy - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var x = ax + dx * t, y = ay + dy * t;
      var dd = (wx - x) * (wx - x) + (wy - y) * (wy - y);
      if (dd < bd) { bd = dd; best = i; bt = t; }
    }
    if (best < 0) return null;
    var arc = pl.cum[best] + bt * (pl.cum[best + 1] - pl.cum[best]);
    return Math.max(0, Math.min(1, arc / pl.length));
  }

  // トンネル/橋モードでレールをクリックしたときの区間編集。
  // key は "tunnels" か "raised"。既存区間の内側を叩けば削除、そうでなければ
  // 1クリック目=始点、2クリック目=終点として {from,to} を追加する。
  function spanClick(wx, wy, key) {
    var f = railFractionAt(wx, wy);
    if (f === null) return;
    var arr = activeLane()[key] || (activeLane()[key] = []);
    // 既存区間の内側をクリック → その区間を削除
    for (var i = 0; i < arr.length; i++) {
      if (f >= arr[i].from && f <= arr[i].to) {
        pushHistory(); arr.splice(i, 1); ED.spanStart = null;
        redrawPreview(); updateStatus(); return;
      }
    }
    if (ED.spanStart === null) {
      ED.spanStart = f;                      // 1点目(2点目のクリック待ち)
      redrawPreview(); updateStatus(); return;
    }
    pushHistory();
    arr.push({ from: Math.min(ED.spanStart, f), to: Math.max(ED.spanStart, f) });
    ED.spanStart = null;
    redrawPreview(); updateStatus();
  }
  // 選択中の点(なければ末尾)を削除する(Delete キー用)
  function deleteSelectedOrLast() {
    if (!ED.ctrl.length) return;
    pushHistory();
    if (ED.sel >= 0 && ED.sel < ED.ctrl.length) { ED.ctrl.splice(ED.sel, 1); ED.sel = -1; }
    else ED.ctrl.pop();
    rebuildHandles(); updateStatus();
  }
  // 選択中の点が「角」(端でない=洞窟/樽でない中間点)なら its index、そうでなければ -1。
  // 角丸/直角は端点には意味がないので、この判定で角だけを対象にする。
  function selInterior() {
    return (ED.sel > 0 && ED.sel < ED.ctrl.length - 1) ? ED.sel : -1;
  }
  // 角丸半径を増減する。角が選択されていればその角だけ、なければコース既定を動かす。
  function cornerDelta(d) {
    pushHistory();
    var si = selInterior();
    if (si >= 0) {
      var p = ED.ctrl[si];
      var cur = (p.length > 2) ? p[2] : ED.corner;
      ED.ctrl[si] = [p[0], p[1], Math.max(0, cur + d)];
    } else {
      ED.corner = Math.max(0, ED.corner + d);
    }
    rebuildHandles(); updateStatus();
  }
  // その点が「角(カクッと折れる)」に指定されているか(端点は常に false)。
  // なめらかモード(R off)ではスプラインを折り、直角モード(R on)では直角(丸めなし)になる。
  function isHardCorner(idx) {
    if (idx === 0 || idx === ED.ctrl.length - 1) return false;
    var p = ED.ctrl[idx];
    return (p.length > 2) && p[2] <= 0.5;
  }
  // 選択中の点を「角(カクッ)」⇄「既定(なめらか/角丸)」で切り替える。
  // 既定に戻すときは 3要素目を外す: なめらかモードでは曲線通過、直角モードでは
  // コース既定の角丸半径になる。角にするときは 3要素目を 0 にする。
  function toggleCornerSharp() {
    var si = selInterior();
    if (si < 0) { updateStatus(); return; }
    pushHistory();
    var p = ED.ctrl[si];
    ED.ctrl[si] = isHardCorner(si) ? [p[0], p[1]] : [p[0], p[1], 0];
    rebuildHandles(); updateStatus();
  }
  // 右クリックで最寄りの点を削除(消しゴムモードでなくても使える保険)
  function onContext(e) {
    if (!ED.active) return;
    e.preventDefault();
    var rect = PP.stage.canvas.getBoundingClientRect();
    var sx = (e.clientX - rect.left) * (PP.W / rect.width);
    var sy = (e.clientY - rect.top) * (PP.H / rect.height);
    var wx = toWorldX(sx), wy = toWorldY(sy);   // 縮小表示ぶんを実座標へ戻す
    var best = -1, bd = 26 * 26;
    ED.ctrl.forEach(function (p, i) {
      var dx = p[0] - wx, dy = p[1] - wy, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best >= 0) { pushHistory(); ED.ctrl.splice(best, 1); ED.sel = -1; rebuildHandles(); updateStatus(); }
  }

  // ---------- モード ----------
  function setMode(m) {
    ED.mode = m;
    if (m !== "edit") ED.sel = -1;
    ED.spanStart = null;   // 区間の途中操作は破棄
    if (ED.paintModes) ED.paintModes();
    rebuildHandles();   // カーソル・選択枠を更新
    updateStatus();
  }

  // ---------- レーン操作 ----------
  function paintLaneLabel() {
    if (ED.laneLabel) ED.laneLabel.textContent = "レーン " + (ED.laneIdx + 1) + " / " + ED.lanes.length;
  }
  // 編集中レーンを移す(delta=±1。端で止める)。undo 対象にはしない(表示切替だけ)。
  function switchLane(delta) {
    selectLane(ED.laneIdx + delta);
    paintLaneLabel();
    rebuildHandles(); updateStatus();
  }
  // 空レーンを1本足して、それを編集対象にする。
  function addLane() {
    pushHistory();
    commitCtrl();
    ED.lanes.push(newLane());
    selectLane(ED.lanes.length - 1);
    paintLaneLabel();
    rebuildHandles(); updateStatus();
  }
  // 編集中レーンを削除(最低1本は残す)。
  function removeLane() {
    if (ED.lanes.length <= 1) { alert("レーンは最低1本必要です"); return; }
    if (!confirm("レーン " + (ED.laneIdx + 1) + " を削除します。よろしいですか?(Ctrl-Z で戻せます)")) return;
    pushHistory();
    ED.lanes.splice(ED.laneIdx, 1);
    ED.laneIdx = Math.max(0, ED.laneIdx - 1);
    ED.ctrl = activeLane().ctrl; ED.sel = -1; ED.spanStart = null;
    paintLaneLabel();
    rebuildHandles(); updateStatus();
  }

  // ---------- 状態表示 ----------
  function updateStatus() {
    if (!ED.status) return;
    var r = currentCourse().validate();
    var mode = ED.mode === "insert" ? "➕ 挿入" : ED.mode === "erase" ? "🧹 消しゴム" :
      ED.mode === "tunnel" ? "🚇 トンネル" : ED.mode === "bridge" ? "🌉 橋" : "✏ 追加・移動";
    var lane = activeLane();
    var msg = mode + "  ｜  レーン " + (ED.laneIdx + 1) + "/" + ED.lanes.length +
      "  ｜  点 " + r.points + " / 全長 " + r.length + "px" +
      "  ｜  🚇" + (lane.tunnels ? lane.tunnels.length : 0) +
      " 🌉" + (lane.raised ? lane.raised.length : 0);
    if ((ED.mode === "tunnel" || ED.mode === "bridge") && ED.spanStart !== null)
      msg += "  ｜  始点セット済み: もう一度クリックで区間確定";
    // 中間点を選択中なら、その点の曲がり方を表示(モードで呼び方が変わる)
    var si = selInterior();
    if (si >= 0) {
      if (ED.sharp) {
        var p = ED.ctrl[si], rad = (p.length > 2) ? p[2] : ED.corner;
        msg += "  ｜  角#" + si + ": " + (rad <= 0.5 ? "直角" : "角丸 r=" + Math.round(rad));
      } else {
        msg += "  ｜  点#" + si + ": " + (isHardCorner(si) ? "カクッ(角)" : "なめらか");
      }
    }
    if (r.errors.length) msg += "  ⛔ " + r.errors.join("・");
    else if (r.warnings.length) msg += "  ⚠ " + r.warnings.join("・");
    else msg += "  ✅ OK";
    ED.status.textContent = msg;
    ED.status.style.color = r.errors.length ? "#ff8a7a" : r.warnings.length ? "#f0c040" : "#8ef0d0";
  }

  // ---------- HTML パネル ----------
  function buildPanel() {
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;z-index:9999;" +
      "background:rgba(13,27,42,0.94);border:1px solid #2b4a6b;border-radius:10px;" +
      "padding:10px 12px;color:#cfe0f0;font:13px/1.5 'Meiryo',sans-serif;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:360px;";
    wrap.style.left = (ED.panelPos ? ED.panelPos.left : 10) + "px";
    wrap.style.top = (ED.panelPos ? ED.panelPos.top : 10) + "px";

    // ヘッダ(つかんでドラッグで移動 / — ボタンで折りたたみ)
    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;" +
      "cursor:move;margin-bottom:6px;-webkit-user-select:none;user-select:none";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#f0c040";
    title.textContent = "🛠 コースエディタ";
    var collapseBtn = document.createElement("button");
    collapseBtn.textContent = ED.collapsed ? "▢" : "—";
    collapseBtn.title = "折りたたみ / 展開";
    collapseBtn.style.cssText = "cursor:pointer;border:none;border-radius:5px;width:26px;height:22px;" +
      "font:14px 'Meiryo',sans-serif;color:#fff;background:#2b4a6b;margin-left:8px;flex:none";
    header.appendChild(title); header.appendChild(collapseBtn);
    makeDraggable(wrap, header);
    wrap.appendChild(header);

    // 折りたためる本体(ヘッダ以外すべて)
    var body = document.createElement("div");
    body.style.display = ED.collapsed ? "none" : "block";
    collapseBtn.onclick = function () {
      ED.collapsed = !ED.collapsed;
      body.style.display = ED.collapsed ? "none" : "block";
      collapseBtn.textContent = ED.collapsed ? "▢" : "—";
    };

    var hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;color:#8aa4be;margin-bottom:8px";
    hint.textContent = "クリックで追加 / ドラッグで移動 / 🧹で削除 / Ctrl-Z 取消 / ? ヘルプ" +
      "  ｜  青枠の外は画面外(始点をそこへ置くと玉が流れ込む)";
    body.appendChild(hint);

    // モード切替バー
    var modeRow = div();
    ED.modeBtns = [];
    function modeBtn(label, m) {
      var b = btn(label, function () { setMode(m); });
      b._mode = m;
      ED.modeBtns.push(b);
      modeRow.appendChild(b);
    }
    modeBtn("✏ 追加・移動 (1)", "edit");
    modeBtn("➕ 挿入 (2)", "insert");
    modeBtn("🧹 消しゴム (3)", "erase");
    modeBtn("🚇 トンネル (4)", "tunnel");
    modeBtn("🌉 橋 (5)", "bridge");
    ED.paintModes = function () {
      ED.modeBtns.forEach(function (b) {
        b.style.background = (b._mode === ED.mode) ? "#e08a03" : "#2b4a6b";
      });
    };
    ED.paintModes();

    // レーン操作の行(切替・追加・削除)。ラベルは切替のたびに書き換える。
    var laneRow = div();
    laneRow.appendChild(btn("◀ ([)", function () { switchLane(-1); }));
    var laneLabel = document.createElement("span");
    laneLabel.style.cssText = "align-self:center;min-width:74px;text-align:center;font-weight:bold;color:#f0c040";
    ED.laneLabel = laneLabel;
    laneRow.appendChild(laneLabel);
    laneRow.appendChild(btn("(]) ▶", function () { switchLane(1); }));
    laneRow.appendChild(btn("＋レーン (N)", addLane, "#0d6b94"));
    laneRow.appendChild(btn("🗑レーン", removeLane, "#7a1717"));
    paintLaneLabel();

    var row1 = div(), row2 = div(), row3 = div(), row4 = div();
    row1.appendChild(toggle("直角の道 (R)", function () { return ED.sharp; },
      function () { pushHistory(); ED.sharp = !ED.sharp; rebuildHandles(); updateStatus(); }));
    row1.appendChild(toggle("立体交差", function () { return ED.overpass; },
      function () { pushHistory(); ED.overpass = !ED.overpass; updateStatus(); }));
    row1.appendChild(toggle("グリッド (G)", function () { return ED.snap; },
      function () { ED.snap = !ED.snap; redrawPreview(); }));
    row1.appendChild(btn("🔍＋", function () { zoomBy(1.2); }));
    row1.appendChild(btn("🔍−", function () { zoomBy(1 / 1.2); }));
    row1.appendChild(btn("⤢ 全体 (0)", resetView));

    row2.appendChild(btn("角丸 −", function () { cornerDelta(-4); }));
    row2.appendChild(btn("角丸 +", function () { cornerDelta(4); }));
    row2.appendChild(btn("選択点 なめらか⇄角 (C)", toggleCornerSharp));
    row2.appendChild(btn("元コース1", function () { loadFrom(0); }));
    row2.appendChild(btn("元コース2", function () { loadFrom(1); }));
    row2.appendChild(btn("クリア", clearAll, "#7a1717"));

    row3.appendChild(btn("↶ 取消 (Ctrl-Z)", undo));
    row3.appendChild(btn("↷ やり直し (Ctrl-Y)", redo));

    row4.appendChild(btn("▶ 試遊 (Enter)", play, "#0d9424"));
    row4.appendChild(btn("💾 保存", save));
    row4.appendChild(btn("📂 読込", loadSlot));
    row4.appendChild(btn("⤵ JSON", exportJSON));
    row4.appendChild(btn("⤴ 取込", importJSON));
    row4.appendChild(btn("⬇ ファイル保存", downloadJSON, "#0d6b94"));
    row4.appendChild(btn("⬆ ファイル読込", importFile, "#0d6b94"));
    row4.appendChild(btn("🔗 URL", shareURL));
    row4.appendChild(btn("❔ ヘルプ", toggleHelp));
    row4.appendChild(btn("✕ 閉じる (Esc)", close, "#7a1717"));

    var status = document.createElement("div");
    status.style.cssText = "margin-top:8px;font-size:12px;min-height:18px";
    ED.status = status;

    body.appendChild(modeRow);
    body.appendChild(laneRow);
    body.appendChild(row1); body.appendChild(row2);
    body.appendChild(row3); body.appendChild(row4);
    body.appendChild(status);
    wrap.appendChild(body);
    document.body.appendChild(wrap);
    ED.panel = wrap;
  }

  // パネルをヘッダでつかんで動かせるようにする(ボタン部分はドラッグにしない)。
  // 位置は ED.panelPos に保持し、パネルの再構築後も同じ場所に出す。
  function makeDraggable(wrap, handle) {
    handle.addEventListener("mousedown", function (e) {
      if (e.target && e.target.tagName === "BUTTON") return;   // 折りたたみボタンは除外
      e.preventDefault();
      var rect = wrap.getBoundingClientRect();
      var ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      function move(ev) {
        var left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - ox));
        var top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - oy));
        wrap.style.left = left + "px";
        wrap.style.top = top + "px";
        ED.panelPos = { left: left, top: top };
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
  function div() { var d = document.createElement("div"); d.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px"; return d; }
  function btn(label, fn, bg) {
    var b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "cursor:pointer;border:none;border-radius:6px;padding:5px 9px;" +
      "font:12px 'Meiryo',sans-serif;color:#fff;background:" + (bg || "#2b4a6b") + ";";
    b.onclick = fn;
    return b;
  }
  function toggle(label, get, fn) {
    var b = btn(label, function () { fn(); paint(); });
    function paint() { b.style.background = get() ? "#e08a03" : "#2b4a6b"; }
    paint();
    return b;
  }

  // ---------- ショートカット一覧のオーバーレイ ----------
  function toggleHelp() {
    if (ED.help) { document.body.removeChild(ED.help); ED.help = null; return; }
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;right:10px;top:10px;z-index:10000;max-width:340px;" +
      "background:rgba(13,27,42,0.96);border:1px solid #2b4a6b;border-radius:10px;" +
      "padding:12px 14px;color:#cfe0f0;font:12px/1.7 'Meiryo',sans-serif;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.5);";
    d.innerHTML =
      "<div style='font-weight:bold;color:#f0c040;margin-bottom:6px'>⌨ ショートカット</div>" +
      hrow("E", "エディタ開閉 / Esc 閉じる") +
      hrow("1 / 2 / 3", "追加・移動 / 挿入 / 消しゴム") +
      hrow("4 / 5", "🚇 トンネル / 🌉 橋(上下指定)モード") +
      hrow("トンネル/橋 + レール", "レール上を2クリックで区間を作成。区間内クリックで削除") +
      hrow("[ / ] / N", "編集レーンを前へ / 次へ / ＋新しいレーンを追加") +
      hrow("クリック", "空き地に点を追加(追加モード)") +
      hrow("ドラッグ", "点を移動") +
      hrow("挿入モード + 線", "線の途中に点を割り込ませる") +
      hrow("消しゴム + 点", "その点を削除(右クリックでも可)") +
      hrow("他レーン", "細い線で表示。◀ ▶ か [ ] で編集対象を切替") +
      hrow("青枠の外", "画面外。始点を置くと玉がそこから流れ込む") +
      hrow("ドラッグ中", "他の点(他レーン含む)と X/Y が揃うとピンク線で吸着。両隣の中間(等間隔)では水色マークで吸着") +
      hrow("ホイール", "カーソル位置を中心に拡大縮小") +
      hrow("ホイール押しドラッグ", "画面を移動(パン。Miro 風)") +
      hrow("＋ / − / 0", "拡大 / 縮小 / 全体表示にリセット") +
      hrow("矢印キー", "表示を上下左右に移動(パン)") +
      hrow("点を選択 + C", "その点を なめらか⇄角(カクッ) で切替。直角モードでは 直角⇄角丸") +
      hrow("角丸 −/+", "直角モードで、選択した角の丸み半径を微調整") +
      hrow("Ctrl-Z / Ctrl-Y", "取消 / やり直し(Ctrl-Shift-Z も可)") +
      hrow("Delete / BS", "選択中の点を削除(なければ末尾)") +
      hrow("Enter", "試遊  ｜  Ctrl-S 保存") +
      hrow("⬇ ファイル保存 / ⬆ ファイル読込", "コースを .json でPCに保存 / .json ファイルを開いて読込") +
      hrow("G / R", "グリッド切替 / 直角切替") +
      hrow("? / H", "このヘルプの表示切替");
    document.body.appendChild(d);
    ED.help = d;
  }
  function hrow(k, v) {
    return "<div><b style='color:#f0c040'>" + k + "</b> — " + v + "</div>";
  }

  // ---------- ボタンの動作 ----------
  // Course(course-api)を編集状態へ読み込む。全レーン(ctrl+tunnels+raised)を取り込む。
  function loadCourse(c) {
    ED.lanes = lanesFrom(c.lanes);
    ED.laneIdx = 0; ED.ctrl = activeLane().ctrl;
    ED.sharp = c.sharp; ED.corner = c.corner; ED.overpass = c.overpass;
    ED.sel = -1; ED.spanStart = null;
  }
  function clearAll() {
    if (!ED.ctrl.length && ED.lanes.length <= 1) return;
    if (!confirm("置いた点・レーンをすべて消します。よろしいですか?(Ctrl-Z で戻せます)")) return;
    pushHistory();
    ED.lanes = [newLane()]; ED.laneIdx = 0; ED.ctrl = activeLane().ctrl;
    ED.sel = -1; ED.spanStart = null;
    paintLaneLabel();
    rebuildHandles(); updateStatus();
  }
  function loadFrom(idx) {
    pushHistory();
    loadCourse(PP.courseAPI.fromBuiltin(idx));
    rebuildHandles(); updateStatus();
    refreshToggles();
  }
  function refreshToggles() {
    // トグル/モードの色を作り直す(パネルごと組み直すのが簡単で確実)
    if (ED.panel) { document.body.removeChild(ED.panel); buildPanel(); updateStatus(); }
  }
  function play() {
    try { currentCourse().play(); }
    catch (e) { alert(e.message); }
  }
  function save() {
    var name = prompt("保存名(スロット)を入力:", "myCourse");
    if (!name) return;
    try { currentCourse().save(name); alert("保存しました: " + name); }
    catch (e) { alert(e.message); }
  }
  function loadSlot() {
    var slots = PP.courseAPI.slots();
    if (!slots.length) { alert("保存済みのコースがありません"); return; }
    var name = prompt("読み込むスロット名:\n" + slots.join(", "), slots[0]);
    if (!name) return;
    try {
      var c = PP.courseAPI.load(name);
      pushHistory();
      loadCourse(c);
      rebuildHandles(); refreshToggles();
    } catch (e) { alert(e.message); }
  }
  function exportJSON() {
    var json = currentCourse().toJSON();
    // コピーしやすいよう prompt に入れて出す
    prompt("この JSON をコピーして保存/共有できます:", json);
  }
  function importJSON() {
    var s = prompt("コースの JSON(または共有文字列)を貼り付け:");
    if (!s) return;
    try {
      var c = PP.courseAPI.fromJSON(s);
      pushHistory();
      loadCourse(c);
      rebuildHandles(); refreshToggles();
    } catch (e) { alert("読み込めませんでした: " + e.message); }
  }
  // ファイル名に使えない文字を _ に。全角(かな/カナ/漢字)と英数字・-_ は残す。
  function safeFileName(s) {
    s = (s || "").trim().replace(/[\\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
    return s || "pirate-course";
  }
  // 現在のコースを .json ファイルとしてローカルに保存(ダウンロード)する。
  // Blob → 一時的な <a download> をクリックしてブラウザのダウンロードを起こす。
  function downloadJSON() {
    var name = prompt("ファイル名(.json は自動で付きます):", "pirate-course");
    if (name === null) return;   // キャンセル
    var json = currentCourse().toJSON();
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = safeFileName(name) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  // ローカルの .json ファイルを選んで読み込む(downloadJSON で保存したものを戻す)。
  function importFile() {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var c = PP.courseAPI.fromJSON(String(reader.result));
          pushHistory();
          loadCourse(c);
          rebuildHandles(); refreshToggles();
        } catch (e) { alert("読み込めませんでした: " + e.message); }
      };
      reader.readAsText(f);
    };
    inp.click();
  }
  function shareURL() {
    var enc = currentCourse().encode();
    var url = location.origin + location.pathname + "?course=" + enc;
    prompt("この URL で共有(開くと直接試遊):", url);
  }

  // ---------- 開閉 ----------
  function open() {
    if (ED.active) return;
    // 【強化】宝玉の力の3択中はエディタを開かない(選択が宙に浮くのを防ぐ)
    if (PP.game.state === "choosing") return;
    ED.active = true;
    var g = PP.game;
    // 盤面をきれいにして編集に集中できる状態へ(全レーンの玉を片付ける)
    (g.lanes || []).forEach(function (lane) {
      lane.balls.forEach(function (b) { if (b.view.parent) b.view.parent.removeChild(b.view); });
      lane.balls = [];
    });
    g.shots.forEach(function (s) { PP.layers.shot.removeChild(s.view); });
    g.shots = [];
    g.state = "title";
    if (PP.crisis && PP.crisis.reset) PP.crisis.reset();   // 赤い帳・警報を平常へ
    if (PP.hud && PP.hud.hideOverlay) PP.hud.hideOverlay();

    // 編集中は BGM を止める(閉じたら元の状態へ戻す)
    if (PP.audio && PP.audio.setMuted) {
      ED._prevMuted = PP.audio.isMuted();
      PP.audio.setMuted(true);
    }

    ED.mode = "edit"; ED.sel = -1; ED.spanStart = null;
    ED.history = []; ED.redo = [];

    // 既存のコース描画(レール・洞窟・樽)や HUD は編集ビューと二重になるので隠す
    ED.layerVis = {};
    HIDE_LAYERS.forEach(function (k) {
      if (PP.layers[k]) { ED.layerVis[k] = PP.layers[k].visible; PP.layers[k].visible = false; }
    });

    ED.container = new createjs.Container();     // stage 座標(縮小しない)
    // 盤面を暗く覆う板。クリックで空き地に点を足す受け皿も兼ねる。
    // 甲板の背景(板目)が透けてグリッドとズレて見えるので、完全な不透明にする。
    ED.backdrop = new createjs.Shape();
    ED.backdrop.graphics.beginFill("#0b1420").drawRect(0, 0, PP.W, PP.H);
    ED.backdrop.on("mousedown", onCanvasDown);
    ED.container.addChild(ED.backdrop);

    // world: 実座標のレイヤーを縮小して、画面(0..W,0..H)の外側の「のりしろ」も映す
    ED.world = new createjs.Container();
    applyCamera();
    ED.preview = new createjs.Shape();
    ED.preview.mouseEnabled = false;   // 空き地クリックは下の backdrop へ通す
    ED.world.addChild(ED.preview);
    // 画面のふちの外=画面外、の説明ラベル(上の「のりしろ」に置く)
    ED.frameLabel = new createjs.Text(
      "▲ この枠の外は「画面外」。始点(緑)を枠の外に置くと、玉が画面外から流れ込みます",
      "14px sans-serif", "rgba(150,190,240,0.95)");
    ED.frameLabel.x = 6; ED.frameLabel.y = -MARGIN * 0.55; ED.frameLabel.mouseEnabled = false;
    ED.world.addChild(ED.frameLabel);
    ED.container.addChild(ED.world);

    PP.stage.addChild(ED.container);

    // 初回は編集しやすい簡単な3段の見本から。続けて開いた時は前回の続き。
    // 組み込みコースを土台にしたければパネルの「元コース1/2」から。
    ED.laneIdx = 0; ED.ctrl = activeLane().ctrl;
    if (ED.ctrl.length === 0) {
      ED.ctrl = activeLane().ctrl =
        [[1400, 90], [200, 90], [200, 300], [1100, 300], [1100, 520], [150, 520]];
    }
    rebuildHandles();

    buildPanel();
    updateStatus();
  }
  // 全体表示(初期/リセット)の縮尺へ。world 座標 (wx,wy) は
  // stage 座標 camX + wx*camScale へ写る。表示範囲は [-M .. W+M] を中央寄せ。
  function applyCamera() {
    var worldW = PP.W + 2 * MARGIN, worldH = PP.H + 2 * MARGIN;
    ED.baseScale = Math.min(PP.W / worldW, PP.H / worldH);
    ED.camScale = ED.baseScale;
    ED.camX = (PP.W - worldW * ED.camScale) / 2 + MARGIN * ED.camScale;
    ED.camY = (PP.H - worldH * ED.camScale) / 2 + MARGIN * ED.camScale;
    updateWorldTransform();
  }
  // cam の値を world レイヤーへ反映(拡大縮小・移動のたびに呼ぶ)
  function updateWorldTransform() {
    if (!ED.world) return;
    ED.world.scaleX = ED.world.scaleY = ED.camScale;
    ED.world.x = ED.camX; ED.world.y = ED.camY;
    if (ED.preview) redrawPreview();
  }
  // stage 座標 (sx,sy) を中心に factor 倍ズーム(その点の下の world 座標を固定)
  function zoomAt(sx, sy, factor) {
    var ns = Math.max(0.3, Math.min(3.0, ED.camScale * factor));
    factor = ns / ED.camScale;              // クランプ後の実効倍率
    ED.camX = sx - (sx - ED.camX) * factor;
    ED.camY = sy - (sy - ED.camY) * factor;
    ED.camScale = ns;
    updateWorldTransform();
  }
  function zoomBy(factor) { zoomAt(PP.W / 2, PP.H / 2, factor); }   // 画面中央基準
  function panBy(dx, dy) { ED.camX += dx; ED.camY += dy; updateWorldTransform(); }
  function resetView() { applyCamera(); }
  // stage 座標 → world(実)座標
  function toWorldX(sx) { return (sx - ED.camX) / ED.camScale; }
  function toWorldY(sy) { return (sy - ED.camY) / ED.camScale; }
  function close() {
    if (!ED.active) return;
    ED.active = false;
    if (ED.container) { PP.stage.removeChild(ED.container); ED.container = null; ED.world = null; ED.backdrop = null; ED.preview = null; ED.frameLabel = null; }
    if (ED.panel) { document.body.removeChild(ED.panel); ED.panel = null; ED.status = null; }
    if (ED.help) { document.body.removeChild(ED.help); ED.help = null; }
    // 隠していたゲームレイヤーの表示を元に戻す
    if (ED.layerVis) {
      Object.keys(ED.layerVis).forEach(function (k) {
        if (PP.layers[k]) PP.layers[k].visible = ED.layerVis[k];
      });
      ED.layerVis = null;
    }
    // 開く前の消音状態へ戻す(編集中に止めていた BGM を復帰)
    if (PP.audio && PP.audio.setMuted) PP.audio.setMuted(ED._prevMuted);
    // 編集を抜けたらタイトルへ戻す(ここからクリックで通常プレイ開始)
    var g = PP.game;
    if (g.state !== "playing") {
      g.state = "title";
      if (PP.hud && PP.hud.showOverlay)
        PP.hud.showOverlay("🏴‍☠️ 海賊の秘宝", "クリックで出航!\nE でコースエディタ");
    }
    PP.stage.update();
  }
  function toggleOpen() { ED.active ? close() : open(); }

  // ---------- 起動時の結線 ----------
  function attach() {
    // キー操作(エディタ中はゲーム側の keydown が素通りするので競合しない)
    window.addEventListener("keydown", function (e) {
      if (PP.pauseCtl && PP.pauseCtl.active) return;   // ポーズ中はエディタを開かない
      if (isTyping(e)) return;
      var ctrl = e.ctrlKey || e.metaKey;

      // E はエディタ開閉。Ctrl+E などは横取りしない。
      if (e.code === "KeyE" && !ctrl) { e.preventDefault(); toggleOpen(); return; }
      if (!ED.active) return;

      // ブラウザ動作を奪う Ctrl 系(取消/やり直し/保存)
      if (ctrl && e.code === "KeyZ") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (ctrl && e.code === "KeyY") { e.preventDefault(); redo(); return; }
      if (ctrl && e.code === "KeyS") { e.preventDefault(); save(); return; }
      if (ctrl) return;   // 他の Ctrl 組み合わせには触らない

      switch (e.code) {
        case "Digit1": setMode("edit"); break;
        case "Digit2": setMode("insert"); break;
        case "Digit3": setMode("erase"); break;
        case "Digit4": setMode("tunnel"); break;
        case "Digit5": setMode("bridge"); break;
        case "BracketLeft": switchLane(-1); break;
        case "BracketRight": switchLane(1); break;
        case "KeyN": addLane(); break;
        case "Delete": case "Backspace": e.preventDefault(); deleteSelectedOrLast(); break;
        case "Enter": e.preventDefault(); play(); break;
        case "KeyG": ED.snap = !ED.snap; redrawPreview(); refreshToggles(); break;
        case "KeyR": pushHistory(); ED.sharp = !ED.sharp; rebuildHandles(); updateStatus(); refreshToggles(); break;
        case "KeyC": toggleCornerSharp(); break;   // 選択した角を 直角⇄角丸
        case "Escape": close(); break;
        case "Slash": case "KeyH": toggleHelp(); break;   // Slash は Shift 併用で「?」
        // 拡大縮小・表示移動
        case "Equal": case "NumpadAdd": e.preventDefault(); zoomBy(1.2); break;
        case "Minus": case "NumpadSubtract": e.preventDefault(); zoomBy(1 / 1.2); break;
        case "Digit0": resetView(); break;
        case "ArrowLeft": e.preventDefault(); panBy(60, 0); break;
        case "ArrowRight": e.preventDefault(); panBy(-60, 0); break;
        case "ArrowUp": e.preventDefault(); panBy(0, 60); break;
        case "ArrowDown": e.preventDefault(); panBy(0, -60); break;
        default: break;
      }
    });
    // 右クリックでの点削除(main の contextmenu はエディタ中は何もしない)
    var cv = PP.stage && PP.stage.canvas;
    if (cv) cv.addEventListener("contextmenu", onContext);
    // ホイールでカーソル位置を中心に拡大縮小
    if (cv) cv.addEventListener("wheel", function (e) {
      if (!ED.active) return;
      e.preventDefault();
      var rect = cv.getBoundingClientRect();
      var sx = (e.clientX - rect.left) * (PP.W / rect.width);
      var sy = (e.clientY - rect.top) * (PP.H / rect.height);
      zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    // ホイールボタン(中ボタン)を押しながらドラッグで画面を移動(Miro 風のパン)
    if (cv) cv.addEventListener("mousedown", function (e) {
      if (!ED.active || e.button !== 1) return;   // 中ボタンのみ
      e.preventDefault();                          // 中ボタンのオートスクロールを止める
      var rect = cv.getBoundingClientRect();
      var kx = PP.W / rect.width, ky = PP.H / rect.height;
      var lx = e.clientX, ly = e.clientY;
      function mv(ev) {
        panBy((ev.clientX - lx) * kx, (ev.clientY - ly) * ky);
        lx = ev.clientX; ly = ev.clientY;
      }
      function up() {
        window.removeEventListener("mousemove", mv);
        window.removeEventListener("mouseup", up);
      }
      window.addEventListener("mousemove", mv);
      window.addEventListener("mouseup", up);
    });

    // 画面下に開くボタンを添える
    var b = document.createElement("button");
    b.textContent = "🛠 コース作成";
    b.style.cssText = "margin-top:10px;cursor:pointer;border:none;border-radius:8px;" +
      "padding:8px 16px;font:14px 'Meiryo',sans-serif;color:#0d1b2a;background:#f0c040;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.4);";
    b.onclick = toggleOpen;
    document.body.appendChild(b);
  }
  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  }

  PP.editor = { open: open, close: close, toggle: toggleOpen,
    get active() { return ED.active; } };

  // main の init(ステージ生成)より後に結線したいので、DOM 準備後に少し待つ
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () { setTimeout(bootstrap, 0); });
  else setTimeout(bootstrap, 0);

  function bootstrap() {
    if (typeof createjs === "undefined" || !PP.stage) { setTimeout(bootstrap, 50); return; }
    attach();
    if (PP.courseAPI && PP.courseAPI.checkURL) PP.courseAPI.checkURL();
  }
})();
