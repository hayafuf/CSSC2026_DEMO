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

  // ---- 付属物(骸骨リング・万能玉のグロー・爆弾の導火線と火花)の共有 canvas ----
  // 【なぜ】これらは以前、玉ごとに非 cache の Shape(放射グラデ)を持っていた。
  // Canvas 2D では玉の数ぶん毎フレームのグラデ再ラスタライズになり、
  // StageGL(携帯)では非 cache の Shape は描かれない=そもそも見えていなかった。
  // 見た目は全玉で同じなので、一度だけ焼いた canvas を全インスタンスで共有する
  // (テクスチャは 1 枚。ball の base/shade と同じ発想)。
  // draw(g) にパスを描かせ、half=正方形の半幅で焼く。Bitmap は中心基準
  var partCanvas = {};
  function bakePart(key, half, draw) {
    var c = partCanvas[key];
    if (!c) {
      var sh = new createjs.Shape();
      draw(sh.graphics);
      sh.cache(-half, -half, half * 2, half * 2);
      c = partCanvas[key] = sh.cacheCanvas;
      c._half = half;
    }
    return c;
  }
  function partSprite(key, half, draw) {
    var c = bakePart(key, half, draw);
    var b = new createjs.Bitmap(c);
    b.regX = b.regY = c._half;
    return b;
  }
  function drawSkullRing(g) {
    g.beginRadialGradientFill(["rgba(20,8,16,0)", "rgba(120,20,40,0.55)"], [0.55, 1],
        0, 0, 0, 0, 0, R + 6)
      .drawCircle(0, 0, R + 6);
  }
  function drawWildGlow(g) {
    g.beginRadialGradientFill(["rgba(142,240,208,0.5)", "rgba(142,240,208,0)"], [0.4, 1],
        0, 0, 4, 0, 0, R + 12)
      .drawCircle(0, 0, R + 12);
  }
  function drawBombFuse(g) {
    g.setStrokeStyle(2.4, "round").beginStroke("#c9a86a")
      .moveTo(R * 0.3, -R * 0.85)
      .quadraticCurveTo(R * 0.95, -R * 1.25, R * 0.55, -R * 1.7)
      .endStroke();
  }
  function drawBombSpark(g) {
    g.beginRadialGradientFill(["#fff4c0", "#ff8a2a", "rgba(255,120,20,0)"], [0, 0.45, 1],
        0, 0, 1, 0, 0, R * 0.5)
      .drawCircle(0, 0, R * 0.5);
  }
  function drawMissileFlame(g) {
    g.beginRadialGradientFill(["#fff4c0", "#ff8a2a", "rgba(255,120,20,0)"], [0, 0.45, 1],
        0, 0, 1, 0, 0, R * 0.6)
      .drawCircle(0, 0, R * 0.6);
  }
  function drawTreasureGlow(g) {
    g.beginRadialGradientFill(["rgba(255,220,110,0.6)", "rgba(255,220,110,0)"], [0, 1],
        0, 0, 2, 0, 0, R + 11)
      .drawCircle(0, 0, R + 11);
  }
  function drawShine(g) {
    g.beginFill("rgba(255,255,255,0.75)")
      .drawEllipse(-R * 0.6, -R * 0.66, R * 0.3, R * 0.2);
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
    var base = sprite(baseCanvas[colorIndex]);       // 下地+リム+フレネル(焼き込み)
    cont.addChild(base);
    var spin = sprite(spinCanvas);                   // 回転する塗装の合わせ目
    cont.addChild(spin);
    var shade = sprite(shadeCanvas[colorIndex]);     // 陰影・スペキュラ・輪郭
    cont.addChild(shade);
    cont.spin = spin;
    // 色替え(ボスのルーレット)用: 色依存の 2 枚だけ参照を持たせて
    // recolorView で canvas を差し替えられるようにする(view の作り直し不要)
    cont.baseBmp = base;
    cont.shadeBmp = shade;
    return cont;
  }

  // view を作り直さずに色だけ差し替える(共有 canvas の貼り替えのみ)。
  // makeView 製でない view(宝玉など)には効かないので false を返す
  function recolorView(view, colorIndex) {
    if (!view || !view.baseBmp) return false;
    if (baseCanvas[colorIndex] === undefined) bakeColor(colorIndex);
    view.baseBmp.image = baseCanvas[colorIndex];
    view.shadeBmp.image = shadeCanvas[colorIndex];
    return true;
  }

  // ---------- 玉 view のプール ----------
  // makeView の Container+Bitmap×3 は、波あたり 40〜60 個が数秒おきに
  // 生成(補給)→破棄(消滅 Tween 完了)される。中身の canvas は共有でも
  // 器の DisplayObject が毎回ゴミになり、携帯では GC のカクつきの種になる。
  // fx.js のパーティクルプールと同じ発想で器そのものを使い回す。
  // 色は recolorView(共有 canvas の貼り替え)で済むのでプールは色を区別しない。
  var viewFree = [];
  // プール容量: 1レーンの最大玉数 60 × レーン数 + 前波の残り。超えた分は普通に捨てる。
  // 固定の 96 だと4レーンのコース(在庫 ~150 玉)ではレベル終了や大連鎖の返却が
  // 溢れて捨てられ、直後の補給が makeView(Container+Bitmap×3)の新規生成に
  // なって GC が振動する。レーン数に追従させる
  function viewPoolMax() {
    var lanes = (PP.game && PP.game.lanes && PP.game.lanes.length) || 1;
    return 60 * lanes + 36;
  }
  function acquireView(colorIndex) {
    var view = viewFree.pop();
    if (!view) return makeView(colorIndex);
    view.__pooled = false;
    // 前の生涯の痕跡を全部消す: 消滅 Tween の縮小/透明、挿入演出の座標、
    // 骸骨マーク(chain.js が base/spin/shade の後ろ=4枚目以降に addChild する。
    // makeSkullOverlay は Tween を使わないので、外すのは子の除去だけでよい)
    createjs.Tween.removeTweens(view);
    view.x = 0; view.y = 0;
    view.scaleX = 1; view.scaleY = 1;
    view.alpha = 1; view.rotation = 0; view.visible = true;
    view.spin.rotation = 0;
    while (view.numChildren > 3) view.removeChildAt(3);
    recolorView(view, colorIndex);
    return view;
  }
  function releaseView(view) {
    // makeView 製以外(宝玉・爆弾など baseBmp を持たない view)と、
    // 二重返却(clearBalls と消滅 Tween の両方から返る等)は受け付けない
    if (!view || !view.baseBmp || view.__pooled) return;
    createjs.Tween.removeTweens(view);
    if (view.parent) view.parent.removeChild(view);
    view.__pooled = true;
    if (viewFree.length < viewPoolMax()) viewFree.push(view);
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

    // 導火線と火花(脈打たせる)。共有 canvas の Bitmap(上の bakePart 参照)
    var fuse = partSprite("fuse", Math.ceil(R * 1.8) + 2, drawBombFuse);
    cont.addChild(fuse);
    var spark = partSprite("spark", Math.ceil(R * 0.5) + 2, drawBombSpark);
    spark.x = R * 0.55; spark.y = -R * 1.7;
    cont.addChild(spark);
    createjs.Tween.get(spark, { loop: true })
      .to({ scaleX: 0.6, scaleY: 0.6, alpha: 0.6 }, 160)
      .to({ scaleX: 1.15, scaleY: 1.15, alpha: 1 }, 160);

    // 固定のハイライト(球感)。共有 canvas の Bitmap
    var shine = partSprite("shine", R + 2, drawShine);
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
    var flame = partSprite("flame", Math.ceil(R * 0.6) + 2, drawMissileFlame);
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
    var glow = partSprite("treasureGlow", R + 13, drawTreasureGlow);
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

  // 骸骨玉のマーク(通常の色付き玉の上に重ねるオーバーレイ)。
  // 玉そのものは普通の色玉なのでマッチも磁石もそのまま効く。回転レイヤー
  // (view.spin)には載せない=玉が転がってもマークは正位置のまま。
  // 予兆の明滅は skull.js が毎フレーム ring の alpha を書いて行う
  // (Tween を使わない=撃破時の後始末が要らない)。
  function makeSkullOverlay() {
    var cont = new createjs.Container();

    // 暗い脈動リング(通常時はうっすら、予兆中は skull.js が alpha で強める)。
    // 共有 canvas の Bitmap(上の bakePart 参照)
    var ring = partSprite("skullRing", R + 8, drawSkullRing);
    ring.alpha = 0.4;
    cont.addChild(ring);

    // ドクロマーク(絵文字グリフは焼いて再整形を避ける。宝玉の💎と同じ手法)
    var mark = new createjs.Text("☠", Math.round(R * 1.15) + "px serif", "#f2ecdD");
    mark.textAlign = "center";
    mark.textBaseline = "middle";
    mark.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 1, 4);
    mark.cache(-R, -R, R * 2, R * 2);
    cont.addChild(mark);

    cont.ring = ring;   // skull.js が予兆の明滅で触る
    cont.mark = mark;
    return cont;
  }

  // 【強化】万能玉(海神の加護)。骨白の球+虹色リング+✨の明滅。
  // どの色に当てても「当てた玉の色」として挿入される(色継承は chain.js insertShot)。
  // cont.spin に虹リングを載せて転がりを見せ、cont.spark は cannon.js の既存の
  // Tween 後始末(view.spark を removeTweens)にそのまま乗せる。
  function makeWildView() {
    var cont = new createjs.Container();

    // 外周のグロー(teal。救済の合図と同じ色言語)。共有 canvas の Bitmap
    var glow = partSprite("wildGlow", R + 14, drawWildGlow);
    cont.addChild(glow);

    // 本体(骨白の球)
    var body = new createjs.Shape();
    body.graphics
      .beginRadialGradientFill(["#ffffff", "#ece6d6", "#8a8474"], [0, 0.6, 1],
        -R * 0.32, -R * 0.34, R * 0.06, 0, 0, R)
      .drawCircle(0, 0, R);
    body.graphics.setStrokeStyle(1.5).beginStroke("rgba(0,0,0,0.5)").drawCircle(0, 0, R - 0.7);
    body.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);
    cont.addChild(body);

    // 虹色リング(6色の弧)。回転レイヤーに載せて転がりを見せる
    var ring = new createjs.Shape();
    var cols = ["#ff5d5d", "#ffb84a", "#ffe95a", "#68e07c", "#5aa8ff", "#b06cff"];
    for (var i = 0; i < cols.length; i++) {
      ring.graphics.setStrokeStyle(4.5).beginStroke(cols[i])
        .arc(0, 0, R - 5, i * Math.PI / 3, (i + 1) * Math.PI / 3).endStroke();
    }
    ring.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);
    cont.addChild(ring);

    // ハイライト(球感)。共有 canvas の Bitmap
    var shine = partSprite("shine", R + 2, drawShine);
    cont.addChild(shine);

    // ✨ の明滅(glow ごと脈動させる)
    createjs.Tween.get(glow, { loop: true })
      .to({ alpha: 0.35, scaleX: 0.85, scaleY: 0.85 }, 300, createjs.Ease.quadInOut)
      .to({ alpha: 1, scaleX: 1.1, scaleY: 1.1 }, 300, createjs.Ease.quadInOut);

    cont.spin = ring;
    cont.spark = glow;   // cannon.js の後始末(removeTweens(view.spark))に相乗り
    return cont;
  }

  // 「暗闇」(ボスの裁きの雷霆)の装填玉: 真っ黒の球体+「?」。色が読めない手札。
  // 撃った弾そのものは本当の色で飛ぶ(cannon.js fire)ので、これは表示専用。
  // makeView 製ではない(baseBmp を持たない)ので recolorView は効かない
  function drawUnknownGlow(g) {
    g.beginRadialGradientFill(["rgba(120,60,200,0.55)", "rgba(120,60,200,0)"], [0.3, 1],
      0, 0, 0, 0, 0, R + 14).drawCircle(0, 0, R + 14);
  }
  function makeUnknownView() {
    var cont = new createjs.Container();
    var glow = partSprite("unknownGlow", R + 14, drawUnknownGlow);
    cont.addChild(glow);
    var body = new createjs.Shape();
    body.graphics
      .beginRadialGradientFill(["#3a3446", "#15121c", "#000000"], [0, 0.6, 1],
        -R * 0.32, -R * 0.34, R * 0.06, 0, 0, R)
      .drawCircle(0, 0, R);
    body.graphics.setStrokeStyle(1.5).beginStroke("rgba(160,120,255,0.6)").drawCircle(0, 0, R - 0.7);
    body.cache(-R - 2, -R - 2, (R + 2) * 2, (R + 2) * 2);
    cont.addChild(body);
    var q = new createjs.Text("?", "bold " + Math.round(R * 1.3) + "px sans-serif", "#b9a3ff");
    q.textAlign = "center"; q.textBaseline = "middle";
    q.cache(-R, -R, R * 2, R * 2);
    cont.addChild(q);
    var shine = partSprite("shine", R + 2, drawShine);
    shine.alpha = 0.5;
    cont.addChild(shine);
    // 不穏な明滅(glow を脈動)
    createjs.Tween.get(glow, { loop: true })
      .to({ alpha: 0.3, scaleX: 0.9, scaleY: 0.9 }, 420, createjs.Ease.quadInOut)
      .to({ alpha: 1, scaleX: 1.08, scaleY: 1.08 }, 420, createjs.Ease.quadInOut);
    cont.spin = q;
    cont.spark = glow;   // cannon.js の後始末(removeTweens(view.spark))に相乗り
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
    // 【強化】「同色の潮流」で塊率が上がる(1-(1-c)×0.85^lv。未取得なら素通し)。
    // 漸近型なのでコース5(0.75)でも100%には届かず、SPAWN_RUN_MAX の4連上限も残る
    cluster = PP.upgrades.clusterBoost(cluster);
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
    recolorView: recolorView,
    acquireView: acquireView,   // プールから玉 view を取得(なければ makeView)
    releaseView: releaseView,   // 玉 view をプールへ返却(Tween 停止と除去込み)
    makeBombView: makeBombView,
    makeMissileView: makeMissileView,
    makeTreasureView: makeTreasureView,
    makeWildView: makeWildView,
    makeUnknownView: makeUnknownView,   // 暗闇(裁きの雷霆)の黒い装填玉
    makeSkullOverlay: makeSkullOverlay,
    pickColor: pickColor,
    spawnColor: spawnColor
  };
})();
