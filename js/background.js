/* =========================================================
 * background.js — 動く夜の海(映画的ライティング)
 *
 * 旧 main.js の静的な背景を引き取り、"動き" を足した版。
 *   静的な下地(深海グラデ・遠景の波帯・色調・月光ヴィネット)は .cache() して
 *   毎フレームのベクタ再描画を避け、その上に動く要素だけを重ねる:
 *     god ray(月の光条) / パララックス波頭 / 水面コースティクス /
 *     漂う霧 / 立ち上る光の塵 / 稀な遠雷。
 * 描画は stage.update(main の tick)に集約されているので、動きは
 *   PP.bg.update(dt) の中でプロパティ(x / alpha 等)を進めて表現する。
 * 背景は画面揺れ(shake)の対象外 = パララックスは据え置きで安定して見える。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var W = PP.W, H = PP.H;
  var MOON_X = W * 0.62;          // 月と、その海面反射の中心
  var MOON_Y = -30;

  // update から触る動的パーツ(build で詰める)
  var waves = [];                 // パララックス波頭ストリップ {c, speed}
  var fogs = [];                  // 漂う霧 {s, speed, baseA, phase}
  var rays = null;                // god ray コンテナ
  var rayList = [];               // 各光条 {s, baseA, phase, amp}
  var motes = [];                 // 立ち上る光の塵 {s, vx, vy, life, max}
  var moteLayer = null;
  var lightning = null;           // 遠雷フラッシュ
  var lightTimer = 6;             // 次の雷までの残り秒
  var T = 0;                      // 累積時間

  // ボス戦(嵐の海)オーバーレイ。通常の夜景の上に重ね、alpha でクロスフェード
  var bgCont = null;              // 背景全体の入れ物(通常+嵐)
  var bossMode = false;
  var bossCont = null;            // 嵐オーバーレイ(初回の setBossMode(true) で遅延構築)
  var bossLightning = null;       // 血色の稲妻フラッシュ
  var bossFogs = [];              // 嵐雲 {s, speed, phase, w}
  var whirl = null;               // ボス足元の渦(回転)

  function build() {
    var stage = PP.stage;
    var bg = new createjs.Container();
    bgCont = bg;
    bg.mouseEnabled = false;

    // ---- 静的な下地(深海グラデ + 水平線の霞 + 遠景のうねり + 月の反射) ----
    var sea = new createjs.Shape();
    var g = sea.graphics;
    g.beginLinearGradientFill(
        ["#12293a", "#0e2233", "#0a1a29", "#06121c", "#030810"],
        [0, 0.24, 0.52, 0.8, 1], 0, 0, 0, H)
      .drawRect(0, 0, W, H);
    // 水平線の霞(奥の月明かりが海霧に散る帯)
    g.beginLinearGradientFill(
        ["rgba(150,185,210,0.34)", "rgba(95,130,160,0.10)", "rgba(0,0,0,0)"],
        [0, 0.5, 1], 0, 0, 0, 120).drawRect(0, 0, W, 120);

    // 遠景の静的なうねり(手前ほど大きく暗い帯を重ね、稜線に月光の照り)
    var BANDS = 13;
    for (var bi = 0; bi < BANDS; bi++) {
      var t = bi / (BANDS - 1);
      var yBase = 78 + t * t * (H - 30);
      var amp = 2 + t * 14;
      var wl = 150 + t * 240;
      var ph = bi * 1.7;
      var r = Math.round(24 - 20 * t), gg = Math.round(54 - 42 * t), b = Math.round(80 - 58 * t);
      g.beginFill("rgb(" + r + "," + gg + "," + b + ")");
      g.moveTo(-30, yBase);
      for (var x = -30; x <= W + 30; x += wl) {
        g.quadraticCurveTo(x + wl * 0.5, yBase - amp - Math.sin(x + ph) * amp * 0.3,
                           x + wl, yBase + Math.sin(x * 0.7 + ph) * amp * 0.25);
      }
      g.lineTo(W + 30, H); g.lineTo(-30, H); g.closePath();
      var a = (0.05 + (1 - t) * 0.18).toFixed(3);
      g.setStrokeStyle(1 + t * 0.8, "round").beginStroke("rgba(190,214,236," + a + ")");
      g.moveTo(-30, yBase);
      for (x = -30; x <= W + 30; x += wl) {
        g.quadraticCurveTo(x + wl * 0.5, yBase - amp - Math.sin(x + ph) * amp * 0.3,
                           x + wl, yBase + Math.sin(x * 0.7 + ph) * amp * 0.25);
      }
      g.endStroke();
    }
    // 月明かりの海面反射(中心ほど明るい光柱を横帯で刻む)
    for (var ry = 130; ry < H; ry += 9 + (ry / H) * 20) {
      var tt = ry / H;
      var halfW = 26 + tt * tt * 150;
      var alpha = (0.16 * (1 - tt * 0.7) * (0.5 + 0.5 * Math.sin(ry * 0.6))).toFixed(3);
      if (alpha <= 0.01) continue;
      var hh = 1.5 + tt * 4;
      g.beginRadialGradientFill(
        ["rgba(216,230,247," + alpha + ")", "rgba(216,230,247,0)"], [0, 1],
        MOON_X, ry, 2, MOON_X, ry, halfW)
        .drawEllipse(MOON_X - halfW, ry - hh, halfW * 2, hh * 2);
    }
    // ---- 色調(フィルミックなグレード: 影を青緑へ、月光を冷たい銀へ) ----
    // soft-light 合成の全画面矩形。soft-light は Canvas2D で最も高い部類の
    // CPU ブレンドで、cache しても「画面に描くとき」の合成だけは毎フレーム
    // 走ってしまう(全画面 = 約91万px/フレーム)。海もグレードも静的なので、
    // 起動時に2枚まとめて1枚のビットマップへ焼き込み、以後は素の drawImage
    // 1回にする。以前は上に重なる波・霧・粒にもうっすら掛かっていたが、
    // どれも alpha 0.1 前後の淡い光なので焼き込み後との見た目の差は出ない
    var grade = new createjs.Shape();
    grade.graphics.beginLinearGradientFill(
        ["rgba(150,180,200,0.12)", "rgba(20,50,70,0.10)"],
        [0, 1], 0, 0, 0, H).drawRect(0, 0, W, H);
    grade.compositeOperation = "soft-light";
    var base = new createjs.Container();
    base.addChild(sea);
    base.addChild(grade);
    base.cache(0, 0, W, H);   // sea 自身の cache は不要(この1枚に含まれる)
    bg.addChild(base);

    // ---- 合成モードごとの層分け(Stage 5) ----
    // StageGL(携帯)は lighter⇔通常 の境界ごとに flush(draw call)するので、
    // 以前の「光条(lighter)→波(通常)→コースティクス(lighter)→霧(通常)→
    // 塵(lighter)→月光(通常)→月+稲光(lighter)」という交互配置は背景だけで
    // 7 回の flush を生んでいた。通常合成の物(波・霧・月光の周辺減光)を先に
    // 全部積み、発光物(光条・コースティクス・塵・月・稲光)は 1 つの lighter
    // Container にまとめて最後に積むと境界は 1 回になる。
    // 見た目の差は「発光物が周辺減光(light)の上に来る」ことだけで、発光物は
    // どれも月の周りと海面の淡い光なので暗がりに沈まなくなる程度の変化
    var glow = new createjs.Container();
    glow.mouseEnabled = glow.mouseChildren = false;
    glow.compositeOperation = "lighter";

    // ---- god ray(月から差し込む光条。ゆっくり揺れて明滅する) ----
    rays = new createjs.Container();
    rays.mouseEnabled = false;
    rays.x = MOON_X; rays.y = MOON_Y;
    var RAYN = 6;
    for (var i = 0; i < RAYN; i++) {
      var s = new createjs.Shape();
      var spread = (i - (RAYN - 1) / 2) * 12;   // 中心から扇状に
      var len = H * 1.15;
      var halfTop = 3, halfBot = 34 + Math.random() * 26;
      s.graphics.beginLinearGradientFill(
          ["rgba(180,205,232,0.18)", "rgba(150,185,215,0.05)", "rgba(150,185,215,0)"],
          [0, 0.55, 1], 0, 0, 0, len)
        .moveTo(-halfTop, 0).lineTo(halfTop, 0)
        .lineTo(halfBot + spread, len).lineTo(-halfBot + spread, len).closePath();
      s.rotation = spread * 0.5;
      s.cache(-halfBot + spread - 4, -4, (halfBot + Math.abs(spread)) * 2 + 8, len + 8);
      rays.addChild(s);
      rayList.push({ s: s, baseA: 0.5 + Math.random() * 0.5, phase: Math.random() * 6.28, amp: 0.3 + Math.random() * 0.25, baseRot: s.rotation });
    }
    glow.addChild(rays);

    // ---- パララックス波頭(横に流れる。手前ほど速く大きい) ----
    // wl は W を割り切る値にして、-W ずれたら +W で継ぎ目なくループさせる
    var waveDefs = [
      { y: H * 0.50, amp: 5,  wl: W / 7, col: "rgba(150,180,205,0.16)", lw: 1.4, speed: 10 },
      { y: H * 0.66, amp: 8,  wl: W / 5, col: "rgba(170,200,224,0.20)", lw: 1.8, speed: 18 },
      { y: H * 0.84, amp: 13, wl: W / 4, col: "rgba(196,220,242,0.24)", lw: 2.3, speed: 30 }
    ];
    waveDefs.forEach(function (d) {
      var c = new createjs.Shape();
      var wg = c.graphics;
      wg.setStrokeStyle(d.lw, "round").beginStroke(d.col);
      wg.moveTo(0, d.y + Math.sin(0) * d.amp);
      for (var x = 0; x <= W * 2; x += 8) {
        wg.lineTo(x, d.y + Math.sin(x / d.wl * Math.PI * 2) * d.amp
                        + Math.sin(x / d.wl * 5.3) * d.amp * 0.25);
      }
      wg.endStroke();
      c.cache(0, d.y - d.amp - 6, W * 2, d.amp * 2 + 12);
      c.x = 0;
      bg.addChild(c);
      waves.push({ c: c, speed: d.speed });
    });

    // ---- 水面コースティクス(月光柱の上で瞬く粒。加算合成できらめく) ----
    var caustics = new createjs.Container();
    caustics.mouseEnabled = false;
    for (var ci = 0; ci < 20; ci++) {
      var m = new createjs.Shape();
      var w = 2 + Math.random() * 7, h = 0.7 + Math.random() * 1.3;
      m.graphics.beginRadialGradientFill(
        ["rgba(216,232,250,0.9)", "rgba(216,232,250,0)"], [0, 1], 0, 0, 0, 0, 0, w)
        .drawEllipse(-w, -h, w * 2, h * 2);
      // 小さくてもグラデ塗りの再実行は積もる(20個×毎フレーム)。一度焼けば
      // 以後は alpha/x/y が動くだけなので純粋な drawImage になる
      m.cache(-w - 1, -h - 1, w * 2 + 2, h * 2 + 2);
      caustics.addChild(m);
      resetGlint(m);
      twinkleGlint(m);
    }
    glow.addChild(caustics);

    // ---- 漂う霧/靄(手前を横切ってゆっくり流れる) ----
    var fogDefs = [
      { y: H * 0.30, w: 520, h: 130, a: 0.05, speed: 7 },
      { y: H * 0.58, w: 680, h: 180, a: 0.06, speed: 12 },
      { y: H * 0.86, w: 820, h: 210, a: 0.07, speed: 20 }
    ];
    fogDefs.forEach(function (d, i) {
      var s = new createjs.Shape();
      s.graphics.beginRadialGradientFill(
        ["rgba(150,175,200," + d.a + ")", "rgba(140,168,195," + (d.a * 0.5).toFixed(3) + ")", "rgba(140,168,195,0)"],
        [0, 0.55, 1], 0, 0, 0, 0, 0, d.w / 2)
        .drawEllipse(-d.w / 2, -d.h / 2, d.w, d.h);
      s.scaleY = d.h / d.w;
      s.y = d.y;
      s.x = (i * 0.4) * W;
      // 描いた楕円は縦 d.h しかないので、cache の高さも d.h+4 で足りる。
      // (以前は高さにも d.w を使っていて、1枚あたり約4倍の透明画素を
      //  毎フレーム合成していた — 見えない部分にも合成コストは掛かる)
      s.cache(-d.w / 2 - 2, -d.h / 2 - 2, d.w + 4, d.h + 4);
      bg.addChild(s);
      fogs.push({ s: s, speed: d.speed, baseA: 1, phase: Math.random() * 6.28, w: d.w });
    });

    // ---- 立ち上る光の塵(海面から昇ってゆっくり消える) ----
    moteLayer = new createjs.Container();
    moteLayer.mouseEnabled = false;
    for (var mi = 0; mi < 16; mi++) {
      var mo = new createjs.Shape();
      var mr = 1 + Math.random() * 1.8;
      mo.graphics.beginRadialGradientFill(
        ["rgba(210,228,248,0.9)", "rgba(190,214,240,0)"], [0, 1], 0, 0, 0, 0, 0, mr)
        .drawCircle(0, 0, mr);
      mo.cache(-mr - 1, -mr - 1, mr * 2 + 2, mr * 2 + 2);   // caustics と同じ理由
      moteLayer.addChild(mo);
      motes.push(resetMote({ s: mo }, true));
    }
    glow.addChild(moteLayer);

    // ---- 月光と周辺減光(奥・上方の月から差し、周辺を沈めて舞台を締める) ----
    var light = new createjs.Shape();
    light.graphics.beginRadialGradientFill(
        ["rgba(170,200,224,0.18)", "rgba(120,150,180,0.05)", "rgba(0,0,0,0)", "rgba(0,0,0,0.58)"],
        [0, 0.26, 0.58, 1],
        MOON_X, -30, 30, MOON_X, H * 0.22, Math.max(W, H) * 0.95)
      .drawRect(0, 0, W, H);
    light.cache(0, 0, W, H);
    bg.addChild(light);
    createjs.Tween.get(light, { loop: true })
      .to({ alpha: 0.84 }, 4600, createjs.Ease.quadInOut)
      .to({ alpha: 1 }, 4600, createjs.Ease.quadInOut);

    // 月そのもの(かすんだ円盤 + ハロー)
    var moon = new createjs.Shape();
    moon.graphics
      .beginRadialGradientFill(["rgba(226,236,250,0.5)", "rgba(200,220,244,0.12)", "rgba(200,220,244,0)"],
        [0, 0.4, 1], MOON_X, 46, 6, MOON_X, 46, 120).drawCircle(MOON_X, 46, 120)
      .beginRadialGradientFill(["#f4f7ff", "#cdd9ef", "#8ea6c8"], [0, 0.7, 1],
        MOON_X - 8, 40, 4, MOON_X, 46, 34).drawCircle(MOON_X, 46, 32);
    moon.cache(MOON_X - 124, -80, 248, 248);
    glow.addChild(moon);

    // ---- 遠雷フラッシュ(稀。画面全体=コース全域を一瞬だけ冷色で照らす) ----
    // 上ほど強く、手前(下)まで届かせて盤面全体が瞬く。加算合成で稲光らしく。
    lightning = new createjs.Shape();
    lightning.graphics.beginLinearGradientFill(
        ["rgba(210,228,255,0.85)", "rgba(160,192,236,0.42)", "rgba(120,160,210,0.2)"],
        [0, 0.5, 1], 0, 0, 0, H).drawRect(0, 0, W, H);
    lightning.alpha = 0;
    lightning.cache(0, 0, W, H);
    glow.addChild(lightning);
    // 発光層は最後(通常合成の物すべての上)
    bg.addChild(glow);

    // 盤面(path)より下へ。海面のすぐ上でループする
    stage.addChildAt(bg, 0);
  }

  // ---------- ボス戦の嵐の海(通常の夜景の上に重ねるオーバーレイ) ----------
  // 通常背景はそのまま残し、上に「暗転した空・血色の月・嵐雲・渦」を重ねて
  // alpha 0⇄1 のクロスフェードで切り替える。波頭や光の塵がうっすら透けるのは
  // 「嵐でも海は動いている」表現としてそのまま活かす。
  function buildBossScene() {
    bossCont = new createjs.Container();
    bossCont.mouseEnabled = false;
    bossCont.alpha = 0;

    // 暗転した空と海(血の気を帯びた闇で全体を沈める)
    var sky = new createjs.Shape();
    sky.graphics.beginLinearGradientFill(
        ["rgba(26,15,22,0.92)", "rgba(18,10,18,0.84)", "rgba(7,10,16,0.72)", "rgba(3,5,10,0.66)"],
        [0, 0.24, 0.6, 1], 0, 0, 0, H)
      .drawRect(0, 0, W, H);
    // 血色の月の海面反射(赤い光柱。通常の銀の反射を上書きする)
    for (var ry = 130; ry < H; ry += 12 + (ry / H) * 22) {
      var tt = ry / H;
      var halfW = 24 + tt * tt * 140;
      var alpha = (0.15 * (1 - tt * 0.6) * (0.5 + 0.5 * Math.sin(ry * 0.6))).toFixed(3);
      if (alpha <= 0.01) continue;
      var hh = 1.5 + tt * 4;
      sky.graphics.beginRadialGradientFill(
        ["rgba(214,60,44," + alpha + ")", "rgba(214,60,44,0)"], [0, 1],
        MOON_X, ry, 2, MOON_X, ry, halfW)
        .drawEllipse(MOON_X - halfW, ry - hh, halfW * 2, hh * 2);
    }
    sky.cache(0, 0, W, H);
    bossCont.addChild(sky);

    // 血色の月(通常の月を塗り替える。禍々しいハロー付き)
    var moon = new createjs.Shape();
    moon.graphics
      .beginRadialGradientFill(["rgba(194,40,30,0.55)", "rgba(150,26,22,0.16)", "rgba(150,26,22,0)"],
        [0, 0.4, 1], MOON_X, 46, 6, MOON_X, 46, 130).drawCircle(MOON_X, 46, 130)
      .beginRadialGradientFill(["#ff6a50", "#c22820", "#5a0c0a"], [0, 0.6, 1],
        MOON_X - 8, 40, 4, MOON_X, 46, 34).drawCircle(MOON_X, 46, 32)
      // 月面の翳り(不吉な模様)
      .beginFill("rgba(60,8,8,0.35)")
      .drawCircle(MOON_X - 10, 38, 8).drawCircle(MOON_X + 9, 52, 6).drawCircle(MOON_X - 2, 58, 4);
    moon.cache(MOON_X - 134, -90, 268, 268);
    bossCont.addChild(moon);

    // 嵐雲(低く速く流れる。血色の照り返し)
    var cloudDefs = [
      { y: H * 0.10, w: 720, h: 150, a: 0.11, speed: 34 },
      { y: H * 0.20, w: 880, h: 180, a: 0.09, speed: 46 },
      { y: H * 0.15, w: 620, h: 130, a: 0.10, speed: 40 }
    ];
    cloudDefs.forEach(function (d, i) {
      var s = new createjs.Shape();
      s.graphics.beginRadialGradientFill(
        ["rgba(70,22,30," + d.a + ")", "rgba(40,14,22," + (d.a * 0.6).toFixed(3) + ")", "rgba(40,14,22,0)"],
        [0, 0.55, 1], 0, 0, 0, 0, 0, d.w / 2)
        .drawEllipse(-d.w / 2, -d.h / 2, d.w, d.h);
      s.scaleY = d.h / d.w;
      s.y = d.y;
      s.x = (i * 0.37) * W;
      // 霧(fogs)と同じ: 縦は d.h ぶんしか描いていないので cache もその高さで
      s.cache(-d.w / 2 - 2, -d.h / 2 - 2, d.w + 4, d.h + 4);
      bossCont.addChild(s);
      bossFogs.push({ s: s, speed: d.speed, phase: Math.random() * 6.28, w: d.w });
    });

    // ボスの足元の渦(ボスとレーンの間の「開けた海」帯。update で回す)
    whirl = new createjs.Container();
    whirl.mouseEnabled = false;
    whirl.x = W / 2; whirl.y = 190;
    var spiral = new createjs.Shape();
    var sg = spiral.graphics;
    for (var arm = 0; arm < 3; arm++) {
      sg.setStrokeStyle(2.5 - arm * 0.5, "round")
        .beginStroke("rgba(120,160,180," + (0.22 - arm * 0.05).toFixed(2) + ")");
      var a0 = arm * (Math.PI * 2 / 3);
      sg.moveTo(Math.cos(a0) * 14, Math.sin(a0) * 5);
      for (var st = 1; st <= 40; st++) {
        var ang = a0 + st * 0.28;
        var rad = 14 + st * 5.2;
        sg.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad * 0.32);
      }
      sg.endStroke();
    }
    spiral.cache(-230, -80, 460, 160);
    whirl.addChild(spiral);
    bossCont.addChild(whirl);

    // 渦の上の暗霧(ボスの足元を隠して距離感をぼかす)
    var mist = new createjs.Shape();
    mist.graphics.beginRadialGradientFill(
        ["rgba(10,14,20,0.5)", "rgba(10,14,20,0.24)", "rgba(10,14,20,0)"], [0, 0.6, 1],
        0, 0, 0, 0, 0, 420)
      .drawEllipse(-420, -70, 840, 140);
    mist.x = W / 2; mist.y = 195;
    mist.cache(-424, -74, 848, 148);
    bossCont.addChild(mist);

    // 血色の稲妻(通常の冷色版とは別に持ち、ボス中はこちらだけ光る)
    bossLightning = new createjs.Shape();
    bossLightning.graphics.beginLinearGradientFill(
        ["rgba(255,214,200,0.9)", "rgba(236,120,96,0.45)", "rgba(180,60,50,0.2)"],
        [0, 0.5, 1], 0, 0, 0, H).drawRect(0, 0, W, H);
    bossLightning.compositeOperation = "lighter";
    bossLightning.alpha = 0;
    bossLightning.cache(0, 0, W, H);
    bossCont.addChild(bossLightning);

    bgCont.addChild(bossCont);
  }

  // ボス戦モードの切替(main.js startLevel から)。1.2秒のクロスフェード。
  // リトライで同じモードを再指定されても Tween が override で吸収する(冪等)
  function setBossMode(on) {
    on = !!on;
    if (on && !bossCont) buildBossScene();
    if (!bossCont || bossMode === on) return;
    bossMode = on;
    createjs.Tween.get(bossCont, { override: true })
      .to({ alpha: on ? 1 : 0 }, 1200, createjs.Ease.quadInOut);
    lightTimer = on ? 2 + Math.random() * 3 : 6;
  }

  // --- コースティクス(月光柱上の瞬き) ---
  function resetGlint(m) {
    m.y = H * 0.34 + Math.random() * H * 0.60;
    var tt = (m.y - H * 0.34) / (H * 0.60);
    var spread = 34 + tt * tt * 200;
    m.x = MOON_X + (Math.random() - 0.5) * spread * 2;
    m.alpha = 0;
  }
  // 瞬きは Tween ではなく update 内の位相駆動にする。以前は「2 つの Tween+
  // コールバック」を瞬きのたびに作り直していて(20 粒×約 2.5 秒周期)、
  // 永久に毎秒十数個の Tween オブジェクトがゴミになっていた
  var glints = [];
  function twinkleGlint(m) {
    glints.push({ m: m, t: 0, dur: 0.9 + Math.random() * 1.6,
                  peak: 0.4 + Math.random() * 0.5, x0: m.x,
                  dx: (Math.random() - 0.5) * 10 });
  }
  function updateGlints(dt) {
    for (var i = 0; i < glints.length; i++) {
      var gl = glints[i];
      gl.t += dt;
      var k = gl.t / gl.dur;           // 0→1 で上り、1→2 で下る(計 2×dur)
      if (k >= 2) {
        resetGlint(gl.m);
        gl.t = 0; gl.dur = 0.9 + Math.random() * 1.6;
        gl.peak = 0.4 + Math.random() * 0.5; gl.x0 = gl.m.x;
        gl.dx = (Math.random() - 0.5) * 10;
        continue;
      }
      var u = k < 1 ? k : 2 - k;       // 三角波
      var e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);   // quadInOut
      gl.m.alpha = gl.peak * e;
      gl.m.x = gl.x0 + gl.dx * (k < 1 ? e : 1);
    }
  }

  // --- 光の塵 ---
  function resetMote(mo, initial) {
    mo.s.x = Math.random() * W;
    mo.s.y = initial ? (H * 0.35 + Math.random() * H * 0.6) : (H * 0.72 + Math.random() * H * 0.28);
    mo.vx = (Math.random() - 0.5) * 6;
    mo.vy = -(5 + Math.random() * 12);
    mo.max = 5 + Math.random() * 6;        // 寿命(秒)
    mo.life = initial ? Math.random() * mo.max : 0;
    mo.s.alpha = 0;
    return mo;
  }

  function update(dt) {
    if (dt > 0.1) dt = 0.1;
    T += dt;
    updateGlints(dt);   // コースティクスの瞬き(Tween を使わない位相駆動)

    // パララックス波頭: 左へ流し、-W 越えたら +W で継ぎ目なく戻す
    for (var i = 0; i < waves.length; i++) {
      var w = waves[i];
      w.c.x -= w.speed * dt;
      if (w.c.x <= -W) w.c.x += W;
    }
    // god ray: 全体をゆっくり首振り + 各条の明滅
    if (rays) {
      rays.rotation = Math.sin(T * 0.18) * 2.2;
      for (var r = 0; r < rayList.length; r++) {
        var ry = rayList[r];
        ry.s.alpha = Math.max(0, ry.baseA + Math.sin(T * 0.5 + ry.phase) * ry.amp);
      }
    }
    // 霧: 横流し(ラップ)+ 濃度のゆらぎ
    for (var f = 0; f < fogs.length; f++) {
      var fo = fogs[f];
      fo.s.x += fo.speed * dt;
      if (fo.s.x > W + fo.w) fo.s.x = -fo.w;
      fo.s.alpha = 0.7 + 0.3 * Math.sin(T * 0.3 + fo.phase);
    }
    // 低負荷モード(main.js の低FPS検知): 光の塵は数が多いわりに見た目の
    // 寄与が小さいので、まっさきに水を抜く(復帰したら自然に再開する)
    if (PP.quality === 0 && !PP.PERF.LOW.motes) {
      if (moteLayer && moteLayer.visible) moteLayer.visible = false;
    } else if (moteLayer && !moteLayer.visible) {
      moteLayer.visible = true;
    }
    // 光の塵: 上昇して寿命で消える(隠している間は動かす必要もない)
    for (var m = 0; m < motes.length && moteLayer.visible; m++) {
      var mo = motes[m];
      mo.life += dt;
      if (mo.life >= mo.max) { resetMote(mo, false); continue; }
      mo.s.x += mo.vx * dt;
      mo.s.y += mo.vy * dt;
      var k = mo.life / mo.max;
      mo.s.alpha = Math.sin(k * Math.PI) * 0.7;   // 出て消える
    }
    // 嵐の海(ボス戦オーバーレイ)の動き
    if (bossCont && bossCont.alpha > 0.01) {
      if (whirl) whirl.rotation += dt * 26;   // 渦はゆっくり回り続ける
      for (var bf = 0; bf < bossFogs.length; bf++) {
        var bo = bossFogs[bf];
        bo.s.x += bo.speed * dt;
        if (bo.s.x > W + bo.w) bo.s.x = -bo.w;
        bo.s.alpha = 0.75 + 0.25 * Math.sin(T * 0.5 + bo.phase);
      }
    }

    // 遠雷: たまに二連フラッシュ(ボス中は血色の稲妻が3〜8秒間隔で暴れる)
    lightTimer -= dt;
    var bolt = bossMode ? bossLightning : lightning;
    if (lightTimer <= 0 && bolt && bolt.alpha < 0.01) {
      lightTimer = bossMode ? (3 + Math.random() * 5) : (9 + Math.random() * 14);
      createjs.Tween.get(bolt, { override: true })
        .to({ alpha: bossMode ? 0.6 : 0.5 }, 60)
        .to({ alpha: 0.06 }, 90)
        .to({ alpha: bossMode ? 0.5 : 0.4 }, 55)
        .to({ alpha: 0 }, 320, createjs.Ease.quadOut);
    }
  }

  PP.bg = { build: build, update: update, setBossMode: setBossMode, MOON_X: MOON_X };
})();
