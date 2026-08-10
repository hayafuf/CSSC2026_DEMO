/* =========================================================
 * ball.js — 玉の描画と色選択
 *
 * 玉は原作準拠の「濃く塗装された砲弾」:
 *   下地   … light→main→dark→edge の放射グラデ(色そのものを見せる層)
 *   spin   … 塗装の合わせ目と細かな傷。転がりが分かるだけの薄さに留める
 *   shade  … 固定光源の陰影・スペキュラ・下端のリムライト・輪郭
 * 陰影は spin の上に固定で重ね、光源が動かないことで「転がっている」
 * 感じを出す。色を洗い流さないよう白のかぶせは最小限にしてある。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var R = PP.R;

  // 回転係数: レール距離 d [px] → 転がり角 [deg]
  PP.SPIN_K = 180 / (Math.PI * R);

  // ---------- 共有スプライト(玉の見た目を一度だけ焼いて全玉で使い回す) ----------
  // 従来は玉 1 個ごとに 4 枚の cache canvas を確保し、下地(body)に至っては非キャッシュ
  // のまま毎フレーム放射グラデを再ラスタライズしていた(玉 40〜100 個ぶん)。ここで
  // 各レイヤーの見た目を色ごとに一度だけ canvas へ焼き、makeView では同じ canvas を
  // 参照する Bitmap を貼るだけにする。
  //
  // さらに、静止レイヤーを焼き込みでまとめて「1 玉 = 3 枚」にする(カーブ等で玉が
  // 密集したときの重ね塗り = overdraw を減らす)。従来の z 順は
  //   body → spin(回転) → rim → fres(加算) → shade
  // だが、spin は内側(<0.72R)だけ、rim/fres は縁(>R-2.7)だけを占め互いに重ならない。
  // したがって body・rim・fres を spin より下の 1 枚「base」に焼いても、spin と rim/fres
  // が重ならない以上ステージ上の見え方は完全に同一になる。fres の加算合成も、fres の弧が
  // 不透明な body の内側(<R)に収まるため、焼き込み時に body へ加算しても・ステージで
  // body へ加算しても同じ結果になる(背景は絡まない)。α/合成モードは base コンテナの
  // 子として与え、cache 時にそのまま焼き込む(EaselJS はコンテナ cache で子の α/合成を
  // 反映する)。結果、毎フレームの「加算合成の 1 枚 + 素の 1 枚」が消える。
  //   新レイヤー: base(body+rim+fres 焼き込み) → spin(回転) → shade
  var CB = R + 2, CS = (R + 2) * 2;          // cache 範囲(中心が原点)
  var baseCanvas = [], shadeCanvas = [];     // 色ごと(初回の makeView で焼く)
  var spinCanvas = null;                     // 塗装の合わせ目(色に依らず共通)

  // DisplayObject(Shape/Container)を玉サイズで焼いて、その cache canvas を返す
  function bake(disp) {
    disp.cache(-CB, -CB, CS, CS);
    return disp.cacheCanvas;
  }

  // 焼いた canvas を中心基準で貼る Bitmap(回転・位置は原点=玉中心まわり)
  function sprite(canvas) {
    var b = new createjs.Bitmap(canvas);
    b.regX = b.regY = CB;
    return b;
  }

  // 色ごとに base(下地+リム+フレネルを焼き込み)と shade を一度だけ焼く
  function bakeColor(colorIndex) {
    var p = PP.PALETTE[colorIndex];

    // base = body → rim(α0.28) → fres(加算 α0.5) を 1 枚に焼き込む。
    // 子の α/合成は cache 時に反映されるので、従来ステージ上で重ねていた見え方と同一。
    var base = new createjs.Container();

    // --- 下地(色そのもの)。中心を左上にずらした放射グラデ ---
    var body = new createjs.Shape();
    body.graphics
      .beginRadialGradientFill([p.light, p.main, p.main, p.dark, p.edge],
        [0, 0.26, 0.58, 0.88, 1],
        -R * 0.32, -R * 0.34, R * 0.06, 0, 0, R)
      .drawCircle(0, 0, R);

    // 下端の色付きリムライト(球感を出す)。色が濃いので薄く重ねる
    var rim = new createjs.Shape();
    rim.graphics.setStrokeStyle(2.4).beginStroke(p.light)
      .arc(0, 0, R - 1.6, Math.PI * 0.18, Math.PI * 0.82).endStroke();
    rim.alpha = 0.28;

    // フレネル(縁の発光)。暗い海から玉を切り出すため、縁に沿って色光を
    // 加算で細く回す。上側(光源側)は弱く、下〜側面で強く光らせる
    var fres = new createjs.Shape();
    fres.compositeOperation = "lighter";
    fres.alpha = 0.5;
    fres.graphics.setStrokeStyle(2.6).beginStroke(p.light)
      .arc(0, 0, R - 1.4, Math.PI * 0.12, Math.PI * 1.55).endStroke();
    fres.graphics.setStrokeStyle(1.3).beginStroke(p.light)
      .arc(0, 0, R - 1.4, Math.PI * 1.55, Math.PI * 2.12).endStroke();

    base.addChild(body, rim, fres);
    baseCanvas[colorIndex] = bake(base);

    // --- 固定の陰影レイヤー(左上から光が当たる球体シェーディング) ---
    // spin より上に来る唯一の静止レイヤーなので、これだけは別 canvas のまま残す。
    var shade = new createjs.Shape();
    var s = shade.graphics;
    // 中央はほぼ素通し、縁に向けて落ちる陰(色を洗い流さない)
    s.beginRadialGradientFill(
        ["rgba(255,250,235,0.10)", "rgba(255,250,235,0.02)", "rgba(0,0,0,0)", "rgba(0,0,0,0.62)"],
        [0, 0.18, 0.5, 1],
        -R * 0.38, -R * 0.42, R * 0.05, 0, 0, R * 1.02)
      .drawCircle(0, 0, R);
    // スペキュラ(小さく硬いハイライト+サブの点)
    s.beginFill("rgba(255,255,255,0.8)")
      .drawEllipse(-R * 0.6, -R * 0.66, R * 0.3, R * 0.2);
    s.beginFill("rgba(255,255,255,0.35)")
      .drawCircle(-R * 0.14, -R * 0.6, R * 0.06);
    // 輪郭(甲板の茶色からシルエットを浮かせる)
    s.setStrokeStyle(1.5).beginStroke("rgba(0,0,0,0.55)").drawCircle(0, 0, R - 0.7);
    shadeCanvas[colorIndex] = bake(shade);
  }

  function bakeSpin() {
    // --- 回転レイヤー: 塗装の合わせ目(帯)と小さな傷 ---
    // 色を濁らせないよう、円の内側 0.72R に収まる範囲だけに描く
    var paint = new createjs.Shape();
    var g = paint.graphics;
    g.setStrokeStyle(R * 0.13).beginStroke("rgba(0,0,0,0.22)")
      .drawEllipse(-R * 0.72, -R * 0.2, R * 1.44, R * 0.4).endStroke();
    g.setStrokeStyle(1).beginStroke("rgba(255,255,255,0.07)")
      .drawEllipse(-R * 0.72, -R * 0.28, R * 1.44, R * 0.4).endStroke();
    g.beginFill("rgba(0,0,0,0.2)").drawCircle(R * 0.38, R * 0.34, R * 0.1);
    g.beginFill("rgba(0,0,0,0.14)").drawCircle(-R * 0.44, R * 0.2, R * 0.07);
    spinCanvas = bake(paint);
  }

  // 玉の表示オブジェクト。cont.spin を回すと塗装の合わせ目が回転する。
  // 中身は共有 canvas を貼る 3 枚の Bitmap だけ(毎フレームの再ラスタライズなし、
  // 加算合成の per-frame ブリットも無し)。見え方は従来の 5 レイヤー版と同一。
  function makeView(colorIndex) {
    if (baseCanvas[colorIndex] === undefined) bakeColor(colorIndex);
    if (!spinCanvas) bakeSpin();

    var cont = new createjs.Container();
    cont.addChild(sprite(baseCanvas[colorIndex]));   // 下地+リム+フレネル(焼き込み)
    var spin = sprite(spinCanvas);                   // 回転する塗装の合わせ目
    cont.addChild(spin);
    cont.addChild(sprite(shadeCanvas[colorIndex]));  // 陰影・スペキュラ・輪郭
    cont.spin = spin;
    return cont;
  }

  // 爆弾(キャッチして装填し、自分で撃つ)。鋳鉄の球+導火線の火花
  function makeBombView() {
    var cont = new createjs.Container();

    var body = new createjs.Shape();
    body.graphics
      .beginRadialGradientFill(["#6b727e", "#2b3038", "#12151a", "#05070a"],
        [0, 0.4, 0.85, 1], -R * 0.34, -R * 0.36, R * 0.06, 0, 0, R)
      .drawCircle(0, 0, R);
    body.graphics.setStrokeStyle(1.5).beginStroke("rgba(0,0,0,0.6)").drawCircle(0, 0, R - 0.7);
    body.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);   // 静的な下地は焼いて再描画を避ける
    cont.addChild(body);

    // 回転レイヤー(転がりが分かるだけの傷)
    var spin = new createjs.Container();
    var scratch = new createjs.Shape();
    scratch.graphics.setStrokeStyle(R * 0.12).beginStroke("rgba(255,255,255,0.06)")
      .drawEllipse(-R * 0.7, -R * 0.24, R * 1.4, R * 0.42).endStroke();
    scratch.graphics.beginFill("rgba(0,0,0,0.35)").drawCircle(R * 0.34, R * 0.3, R * 0.12);
    spin.addChild(scratch);
    spin.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);
    cont.addChild(spin);

    // 導火線と火花(脈打たせる)
    var fuse = new createjs.Shape();
    fuse.graphics.setStrokeStyle(2.4, "round").beginStroke("#c9a86a")
      .moveTo(R * 0.3, -R * 0.85)
      .quadraticCurveTo(R * 0.95, -R * 1.25, R * 0.55, -R * 1.7)
      .endStroke();
    cont.addChild(fuse);
    var spark = new createjs.Shape();
    spark.graphics
      .beginRadialGradientFill(["#fff4c0", "#ff8a2a", "rgba(255,120,20,0)"], [0, 0.45, 1],
        0, 0, 1, 0, 0, R * 0.5)
      .drawCircle(0, 0, R * 0.5);
    spark.x = R * 0.55; spark.y = -R * 1.7;
    cont.addChild(spark);
    createjs.Tween.get(spark, { loop: true })
      .to({ scaleX: 0.6, scaleY: 0.6, alpha: 0.6 }, 160)
      .to({ scaleX: 1.15, scaleY: 1.15, alpha: 1 }, 160);

    // 固定のハイライト(球感)
    var shine = new createjs.Shape();
    shine.graphics.beginFill("rgba(255,255,255,0.7)")
      .drawEllipse(-R * 0.6, -R * 0.66, R * 0.3, R * 0.2);
    cont.addChild(shine);

    cont.spin = spin;
    cont.spark = spark;
    return cont;
  }

  // ミサイル(装填して撃つ・直進貫通)。ガンメタの機体+ブロンズのノーズ+尾の炎。
  // 上向き(発射方向)固定の見た目。砲身に収まるよう玉と同じフットプリントに収める。
  function makeMissileView() {
    var cont = new createjs.Container();

    // 機体(縦長の砲弾型)。爆弾と同じ鋳鉄グレー系で世界観を合わせる
    var body = new createjs.Shape();
    body.graphics
      .beginLinearGradientFill(["#7b828e", "#3a4048", "#14171c"], [0, 0.5, 1],
        -R * 0.42, 0, R * 0.42, 0)
      .moveTo(0, -R * 1.05)                                  // ノーズ先端
      .quadraticCurveTo(R * 0.42, -R * 0.55, R * 0.42, -R * 0.2)
      .lineTo(R * 0.42, R * 0.7)
      .lineTo(-R * 0.42, R * 0.7)
      .lineTo(-R * 0.42, -R * 0.2)
      .quadraticCurveTo(-R * 0.42, -R * 0.55, 0, -R * 1.05)
      .closePath();
    // ノーズコーン(ブロンズ)
    body.graphics
      .beginFill("#b98b3e")
      .moveTo(0, -R * 1.05)
      .quadraticCurveTo(R * 0.36, -R * 0.62, R * 0.38, -R * 0.34)
      .lineTo(-R * 0.38, -R * 0.34)
      .quadraticCurveTo(-R * 0.36, -R * 0.62, 0, -R * 1.05)
      .closePath();
    // フィン×2
    body.graphics
      .beginFill("#20242b")
      .moveTo(R * 0.42, R * 0.2).lineTo(R * 0.85, R * 0.75).lineTo(R * 0.42, R * 0.7).closePath()
      .moveTo(-R * 0.42, R * 0.2).lineTo(-R * 0.85, R * 0.75).lineTo(-R * 0.42, R * 0.7).closePath();
    // ハイライト(左舷の照り返し)
    body.graphics.beginFill("rgba(255,255,255,0.35)")
      .drawRect(-R * 0.3, -R * 0.5, R * 0.12, R * 1.1);
    body.cache(-R - 2, -R * 1.2 - 2, (R + 2) * 2, R * 2.2 + 4);
    cont.addChild(body);

    // 尾の炎(脈打たせる)。爆弾の spark と同じ扱いにして、
    // cannon.js 側の既存のトゥイーン後始末(cont.spark)をそのまま効かせる
    var flame = new createjs.Shape();
    flame.graphics
      .beginRadialGradientFill(["#fff4c0", "#ff8a2a", "rgba(255,120,20,0)"], [0, 0.45, 1],
        0, 0, 1, 0, 0, R * 0.6)
      .drawCircle(0, 0, R * 0.6);
    flame.x = 0; flame.y = R * 0.95;
    flame.scaleY = 1.4;
    cont.addChildAt(flame, 0);
    createjs.Tween.get(flame, { loop: true })
      .to({ scaleX: 0.6, scaleY: 0.9, alpha: 0.65 }, 110)
      .to({ scaleX: 1.1, scaleY: 1.5, alpha: 1 }, 110);

    cont.spark = flame;
    // 汎用の view.spin.rotation 書き込みを無害化する空レイヤー
    cont.spin = new createjs.Container();
    cont.addChild(cont.spin);
    return cont;
  }

  // 波の最後尾に付く宝玉(黄金のオーブ+宝石、光が脈打つ)
  function makeTreasureView() {
    var cont = new createjs.Container();
    var glow = new createjs.Shape();
    glow.graphics
      .beginRadialGradientFill(["rgba(255,220,110,0.6)", "rgba(255,220,110,0)"], [0, 1],
        0, 0, 2, 0, 0, R + 11)
      .drawCircle(0, 0, R + 11);
    cont.addChild(glow);

    var orb = new createjs.Shape();
    orb.graphics
      .beginRadialGradientFill(["#fff3c4", "#f0c040", "#7a520e"], [0, 0.55, 1],
        -R * 0.35, -R * 0.35, R * 0.1, 0, 0, R * 0.92)
      .drawCircle(0, 0, R * 0.92);
    orb.graphics.setStrokeStyle(1.5).beginStroke("#ffe08a").drawCircle(0, 0, R * 0.92);
    orb.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);   // 静的なオーブは焼いて再描画を避ける
    cont.addChild(orb);

    var gem = new createjs.Text("💎", (R) + "px serif");
    gem.textAlign = "center";
    gem.textBaseline = "middle";
    gem.cache(-R, -R, R * 2, R * 2);   // 絵文字グリフの再整形を避ける
    cont.addChild(gem);

    createjs.Tween.get(glow, { loop: true })
      .to({ alpha: 0.25, scaleX: 0.85, scaleY: 0.85 }, 550, createjs.Ease.quadInOut)
      .to({ alpha: 1, scaleX: 1.15, scaleY: 1.15 }, 550, createjs.Ease.quadInOut);
    cont.glow = glow;
    return cont;
  }

  // 装填用: チェーンに残っている色から選ぶ。基本は「盤面に実在する色」を
  // 色ごと重み1で一様に引く(本家Zuma準拠。手詰まりは原理的に起きない)。
  // そのうえで、先頭(樽に一番近い玉 = 最初の非宝玉)の色だけ PICK_FRONT_GAIN 倍に
  // 少しだけ重くして、今まさに危ない先頭色をやや出やすくする。個数や位置カーブ
  // では重み付けしない(倍率は先頭色1つにだけ掛かる)。
  // avoid: すでに装填されている色。今の玉と次の玉が同色になるのを防ぐため、
  //   その色の重みだけ PICK_REPEAT 倍に薄める。0 にはしない: 盤面に1色しか
  //   残っていない終盤は、それしか配れないため。
  function pickColor(avoid) {
    var g = PP.game;
    var lanes = g.lanes;
    // 全レーンの盤面に実在する色だけを候補に、色ごと重み1の一様抽選。
    // 先頭色の底上げは「一番危ないレーン(先頭が自分の樽に最も近いレーン)」の
    // 先頭色だけに掛ける(複数レーンぶん掛けて過剰にならないように)。
    var w = [], total = 0;
    var frontColor = -1, frontRatio = -1;
    for (var li = 0; li < lanes.length; li++) {
      var balls = lanes[li].balls;
      var holeD = lanes[li].rail.holeD || 1;
      var seenFront = false;
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        if (b.treasure) continue;
        if (w[b.color] === undefined) { w[b.color] = 1; total += 1; }
        if (!seenFront) {
          seenFront = true;
          var ratio = b.d / holeD;                 // 樽への近さ(危険度)
          if (ratio > frontRatio) { frontRatio = ratio; frontColor = b.color; }
        }
      }
    }
    // 一番危ないレーンの先頭色だけ少し重くする
    if (frontColor >= 0) {
      total += w[frontColor] * (PP.PICK_FRONT_GAIN - 1);
      w[frontColor] *= PP.PICK_FRONT_GAIN;
    }
    // すでに手元にある色を薄める(手札が同じ色2個になるのを防ぐ)
    if (avoid !== undefined && avoid !== null && w[avoid] !== undefined) {
      total -= w[avoid] * (1 - PP.PICK_REPEAT);
      w[avoid] *= PP.PICK_REPEAT;
    }
    if (total <= 0) return Math.floor(Math.random() * g.nColors);
    var r = Math.random() * total;
    for (var c = 0; c < w.length; c++) {
      if (w[c] === undefined) continue;
      r -= w[c];
      if (r <= 0) return c;
    }
    return Math.floor(Math.random() * g.nColors);
  }

  // 補給用: 直前の色を確率で引き継いで「同色の塊」を作る。
  // 自然発生した3連以上は消えない(chain.js のマッチ判定はイベント駆動)ため、
  // 原作同様に同色が並んだ列がそのまま流れてくる。
  function spawnColor(lane) {
    var g = PP.game;
    var balls = lane.balls;
    var n = balls.length;
    // 塊率はコース定義の spawnCluster で上書きできる(例: コース5は4レーンに
    // 注意が割れるぶん、塊を濃くして1レーンあたりの消しやすさを上げる)
    var cluster = (g.builtCourse && g.builtCourse.spawnCluster) || PP.SPAWN_CLUSTER;
    // 直前が宝玉(= 前の波の末尾)なら塊は引き継がない
    if (n > 0 && !balls[n - 1].treasure && Math.random() < cluster) {
      var last = balls[n - 1].color;
      var run = 1;
      while (run < PP.SPAWN_RUN_MAX && n - run - 1 >= 0 &&
             balls[n - run - 1].color === last) run++;
      if (run < PP.SPAWN_RUN_MAX) return last;  // 長くなりすぎたら塊を打ち切る
    }
    return Math.floor(Math.random() * g.nColors);
  }

  PP.ball = {
    makeView: makeView,
    makeBombView: makeBombView,
    makeMissileView: makeMissileView,
    makeTreasureView: makeTreasureView,
    pickColor: pickColor,
    spawnColor: spawnColor
  };
})();
