/* =========================================================
 * course-view.js — コースの静的な作画(海に浮かぶ木道・洞窟・立体交差の橋・
 *   トンネルの覆い・ゴールの樽)を1か所に集約したモジュール。
 *
 * ここは「見た目」だけを持つ。レール幾何(rail.js)とゲーム進行(main.js)から
 * 切り離し、レベルでコースが替わるたびに main.js の buildCourse がレーンごとに
 * PP.courseView.drawLane(lane) を呼ぶ。溝を流れる光だけは毎フレーム動くので
 * updateRailFlow(dt) を tick から呼ぶ(状態はこのモジュール内に閉じる)。
 *
 * 光源は左上(月光)固定。色・オフセットの定数は各パーツの質感(真鍮の木道/
 * 石橋/石廊のトンネル/樽)ごとに持つ。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // updateRailFlow のホットループ用の使い回しオブジェクト(posAtInto の書き込み先)。
  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };

  // ---------- 海石(石橋)のパレット ----------
  // 背景の海(#12293a〜#030810)と月光(rgba(170,200,224))と同じ冷たい色域に置く。
  // 以前の石灰岩(#9a917a + 温かいベージュの照り)は、冷たい海にも真鍮の道にも
  // 属さない第三の素材として浮いていた。青灰の花崗岩にすると海の一部として沈み、
  // 逆に「上を走る真鍮の道」が橋の上で浮き上がって読める。
  // 値(明度)は海(#12293a〜#030810)からはっきり浮く高さに取る。暗い青灰にすると
  // 色域は合っても海に沈んで「橋がある」と読めなくなる。色相で馴染ませ、明度で分ける。
  var SEA = {
    JOINT:  "#212b38",                  // 目地・最暗部
    SOFFIT: "#38465a",                  // 桁の下端(小口面)・アーチの内側
    STONE:  "#6b7d92",                  // 石の胴
    LIT:    "#a3b2c4",                  // 月光の当たる面
    RIM:    "rgba(220,236,252,0.7)",    // 天面リム(冷たい月光)
    BOUNCE: "rgba(120,170,200,0.16)",   // 水面からの照り返し(桁の下端)
    ALGAE:  "rgba(44,78,66,0.42)"       // 喫水線の海藻・染み
  };

  // レール上の弧長 lo..hi を step 刻みでたどってストロークの経路を引く共有ヘルパ。
  // ox/oy は「画面座標の」オフセット。落ち影のように光源方向へ一律にずらすもの専用。
  function strokeAlong(g, rail, lo, hi, ox, oy, step) {
    var first = true;
    for (var d = lo; d <= hi; d += step) {
      var p = rail.posAt(d);
      if (first) { g.moveTo(p.x + ox, p.y + oy); first = false; }
      else g.lineTo(p.x + ox, p.y + oy);
    }
  }

  // strokeAlong の「道の向きに追従する」版。各点で接線 t=(tx,ty) と法線 n=(-ty,tx) を
  // 取り、p + t*tanOff + n*normOff を結ぶ。
  //
  // 縁の照り・リムライト・欄干・目地は「道の縁」に乗るべきもので、画面座標の固定
  // オフセットで描いてはいけない。従来これらは strokeAlong(..., -0.5, -R-4) のように
  // 画面 y へ一律にずらして描かれていたため、道が垂直な区間(Lv3 の橋は2本とも垂直)
  // では「上縁の照り」が桁のど真ん中に落ちていた。法線で取れば向きに依らず縁に乗る。
  function normalAlong(g, rail, lo, hi, tanOff, normOff, step) {
    var first = true;
    for (var d = lo; d <= hi; d += step) {
      var p = rail.posAt(d);
      var x = p.x + p.tx * tanOff - p.ty * normOff;
      var y = p.y + p.ty * tanOff + p.tx * normOff;
      if (first) { g.moveTo(x, y); first = false; }
      else g.lineTo(x, y);
    }
  }

  // 中心 (cx,cy)・半径 (rx,ry) の楕円弧を線分で結ぶ。
  // Graphics.arc は真円しか引けないので、樽の口の内壁や真鍮のたがはこれで描く。
  function ellipseArcCV(g, cx, cy, rx, ry, a0, a1, n) {
    for (var i = 0; i <= n; i++) {
      var a = a0 + (a1 - a0) * (i / n);
      var x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
  }

  // d を種にした決定的な擬似乱数 0..1。石積みの目地・風化を「毎回同じ場所」に
  // 散らすために使う(Math.random だとコースを組み直すたびに石の割付が変わる)。
  function hash01(d) {
    var s = Math.sin(d * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  // --- レール(海に浮かぶ木道に彫られた通り道)を1本描く ---
  function drawRail(rail) {
    var R = PP.R;
    var railShape = new createjs.Shape();
    var rg = railShape.graphics;
    // 木道は折れ線の頂点を1つおきにたどる(弧長刻みではなく頂点間引き)。
    function traceRail(ox, oy) {
      ox = ox || 0; oy = oy || 0;
      rg.moveTo(rail.xs[0] + ox, rail.ys[0] + oy);
      for (var i = 1; i < rail.xs.length; i += 2) rg.lineTo(rail.xs[i] + ox, rail.ys[i] + oy);
    }
    // 海面へ落ちる柔らかい影(運河を水に馴染ませる)
    rg.setStrokeStyle(R * 2 + 30, "round", "round").beginStroke("rgba(0,0,0,0.40)");
    traceRail(4, 6); rg.endStroke();
    // 真鍮の縁(下地の深いブロンズ)
    rg.setStrokeStyle(R * 2 + 22, "round", "round").beginStroke("#3a2a12");
    traceRail(0, 0); rg.endStroke();
    // 縁の上端ハイライト(左上からの照り=磨いた真鍮)/ 下端の陰
    rg.setStrokeStyle(R * 2 + 22, "round", "round").beginStroke("rgba(230,192,120,0.85)");
    traceRail(-2, -2.8); rg.endStroke();
    rg.setStrokeStyle(R * 2 + 22, "round", "round").beginStroke("rgba(0,0,0,0.5)");
    traceRail(2, 3); rg.endStroke();
    // 真鍮の胴(明るい黄金)。縁の中央に太く乗せて金属らしい面を作る
    rg.setStrokeStyle(R * 2 + 14, "round", "round").beginStroke("#b98b3e");
    traceRail(0, 0); rg.endStroke();
    rg.setStrokeStyle(R * 2 + 14, "round", "round").beginStroke("rgba(255,226,150,0.45)");
    traceRail(-1, -1.6); rg.endStroke();
    // 縁の内側を締める暗いリップ(真鍮 → 溝への段差)
    rg.setStrokeStyle(R * 2 + 8, "round", "round").beginStroke("#1c1206");
    traceRail(0, 0); rg.endStroke();
    // 深い溝(通り道の底。ほぼ黒に近い藍で締める)
    rg.setStrokeStyle(R * 2 + 2, "round", "round").beginStroke("#0a1017");
    traceRail(0, 0); rg.endStroke();
    // 溝の内壁の AO(上側=光源側は少し明るく、下側に濃い影)
    rg.setStrokeStyle(R * 1.7, "round", "round").beginStroke("rgba(0,0,0,0.55)");
    traceRail(0.8, 1.4); rg.endStroke();
    rg.setStrokeStyle(3, "round", "round").beginStroke("rgba(120,150,180,0.10)");
    traceRail(-0.8, -1.8); rg.endStroke();
    // 橋(drawOverpasses)と同じ手で一度だけ焼く。pad は最太ストローク半幅
    // (R+15)+ 影オフセット(4,6)+ 丸キャップの余裕。
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < rail.xs.length; i++) {
      if (rail.xs[i] < x0) x0 = rail.xs[i];
      if (rail.xs[i] > x1) x1 = rail.xs[i];
      if (rail.ys[i] < y0) y0 = rail.ys[i];
      if (rail.ys[i] > y1) y1 = rail.ys[i];
    }
    var pad = R + 24;
    railShape.cache(x0 - pad, y0 - pad, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2);
    PP.layers.path.addChild(railShape);
  }

  // --- 洞窟(補給口): 真鍮縁のボルト付きハッチ。奥から玉が湧き出す暗い口 ---
  function drawCave(rail) {
    var R = PP.R;
    var start = rail.posAt(0);
    var cave = new createjs.Shape();
    cave.graphics
      .beginRadialGradientFill(["#000", "#0a0603", "#160d06"], [0.35, 0.8, 1], start.x, start.y, 2, start.x, start.y, R + 15)
      .drawCircle(start.x, start.y, R + 15);
    // 真鍮リング(下地 → 上端ハイライト → 下端影)
    cave.graphics.setStrokeStyle(7).beginStroke("#3a2a12").drawCircle(start.x, start.y, R + 14);
    cave.graphics.setStrokeStyle(4).beginStroke("#b98b3e").drawCircle(start.x, start.y, R + 14);
    cave.graphics.setStrokeStyle(2).beginStroke("rgba(255,226,150,0.7)")
      .arc(start.x, start.y, R + 14, Math.PI * 1.05, Math.PI * 1.75).endStroke();
    for (var a = 0; a < 6; a++) {
      var ang = a * Math.PI / 3;
      cave.graphics.beginFill("#e6c078")
        .drawCircle(start.x + Math.cos(ang) * (R + 14), start.y + Math.sin(ang) * (R + 14), 2.6);
      cave.graphics.beginFill("rgba(255,245,214,0.6)")
        .drawCircle(start.x + Math.cos(ang) * (R + 14) - 0.8, start.y + Math.sin(ang) * (R + 14) - 0.8, 1);
    }
    // 静止画なので一度だけ焼く(リング半径 R+14 + ストローク半幅 + 鋲の余裕)
    var cr = R + 22;
    cave.cache(start.x - cr, start.y - cr, cr * 2, cr * 2);
    PP.layers.path.addChild(cave);
  }

  // 溝を流れる光(コースティクス)。玉より下・レールより上の railFlow レイヤーに、
  // 一定間隔の光の筋を置き、tick で phase を進めてゴール方向へ流す。レーンごとに1組。
  var railFlows = [];
  function buildRailFlow(rail) {
    var R = PP.R;
    PP.layers.railFlow.compositeOperation = "lighter";
    var SP = R * 5.2;                                   // 光の間隔(px)
    var n = Math.max(3, Math.round(rail.length / SP));
    var dots = [];
    for (var i = 0; i < n; i++) {
      var s = new createjs.Shape();
      var rad = R * 0.5;
      s.graphics.beginRadialGradientFill(
        ["rgba(150,214,232,0.5)", "rgba(96,176,214,0.16)", "rgba(96,176,214,0)"],
        [0, 0.5, 1], 0, 0, 0, 0, 0, rad).drawCircle(0, 0, rad);
      s.cache(-rad, -rad, rad * 2, rad * 2);
      s.scaleX = 2.4; s.scaleY = 0.8;   // 進行方向へ伸ばす楕円(定数なので一度だけ設定)
      PP.layers.railFlow.addChild(s);
      dots.push(s);
    }
    railFlows.push({ rail: rail, dots: dots, spacing: rail.length / n, phase: 0, length: rail.length, speed: 95 });
  }

  // 流れる光を1フレーム進める(tick から呼ぶ)。全レーンぶん。
  function updateRailFlow(dt) {
    for (var fi = 0; fi < railFlows.length; fi++) {
      var rf = railFlows[fi];
      rf.phase = (rf.phase + rf.speed * dt) % rf.spacing;
      for (var i = 0; i < rf.dots.length; i++) {
        var fd = rf.phase + i * rf.spacing;
        if (fd > rf.length) fd -= rf.length;
        var p = rf.rail.posAtInto(fd, _pos);
        var dot = rf.dots[i];
        dot.x = p.x; dot.y = p.y;
        dot.rotation = Math.atan2(p.ty, p.tx) * 180 / Math.PI;   // 進行方向へ伸ばす
        dot.alpha = 0.35 + 0.3 * Math.sin(fd * 0.02 + rf.phase * 0.08);
      }
    }
  }

  // =========================================================
  // 立体交差の石橋 — 月光の海に立つアーチ水道橋
  //
  // 【遮蔽の契約】桁の視覚幅 DECK_HALF は、cannon.js の occludedByDeck が使う
  //   OCCLUDE_R2 の半径と対応していなければならない。ずれると「桁に隠れて見えない
  //   のに撃てる玉」が生まれ、見えている先の玉を狙った弾が途中で止まる。
  //   桁を片側 40px にしたので、cannon.js 側も (D*0.85)^2 = 半径 40.8px に合わせてある。
  //   ここを触るときは必ず両方を一緒に動かすこと。
  //
  //   34 → 40 に広げたのは見た目の必然による。水上の道の真鍮の縁は片側 35px あるので、
  //   桁が 34px だと「橋は道より細い」ことになり、中に何を描いても「灰色に塗った道」に
  //   しか見えない。橋が道より広くて、はじめて橋として読める。
  //
  // 【レイヤー分担】
  //   layers.bridgeUnder (玉より下) … 落ち影・水面の反射
  //   layers.bridge      (玉より上) … 橋脚・桁・欄干・舗装・目地・リム
  //   橋の構造はすべて玉を隠す側に置く: 玉より下に描くと、下をくぐる玉が
  //   石積みの上に浮いて見える(z の逆転)。撃てる/撃てないの契約(cannon.js の
  //   OCCLUDE_R2)は従来どおり桁 ±DECK_HALF のまま。
  // =========================================================

  var DECK_HALF    = PP.R + 16;   // 桁の片側幅(= 40)。cannon.js の OCCLUDE_R2 と対
  var PAVE_HALF    = PP.R - 3;    // 橋の上の舗装(車道)の片側幅
  var PIER_SPACING = PP.D * 2.6;  // 橋脚の間隔
  var PIER_CLEAR   = PP.D * 1.4;  // 交差点からこの距離内には橋脚を立てない(下の道を塞がない)

  // q を通り、法線方向の o0..o1 の区間だけ引く短い線(目地・親柱・橋台の継ぎ目)
  function seg(g, q, nx, ny, o0, o1, col, w) {
    g.setStrokeStyle(w, "round").beginStroke(col)
      .moveTo(q.x + nx * o0, q.y + ny * o0)
      .lineTo(q.x + nx * o1, q.y + ny * o1).endStroke();
  }

  // 区間で「手前(視点側)へ張り出す法線の向き」= +1 / -1。
  // 橋脚はこの向きへ降り、欄干は反対側(奥)に立つ。
  // 水平な道では真下(画面 +y)。垂直な道では法線が画面 y 成分を持たないので、
  // 月(MOON_X)から遠い=陰になる側を手前とみなす。
  function nearSide(rail, lo, hi) {
    var p = rail.posAt((lo + hi) / 2);
    if (Math.abs(p.tx) > 0.25) return p.tx > 0 ? 1 : -1;   // n=(-ty,tx) の y 成分は tx
    var moonX = (PP.bg && PP.bg.MOON_X) || PP.W * 0.62;
    var away = (p.x < moonX) ? -1 : 1;                      // 月と反対の横向き
    return (-p.ty * away > 0) ? 1 : -1;
  }

  // このレーン上に乗っている交差点の弧長を集める(自己交差・レーン間交差の両方)。
  // rail.js の courseCrossings が {laneA, laneB, da, db} で返してくるものを畳む。
  function crossingDsOn(crossings, laneIndex) {
    var out = [];
    if (!crossings) return out;
    for (var i = 0; i < crossings.length; i++) {
      var c = crossings[i];
      if (c.laneA === laneIndex) out.push(c.da);
      if (c.laneB === laneIndex) out.push(c.db);
    }
    return out;
  }

  // 橋脚を立てる弧長の一覧。両端(橋台)には必ず立て、中間は等間隔に置くが、
  // 交差点の近く(下の道を塞ぐ位置)と端に寄りすぎたものは間引く。
  // 自動検出の短い区間(±D*1.5 = 144px)では結果的に両端2本 = 単アーチになる。
  function pierDs(lo, hi, xds) {
    var out = [lo];
    var span = hi - lo;
    var n = Math.max(1, Math.round(span / PIER_SPACING));
    for (var k = 1; k < n; k++) {
      var d = lo + span * (k / n);
      var blocked = false;
      for (var i = 0; i < xds.length; i++) {
        if (Math.abs(d - xds[i]) < PIER_CLEAR) { blocked = true; break; }
      }
      if (blocked) continue;
      if (d - out[out.length - 1] < PP.D * 0.9 || hi - d < PP.D * 0.9) continue;
      out.push(d);
    }
    out.push(hi);
    return out;
  }

  // --- 橋脚1本 ---
  // この画面はほぼ真上から見た平面図なので、側面図の水道橋(長い柱が下へ伸びる)を
  // そのまま描くと瓦礫のような板にしか見えない。ここでは「桁の手前の縁から少しだけ
  // 顔を出す石のブロック」として描く。控えめだが、等間隔に並ぶことで確実に橋脚と読める。
  function drawPier(g, rail, d, side) {
    var R = PP.R;
    var p = rail.posAt(d);
    var nx = -p.ty * side, ny = p.tx * side;   // 手前(桁の縁の外)へ向かう向き
    var tx = p.tx, ty = p.ty;                  // 道に沿う向き(= 橋脚の幅方向)
    var IN = DECK_HALF - 8, OUT = DECK_HALF + 38;    // 桁の内側から水面まで降りる範囲
    var WI = R * 0.62, WO = R * 0.42;          // 内側 / 先端の半幅(先すぼまり=遠近)
    function P(along, out) {
      return { x: p.x + tx * along + nx * out, y: p.y + ty * along + ny * out };
    }

    // 足元の波立ち(石が水を割っている根本)
    var tip = P(0, OUT);
    g.beginRadialGradientFill(["rgba(2,8,14,0.55)", "rgba(2,8,14,0)"], [0, 1],
      tip.x, tip.y, 2, tip.x, tip.y, R * 0.95)
      .drawEllipse(tip.x - R * 0.95, tip.y - R * 0.55, R * 1.9, R * 1.1);

    // 石のブロック。桁の陰にあるので全体を暗く取り、水際へ向かってさらに沈める
    // (明るく描くと、下の道の玉が橋脚の上に重なったときに前後が逆に読める)
    var a = P(-WI, IN), b = P(WI, IN), c = P(WO, OUT), e = P(-WO, OUT);
    var gIn = P(0, IN), gOut = P(0, OUT);
    g.beginLinearGradientFill(["#5a6a7d", "#465468", "#2b3644", SEA.JOINT], [0, 0.3, 0.72, 1],
      gIn.x, gIn.y, gOut.x, gOut.y)
      .moveTo(a.x, a.y).lineTo(b.x, b.y).lineTo(c.x, c.y).lineTo(e.x, e.y).closePath();
    g.setStrokeStyle(1.2, "round").beginStroke("rgba(16,22,30,0.7)")
      .moveTo(a.x, a.y).lineTo(e.x, e.y).lineTo(c.x, c.y).lineTo(b.x, b.y).endStroke();

    // 石の段(2本の横目地)
    for (var k = 1; k <= 2; k++) {
      var t = k / 3, o = IN + (OUT - IN) * t;
      var hw = WI + (WO - WI) * t;
      var s0 = P(-hw, o), s1 = P(hw, o);
      g.setStrokeStyle(1.3, "round").beginStroke("rgba(16,22,30,0.6)")
        .moveTo(s0.x, s0.y).lineTo(s1.x, s1.y).endStroke();
      g.setStrokeStyle(0.8, "round").beginStroke("rgba(210,230,250,0.18)")
        .moveTo(s0.x - nx * 1.3, s0.y - ny * 1.3).lineTo(s1.x - nx * 1.3, s1.y - ny * 1.3).endStroke();
    }

    // 喫水線: 海藻の染み + そのすぐ上の明るい水線。ここで石が海に「入る」
    var wo = OUT - R * 0.3, whw = WI + (WO - WI) * ((wo - IN) / (OUT - IN));
    var w0 = P(-whw, wo), w1 = P(whw, wo);
    g.setStrokeStyle(R * 0.26, "round").beginStroke(SEA.ALGAE)
      .moveTo(w0.x, w0.y).lineTo(w1.x, w1.y).endStroke();
    g.setStrokeStyle(1.5, "round").beginStroke("rgba(214,234,252,0.45)")
      .moveTo(w0.x - nx * R * 0.2, w0.y - ny * R * 0.2)
      .lineTo(w1.x - nx * R * 0.2, w1.y - ny * R * 0.2).endStroke();
  }

  // --- 玉より下(path 層)に描く構造: 落ち影・水面の反射 ---
  // アーチは描かない(下をくぐる玉との前後関係が平面レイヤーでは破綻しやすく、
  // 試作の結果、桁+橋脚だけの方がすっきり読めた)。橋脚は玉を隠す側(bridge 層)。
  function drawBridgeUnder(g, rail, lo, hi, piers, side) {
    var R = PP.R;

    // 1. 海面への落ち影。道・洞窟・樽と同じ +x/+y 方向へ揃える。
    //    平面図でこの橋が「浮いている」と言っているのは、結局この影が一番強い。
    g.setStrokeStyle(R * 2 + 30, "round", "round").beginStroke("rgba(2,8,14,0.52)");
    strokeAlong(g, rail, lo, hi, 11, 14, 6); g.endStroke();

    // 2. 桁が海面に落とす途切れた反射。background.js の月光柱と同じ語彙
    //    (細い光の楕円を刻む)にして、橋を海の一部として馴染ませる
    for (var d = lo; d <= hi; d += R * 0.7) {
      var p = rail.posAt(d);
      var j = hash01(d * 0.37);
      if (j < 0.3) continue;
      var w = R * (0.5 + j * 0.7), h = 1 + j * 1.8;
      var ry = p.y + R * 1.7 + j * R * 1.8;
      g.beginRadialGradientFill(
        ["rgba(150,190,225," + (0.09 + j * 0.11).toFixed(3) + ")", "rgba(150,190,225,0)"],
        [0, 1], p.x, ry, 1, p.x, ry, w)
        .drawEllipse(p.x - w, ry - h, w * 2, h * 2);
    }

  }

  // --- 玉より上(bridge 層)に描く桁: 石の帯・欄干・橋を渡る道・目地 ---
  // ここに描いたものだけが下をくぐる玉を隠す。片側 34px を超えないこと。
  function drawBridgeDeck(g, rail, lo, hi, side) {
    var R = PP.R;
    var STEP = 6;
    var far = -side;   // 欄干は奥側(手前へ張り出す橋脚の反対)に立てる

    // 帯の内訳(法線オフセット。片側 DECK_HALF = 40):
    //   奥 -40..-27  欄干(壁 + 笠石 + 月光リム + 親柱)
    //     -21..+21   舗装(石畳の車道。玉はこの中央 0 を渡る)
    //   手前 +27..+40 桁の小口(厚みを見せる暗い面)
    //
    // 水上の道のような「真っ黒な溝」を橋の上まで引くと、桁が全部その溝に食われて
    // 暗い土管になる。橋の上は溝ではなく石畳の舗装にする。構造的にも正しく
    // (橋の上に運河は無い)、玉が桁の上を渡っているのがはっきり見える。
    var DH = DECK_HALF, PH = PAVE_HALF;

    // --- 石の桁。端は "butt" で角を落とす("round" だと橋が丸いカプセルに見える) ---
    g.setStrokeStyle(DH * 2, "butt", "round").beginStroke(SEA.JOINT);
    strokeAlong(g, rail, lo, hi, 0, 0, STEP); g.endStroke();
    g.setStrokeStyle(DH * 2 - 4, "butt", "round").beginStroke(SEA.STONE);
    strokeAlong(g, rail, lo, hi, 0, 0, STEP); g.endStroke();

    // 石のむら。一様な灰色の帯だと成形プラスチックに見えるので、d を種にした
    // 濃淡のパッチを散らして「積まれた石」の不揃いさを出す
    for (var td = lo + R * 0.4; td <= hi - R * 0.4; td += R * 1.15) {
      var tp = rail.posAt(td);
      var tj = hash01(td * 2.7);
      var tw = R * (0.5 + tj * 0.5);
      g.setStrokeStyle(R * (0.9 + tj * 0.7), "butt", "round")
        .beginStroke(tj > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(10,16,26,0.13)");
      normalAlong(g, rail, td - tw, td + tw, 0, (tj - 0.5) * (DH * 1.1), 5);
      g.endStroke();
    }

    // --- 手前の小口(桁の厚み)。暗い面 + 下端の締め + 天面との角の照り ---
    g.setStrokeStyle(13, "round", "round").beginStroke(SEA.SOFFIT);
    normalAlong(g, rail, lo, hi, 0, side * (DH - 6.5), STEP); g.endStroke();
    g.setStrokeStyle(2.4, "round", "round").beginStroke(SEA.JOINT);
    normalAlong(g, rail, lo, hi, 0, side * (DH - 1), STEP); g.endStroke();
    g.setStrokeStyle(1.8, "round", "round").beginStroke("rgba(214,234,252,0.34)");
    normalAlong(g, rail, lo, hi, 0, side * (DH - 13.2), STEP); g.endStroke();

    // --- 舗装(石畳の車道)。玉は posAt(d) の上を通るので必ず法線 0 を中心に ---
    g.setStrokeStyle(PH * 2, "butt", "round").beginStroke("#232d3a");
    strokeAlong(g, rail, lo, hi, 0, 0, STEP); g.endStroke();
    g.setStrokeStyle(PH * 2 - 6, "butt", "round").beginStroke("#2b3746");
    strokeAlong(g, rail, lo, hi, 0, 0, STEP); g.endStroke();
    // 手前側に寄った轍の陰(舗装が平らな板に見えないように)
    g.setStrokeStyle(PH * 0.9, "round", "round").beginStroke("rgba(10,16,24,0.34)");
    normalAlong(g, rail, lo, hi, 0, side * PH * 0.42, STEP); g.endStroke();
    // 真鍮の縁石。水上の道と同じ金属を1本ずつ回して「同じ道の続き」と言わせる
    g.setStrokeStyle(3.2, "round").beginStroke("#b98b3e");
    normalAlong(g, rail, lo, hi, 0, far * (PH + 1.6), STEP); g.endStroke();
    g.setStrokeStyle(3.2, "round").beginStroke("#8a6428");
    normalAlong(g, rail, lo, hi, 0, side * (PH + 1.6), STEP); g.endStroke();
    g.setStrokeStyle(1.4, "round").beginStroke("rgba(255,226,150,0.6)");
    normalAlong(g, rail, lo, hi, 0, far * (PH + 0.2), STEP); g.endStroke();

    // --- 欄干(奥側)。低い壁 + 笠石 + 月光リム ---
    g.setStrokeStyle(3, "round", "round").beginStroke("rgba(0,0,0,0.5)");
    normalAlong(g, rail, lo, hi, 0, far * (PH + 4), STEP); g.endStroke();     // 壁の足元の陰
    g.setStrokeStyle(11, "round", "round").beginStroke(SEA.STONE);
    normalAlong(g, rail, lo, hi, 0, far * (DH - 7.5), STEP); g.endStroke();   // 壁面
    g.setStrokeStyle(4.4, "round", "round").beginStroke(SEA.LIT);
    normalAlong(g, rail, lo, hi, 0, far * (DH - 2.6), STEP); g.endStroke();   // 笠石

    // --- 舗装の石畳・親柱・石積みの目地 ---
    // 従来は道を横切って全幅に1本引いていたので櫛のように見えていた。
    // 帯ごとに刻み方を変え、d を種にした擬似乱数で幅と有無を揺らして
    // 等間隔の機械的な繰り返しを崩す。
    for (var dd = lo + R * 0.5; dd <= hi - R * 0.5; dd += R * 0.62) {
      var q = rail.posAt(dd);
      var nx = -q.ty, ny = q.tx;
      var j = hash01(dd);
      var w = 1.2 + j * 1.1;
      // 舗装の目地(細く薄く。玉の下でうるさくならない程度に)
      seg(g, q, nx, ny, -PH * (0.86 + j * 0.12), PH * (0.86 + j * 0.12), "rgba(12,18,26,0.3)", 1.1);
      // 欄干の親柱(奥)
      if (j > 0.25) {
        seg(g, q, nx, ny, far * (PH + 4), far * (DH - 1), "rgba(16,22,30,0.6)", w);
        seg(g, q, nx, ny, far * (DH - 4.6), far * (DH - 1), "rgba(214,234,252,0.28)", 1);
      }
      // 手前の小口の目地(半分の頻度。位置をずらして単調さを消す)
      if (j > 0.5) seg(g, q, nx, ny, side * (PH + 5), side * (DH - 1), "rgba(12,18,26,0.55)", w);
    }

    // --- 天面の冷たいリムライト ---
    // 従来は画面 y への固定オフセット(-R-4)で描いていたため、道が垂直な区間では
    // 「上縁の照り」が桁のど真ん中に落ちていた。法線で取れば向きに依らず縁に乗る。
    g.setStrokeStyle(2.4, "round", "round").beginStroke(SEA.RIM);
    normalAlong(g, rail, lo, hi, 0, far * (DH - 0.6), STEP); g.endStroke();

    // --- 橋台: 端が丸い切り株のままだと橋が宙で終わって見える。
    //     道と橋の継ぎ目に石の縁を1本入れて着地させる ---
    [lo, hi].forEach(function (d) {
      var q = rail.posAt(d);
      var nx = -q.ty, ny = q.tx;
      seg(g, q, nx, ny, far * (DH - 1), far * (PH + 2), "rgba(16,22,30,0.7)", 3.2);
      seg(g, q, nx, ny, side * (PH + 2), side * (DH - 1), "rgba(16,22,30,0.7)", 3.2);
      seg(g, q, nx, ny, far * (DH - 2.4), far * (DH - 8), "rgba(214,234,252,0.3)", 1.3);
    });
  }

  // 区間の折れ線から、パーツのはみ出しぶん pad を足した外接矩形を返す(cache 範囲用)
  function spanBounds(rail, ivs, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < ivs.length; i++) {
      for (var d = ivs[i][0]; d <= ivs[i][1] + 6; d += 6) {
        var p = rail.posAt(Math.min(d, rail.length));
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
    }
    return [x0 - pad, y0 - pad, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2];
  }

  // 立体交差の「上の帯」を、月光の海に立つアーチ石橋として描く。
  // crossings は PP.rail.courseCrossings(course) の結果(省略可)。
  // 省略すると橋脚は両端だけ = 単アーチになる(安全側)。
  function drawOverpasses(rail, crossings, laneIndex) {
    var R = PP.R;
    var raw = rail.overIntervals || [];
    if (raw.length === 0) return;

    var ivs = [];
    for (var i = 0; i < raw.length; i++) {
      var lo = Math.max(0, raw[i][0]), hi = Math.min(rail.length, raw[i][1]);
      if (hi - lo >= R) ivs.push([lo, hi]);
    }
    if (ivs.length === 0) return;

    var xds = crossingDsOn(crossings, laneIndex);
    var under = new createjs.Shape();
    var deck = new createjs.Shape();

    for (var k = 0; k < ivs.length; k++) {
      var lo2 = ivs[k][0], hi2 = ivs[k][1];
      var side = nearSide(rail, lo2, hi2);
      var piers = pierDs(lo2, hi2, xds);
      drawBridgeUnder(under.graphics, rail, lo2, hi2, piers, side);
      // 橋脚 → 桁の順に、玉より上の deck(bridge 層)へ。下をくぐる玉を隠す。
      for (var m = 0; m < piers.length; m++) drawPier(deck.graphics, rail, piers[m], side);
      drawBridgeDeck(deck.graphics, rail, lo2, hi2, side);
    }

    // 橋はコース構築時に一度描くだけの静止画。焼いておけば、これだけディテールを
    // 足しても毎フレームのラスタライズ費用はゼロになる(background/ball と同じ手)。
    var ub = spanBounds(rail, ivs, R * 4.4);   // 反射 + 落ち影のはみ出しぶん
    var db = spanBounds(rail, ivs, R * 4.4);   // アーチ + 橋脚は桁より大きく張り出す
    under.cache(ub[0], ub[1], ub[2], ub[3]);
    deck.cache(db[0], db[1], db[2], db[3]);

    // 構造は bridgeUnder(全レーンの道より上・すべての玉より下)へ。path に置くと
    // あとから描かれる別レーンの道が落ち影やアーチの暗がりを上塗りしてしまう。
    PP.layers.bridgeUnder.addChild(under);
    PP.layers.bridge.addChild(deck);     // 桁だけが玉より上 = 下をくぐる玉を隠す
  }

  // --- トンネル(隠れる区間)の覆い ---
  // トンネル区間のレールへ、石橋と同じ青灰の花崗岩(SEA パレット)で組んだ
  // かまぼこ屋根の石廊(ギャラリー)を被せて玉を隠す。玉より上の tunnel レイヤーに
  // 描くので、区間内の玉は覆いの下に完全に隠れる(=撃てない)。
  //
  // 以前は「木と鉄の蓋」だったが、冷たい夜の海・青灰の石橋・真鍮の道という画面の
  // 語彙のどれにも属さない暖色の帯として浮いていた。橋の桁と同じ石・同じ幅・同じ
  // 目地で組めば、トンネルは「橋の仲間の構造物」として画面に収まる。
  //
  // 縁の照り・目地はすべて法線オフセット(normalAlong / seg)で取る。以前の
  // 画面座標の固定オフセットは、道が縦や U ターンになる区間でハイライトが
  // 縁から剥がれて胴のど真ん中に落ちていた(カーブで破綻する原因)。
  function drawTunnels(rail) {
    var R = PP.R;
    var tuns = rail.tunnels || [];
    if (tuns.length === 0) return;
    // 覆いの片側幅。玉(±R)は完全に隠れ、道の真鍮の縁(±R+11)が両脇に少し
    // 覗く幅にする。桁と同じ幅(R+16)まで広げると、ヘアピンを含むトンネルでは
    // 隣り合う道の覆い同士が融合して一枚の巨大な石の板に見えてしまう。
    var DH = PP.R + 6;
    var WR = PP.R * 0.55;    // 舷窓(丸窓)の穴の半径
    var wins = [];           // くり抜く窓の中心。cache 後に destination-out で開ける
    var shape = new createjs.Shape();
    var g = shape.graphics;

    for (var i = 0; i < tuns.length; i++) {
      // 覆いは区間より玉半径ぶん長くして、端の玉が半分見えないようにする
      var lo = Math.max(0, tuns[i][0] - R), hi = Math.min(rail.length, tuns[i][1] + R);

      // 1. 海面への落ち影(橋の桁・道と同じ +x/+y 方向)
      g.setStrokeStyle(DH * 2 + 8, "butt", "round").beginStroke("rgba(2,8,14,0.5)");
      strokeAlong(g, rail, lo, hi, 9, 12, 6); g.endStroke();

      // 2. 石の胴。縁・肩・稜線はすべて「中心線上の同心ストローク」で作る。
      //    法線オフセットで縁の線を引くと、U ターンの内側で経路が自己交差して
      //    稲妻状に暴れる。幅の違う重ね塗りなら round join がどんなカーブでも捌く。
      //    まず月光の細い縁(両側に 1.5px 覗く halo)→ 目地色の下地 → 石の面。
      g.setStrokeStyle(DH * 2 + 3, "butt", "round").beginStroke("rgba(220,236,252,0.30)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      g.setStrokeStyle(DH * 2, "butt", "round").beginStroke(SEA.JOINT);
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      g.setStrokeStyle(DH * 2 - 4, "butt", "round").beginStroke(SEA.STONE);
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      // 屋根は月に正対しない曲面なので、桁の天面(SEA.STONE そのまま)より
      // 一段沈める。これを省くと広い面が白茶けて夜の海から浮く
      g.setStrokeStyle(DH * 2 - 4, "butt", "round").beginStroke("rgba(12,22,36,0.30)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();

      // 3. 石のむら(桁と同じ手。d を種にした濃淡で「積まれた石」の不揃いさ)
      for (var td = lo + R * 0.4; td <= hi - R * 0.4; td += R * 1.15) {
        var t0 = rail.posAt(td - 5), t1 = rail.posAt(td + 5);
        if (t0.tx * t1.tx + t0.ty * t1.ty < 0.985) continue;   // カーブのきつい所は石むらも休む
        var tj = hash01(td * 2.7);
        var tw = R * (0.5 + tj * 0.5);
        g.setStrokeStyle(R * (0.9 + tj * 0.7), "butt", "round")
          .beginStroke(tj > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(10,16,26,0.13)");
        normalAlong(g, rail, Math.max(lo, td - tw), Math.min(hi, td + tw),
          0, (tj - 0.5) * (DH * 1.1), 5);
        g.endStroke();
      }

      // 4. かまぼこ屋根(ヴォールト)の面: 両肩を沈め、稜線に月光を通す。
      //    これが桁(平らな石畳)との描き分け=「上を歩く橋 / 中をくぐる屋根」。
      //    同心ストロークだけで作る(肩=広い暗 → 中央を持ち上げ → 稜線の光)。
      g.setStrokeStyle(DH * 2 - 6, "butt", "round").beginStroke("rgba(8,14,24,0.30)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      g.setStrokeStyle(DH * 1.3, "butt", "round").beginStroke("rgba(122,140,160,0.45)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      g.setStrokeStyle(DH * 0.6, "butt", "round").beginStroke("rgba(190,212,235,0.22)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();
      g.setStrokeStyle(DH * 0.25, "butt", "round").beginStroke("rgba(228,244,255,0.14)");
      strokeAlong(g, rail, lo, hi, 0, 0, 6); g.endStroke();

      // 5. 迫石の目地(屋根を横切る石の割り)。橋の楔石と同じ言い回しで、
      //    幅と有無を hash01 で揺らして機械的な繰り返しを崩す。
      //    カーブのきつい所(前後で接線が10°超回る所)は引かない: ヘアピンの
      //    内側では法線同士が交差して、目地が扇の骨のように暴れるため。
      for (var dd = lo + R * 0.6; dd <= hi - R * 0.6; dd += R * 0.85) {
        var q0 = rail.posAt(dd - 5), q1 = rail.posAt(dd + 5);
        if (q0.tx * q1.tx + q0.ty * q1.ty < 0.985) continue;
        var q = rail.posAt(dd);
        var jj = hash01(dd * 1.3);
        if (jj < 0.18) continue;
        var nx2 = -q.ty, ny2 = q.tx;
        seg(g, q, nx2, ny2, -(DH - 3), DH - 3, "rgba(12,18,26,0.4)", 1.1 + jj * 0.9);
        if (jj > 0.6) {
          seg(g, q, nx2, ny2, -(DH - 5), -(DH * 0.2), "rgba(214,234,252,0.10)", 0.9);
        }
      }

      // 6. 舷窓(小窓)。一定間隔で覆いをくり抜き、中を流れる玉を見せる。
      //    窓は真円なので、ヘアピンでも回転で破綻しない。縁は道の真鍮に合わせた
      //    丸窓の枠にする。くり抜きは Graphics では消せないので、位置だけ集めて
      //    cache 後にビットマップへ destination-out で穴を開ける。
      for (var wd = lo + R * 2.2; wd <= hi - R * 2.2; wd += R * 2.4) {
        var wq = rail.posAt(wd);
        wins.push({ x: wq.x, y: wq.y });
        g.setStrokeStyle(5, "round").beginStroke("#3a2a12").drawCircle(wq.x, wq.y, WR + 2.5);
        g.endStroke();
        g.setStrokeStyle(2.6, "round").beginStroke("#b98b3e").drawCircle(wq.x, wq.y, WR + 3);
        g.endStroke();
        g.setStrokeStyle(1.2, "round").beginStroke("rgba(255,226,150,0.65)")
          .arc(wq.x, wq.y, WR + 3, Math.PI * 1.05, Math.PI * 1.75).endStroke();
      }

      // 出入口に飾りは付けない。覆いの端(butt の切り口)へ玉がそのまま
      // 潜り込む/出てくる。以前あった坑口の黒い口は「変な黒丸」にしか
      // 見えなかったので描かない。
    }

    // 覆いも静止画。石の胴(片側 DH)+ 坑口の環のはみ出しを pad で包む
    var civs = [];
    for (var j = 0; j < tuns.length; j++) {
      civs.push([Math.max(0, tuns[j][0] - R), Math.min(rail.length, tuns[j][1] + R)]);
    }
    var tb = spanBounds(rail, civs, DH + 16);
    shape.cache(tb[0], tb[1], tb[2], tb[3]);
    // 舷窓の穴を開ける。覆いの下(ballUnder/ballOver)にいる玉が、この穴からだけ
    // 覗く(main.js はトンネル内の玉も描画したままにしている)。
    var ctx = shape.cacheCanvas.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (var wi = 0; wi < wins.length; wi++) {
      ctx.beginPath();
      ctx.arc(wins[wi].x - tb[0], wins[wi].y - tb[1], WR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    PP.layers.tunnel.addChild(shape);
  }

  // ---------- ゴールの樽 ----------
  // 樽は横倒しで、レール終端の接線方向を向く(口が玉の来る側を向く)。レーン単位。
  //
  // 旧版は「大きな楕円 + 直線の板目 + 灰色の輪」で、樽というより木目を塗った
  // 座布団に見えていた。樽が樽に見えるのは、(1) 胴が中央で膨らむ輪郭、
  // (2) その膨らみに沿って弧を描く板(stave)の継ぎ目、(3) 打ち込まれた鉄のたが、
  // の3つがそろったときだけ。ここではその3つを素直に描く。
  //
  // crisis.js / gameover.js が {back, front, skull, mouth} を掴んで
  // back/front を拡大縮小し、skull は Text として .color を差し替えるので、
  // このキーと型は変えないこと。
  var OAK = {
    LIT:  "#c58d54", MID: "#9c6530", BODY: "#7c4f26",
    DARK: "#4a2c11", EDGE: "#24140a",
    IRON: "#333944", IRON_LIT: "#8992a0",
    BRASS: "#b98b3e", BRASS_LIT: "#e6c078"
  };

  // 樽の輪郭(中央で膨らむ)。x0..x1 が軸方向、端の半幅 wEnd・中央の半幅 wMid。
  // 奥の端(x1)は平らに閉じず、鏡板の丸みぶん膨らませる。直線で閉じると
  // 「切り落とされた筒」に見えて、樽がそこで終わっていないように読める。
  function barrelOutline(g, x0, x1, wEnd, wMid) {
    var mx = (x0 + x1) / 2;
    var k = wMid + (wMid - wEnd) * 0.28;   // 二次ベジェが wMid を通るような制御点
    g.moveTo(x0, -wEnd);
    g.quadraticCurveTo(mx, -k, x1, -wEnd);
    g.quadraticCurveTo(x1 + wEnd * 0.5, 0, x1, wEnd);   // 奥の鏡板の丸み
    g.quadraticCurveTo(mx, k, x0, wEnd);
    g.closePath();
  }

  function buildBarrel(lane) {
    var R = PP.R;
    var rail = lane.rail;
    var end = rail.posAt(rail.length - 1);
    var ang = Math.atan2(end.ty, end.tx) * 180 / Math.PI;
    var BH = R * 3.3;    // 胴の長さ(軸方向)
    var WM = R * 2.1;    // 胴の中央の半幅(いちばん膨らむところ)
    var WE = WM * 0.8;   // 鏡板(両端)の半幅
    var RX = R * 0.8;    // 口の楕円の軸方向半径
    var i;

    // --- 足元の影(回すと不自然なので world 座標のまま。光は左上→影は右下) ---
    var shadow = new createjs.Shape();
    shadow.graphics
      .beginRadialGradientFill(["rgba(0,0,0,0.52)", "rgba(0,0,0,0)"], [0, 1],
        end.x + 6, end.y + WM * 0.55, 4, end.x + 6, end.y + WM * 0.55, WM * 1.7)
      .drawEllipse(end.x - WM * 1.6, end.y + WM * 0.1, WM * 3.4, WM * 1.0);
    shadow.cache(end.x - WM * 1.6 - 4, end.y + WM * 0.1 - 4, WM * 3.4 + 8, WM * 1.0 + 8);
    PP.layers.path.addChild(shadow);

    // --- 奥のレイヤー: 胴・板・たが・口の内側 ---
    var back = new createjs.Container();
    back.x = end.x; back.y = end.y; back.rotation = ang;
    var body = new createjs.Shape();
    var g = body.graphics;

    // 胴。円筒の陰影を軸と直交するグラデで作る(上=月光側が明るい)
    g.beginLinearGradientFill(
      [OAK.EDGE, OAK.DARK, OAK.MID, OAK.LIT, OAK.MID, OAK.BODY, OAK.DARK, OAK.EDGE],
      [0, 0.06, 0.22, 0.36, 0.56, 0.78, 0.93, 1], 0, -WM, 0, WM);
    barrelOutline(g, 0, BH, WE, WM);
    g.beginStroke("rgba(18,10,3,0.9)").setStrokeStyle(2);
    barrelOutline(g, 0, BH, WE, WM);
    g.endStroke();

    // 板(stave)の継ぎ目。胴の膨らみに沿って弧を描かせるのが要点。
    // 直線で引くと板が平らに見えて、樽の丸みが消える。
    for (i = -3; i <= 3; i++) {
      var f = i / 3.5;
      var ye = f * WE, ym = f * WM, kk = ym + (ym - ye) * 0.28;
      g.setStrokeStyle(1.6, "round").beginStroke("rgba(26,14,4,0.5)")
        .moveTo(RX * 0.35, ye).quadraticCurveTo(BH / 2, kk, BH, ye).endStroke();
      g.setStrokeStyle(0.9, "round").beginStroke("rgba(240,206,150,0.13)")
        .moveTo(RX * 0.35, ye - 1.6).quadraticCurveTo(BH / 2, kk - 1.6, BH, ye - 1.6).endStroke();
    }

    // 奥の鏡板(樽の底)。膨らみの縁に沿った暗い帯と、その内側の照りで丸く閉じる
    g.setStrokeStyle(3, "round").beginStroke("rgba(20,11,3,0.6)")
      .moveTo(BH, -WE).quadraticCurveTo(BH + WE * 0.5, 0, BH, WE).endStroke();
    g.setStrokeStyle(1.6, "round").beginStroke("rgba(240,206,150,0.16)")
      .moveTo(BH - 2, -WE * 0.94).quadraticCurveTo(BH + WE * 0.5 - 3, 0, BH - 2, WE * 0.94).endStroke();

    // 鉄のたが。胴に打ち込まれた帯として、膨らみに合わせて少し反らせる
    [0.22, 0.55, 0.86].forEach(function (t) {
      var hx = BH * t;
      // その位置での胴の半幅(輪郭の二次ベジェを評価)
      var u = hx / BH, w = (1 - u) * (1 - u) * WE + 2 * (1 - u) * u * (WM + (WM - WE) * 0.28) + u * u * WE;
      var bow = 3.2;
      g.setStrokeStyle(R * 0.36, "butt").beginStroke(OAK.IRON)
        .moveTo(hx, -w).quadraticCurveTo(hx + bow, 0, hx, w).endStroke();
      g.setStrokeStyle(1.6, "butt").beginStroke(OAK.IRON_LIT)
        .moveTo(hx - R * 0.13, -w * 0.98).quadraticCurveTo(hx + bow - R * 0.13, 0, hx - R * 0.13, w * 0.98).endStroke();
      g.setStrokeStyle(1.2, "butt").beginStroke("rgba(0,0,0,0.5)")
        .moveTo(hx + R * 0.16, -w * 0.98).quadraticCurveTo(hx + bow + R * 0.16, 0, hx + R * 0.16, w * 0.98).endStroke();
      // 鋲
      [-0.62, 0.62].forEach(function (fy) {
        var rx2 = hx + bow * (1 - fy * fy), ry2 = w * fy;
        g.beginFill("#1b1f26").drawCircle(rx2, ry2, 2.4);
        g.beginFill("rgba(200,214,232,0.5)").drawCircle(rx2 - 0.8, ry2 - 0.8, 1);
      });
    });

    // 口の内側(玉が呑まれる暗い穴)。奥ほど黒く、上側の内壁にだけ月光が回る
    g.beginRadialGradientFill(["#000", "#150c05", "#2a1a0b"], [0.3, 0.75, 1],
      RX * 0.5, -WE * 0.2, 2, 0, 0, WE)
      .drawEllipse(-RX, -WE, RX * 2, WE * 2);
    g.setStrokeStyle(2.6, "round").beginStroke("rgba(190,140,80,0.3)");
    ellipseArcCV(g, 0, 0, RX * 0.62, WE * 0.66, Math.PI * 0.62, Math.PI * 1.38, 14);
    g.endStroke();

    // 胴は Shape をローカル座標で焼く。crisis.js の呼吸は back(Container)の
    // transform を変えるだけなので、焼いたビットマップがそのまま拡縮される。
    body.cache(-RX - 6, -(WM + 6), BH + WE * 0.6 + RX + 12, (WM + 6) * 2);
    back.addChild(body);
    PP.layers.path.addChild(back);

    // --- 手前のレイヤー: 口の縁(玉を隠して"沈んで"見せる) ---
    var front = new createjs.Container();
    front.x = end.x; front.y = end.y; front.rotation = ang;
    var rim = new createjs.Shape();
    var fg = rim.graphics;
    // 樫の縁 → 真鍮のたが → 月光の照り。玉はこの縁の下へ潜って消える
    fg.setStrokeStyle(R * 0.5, "round").beginStroke(OAK.DARK)
      .drawEllipse(-RX, -WE, RX * 2, WE * 2).endStroke();
    fg.setStrokeStyle(R * 0.3, "round").beginStroke(OAK.BODY)
      .drawEllipse(-RX, -WE, RX * 2, WE * 2).endStroke();
    fg.setStrokeStyle(3, "round").beginStroke(OAK.BRASS)
      .drawEllipse(-RX - 2.6, -WE - 2.6, RX * 2 + 5.2, WE * 2 + 5.2).endStroke();
    fg.setStrokeStyle(1.4, "round").beginStroke(OAK.BRASS_LIT);
    ellipseArcCV(fg, 0, 0, RX + 3.4, WE + 3.4, Math.PI * 1.04, Math.PI * 1.92, 16);
    fg.endStroke();
    fg.setStrokeStyle(1.6, "round").beginStroke("rgba(190,214,240,0.35)");
    ellipseArcCV(fg, 0, 0, RX + 4.6, WE + 4.6, Math.PI * 1.1, Math.PI * 1.86, 16);
    fg.endStroke();
    rim.cache(-(RX + R * 0.3 + 8), -(WE + R * 0.3 + 8),
      (RX + R * 0.3 + 8) * 2, (WE + R * 0.3 + 8) * 2);
    front.addChild(rim);
    PP.layers.barrel.addChild(front);

    // ドクロ(道の終着点の印)。単体だと背景に埋もれるので、影と冷たい縁取りで
    // 海から切り出す。
    var skull = new createjs.Text("☠",
      'bold 32px "Cinzel","Hiragino Kaku Gothic ProN",serif', "#f0e6c8");
    skull.textAlign = "center";
    skull.textBaseline = "middle";
    skull.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    skull.x = end.x + end.tx * (BH + RX + 30);
    skull.y = end.y + end.ty * (BH + RX + 30);
    // shadowBlur 付きの Text は描くたびにぼかし計算が走る上、EaselJS は毎フレーム
    // 描き直すので、一度ビットマップへ焼く。crisis/gameover の拡大・脈動は焼いた
    // ビットマップの scale で表現でき(最大2倍近くまで上がるので cacheScale=2 で
    // 高解像度に焼く)、色替えだけは PP.setSkullColor 経由で焼き直す。
    var kb = skull.getBounds();
    skull.cache(kb.x - 10, kb.y - 10, kb.width + 20, kb.height + 24, 2);
    PP.regFontCache(skull);
    PP.layers.barrel.addChild(skull);

    // 危機/ゲームオーバー演出が読む樽パーツ。mouth は樽の口の座標。
    lane.barrel = { back: back, front: front, skull: skull, mouth: { x: end.x, y: end.y } };
  }

  // ドクロの色替え(crisis / gameover から使う)。ドクロは cache 済みなので
  // color を代入しただけでは画面に出ない — 変わったときだけ焼き直す。
  // 「変わったときだけ」が肝で、危機演出は毎フレーム色を書き込んでくるが、
  // 実際の色は3値しかないので焼き直しは危機の段が変わる瞬間だけで済む
  PP.setSkullColor = function (sk, c) {
    if (sk.color === c) return;
    sk.color = c;
    if (sk.cacheCanvas) sk.updateCache();
  };

  // レーン1本ぶんの静的な作画を、buildCourse と同じ順序でまとめて描く。
  // (path/bridge/tunnel/barrel レイヤーは呼び出し側=buildCourse が事前に空にしておく)
  // crossings/laneIndex は石橋のアーチ割り(橋脚を交差点に立てない)にだけ使う。
  // 省略しても描けるが、その場合は橋脚が両端だけ = 単アーチになる。
  function drawLane(lane, crossings, laneIndex) {
    var rail = lane.rail;
    drawRail(rail);
    buildRailFlow(rail);
    drawOverpasses(rail, crossings, laneIndex);
    drawCave(rail);
    buildBarrel(lane);
    drawTunnels(rail);
  }

  PP.courseView = {
    drawLane: drawLane,            // レーン1本の木道・洞窟・橋・樽・トンネルを描く
    updateRailFlow: updateRailFlow, // 溝を流れる光を1フレーム進める(tick から)
    reset: function () { railFlows = []; } // コース組み直し時に流れる光の状態を捨てる
  };
})();
