/* =========================================================
 * cannon.js — 大砲(原作準拠: 画面下部を左右にスライド移動)
 *
 * マウスの X 座標に追従して横移動し、真上に発射する。
 * 玉を2個持ち、右クリック(または Space)で交換できる。
 * 特殊弾(爆弾/ミサイル)を持っている間は、同じ操作で
 * 「砲身の特殊弾 ⇔ 左脇スロットの色玉」を行き来する。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var root;          // 大砲全体のコンテナ(x が大砲の位置)
  var barrel;        // 砲身(反動アニメ用)
  var loadSlot;      // 装填した玉の置き場(砲身と砲口の縁の間の層)
  var currentView;   // 装填中の玉
  var nextView;      // 次弾の表示
  var aimLine;       // 照準ガイド
  var stockSlot;     // 特殊弾のストックスロット(大砲の左脇に追従)
  var stockIcon;     // スロット内の特殊弾アイコン(spark トゥイーン後始末用)
  var stockLabel;    // スロットの状態表示(「待機」/「装填中」)

  var MUZZLE_LEN = 52; // 砲口までの高さ

  // ---------- 現在位置ガイド(大砲の少し上に浮かぶ真鍮の羅針飾り) ----------
  // マウスは Pointer Lock でゲーム内へ格納され、OSカーソルは見えない(input.js)。
  // その代わりに「砲はいまここ」を指す小さな目印を砲口の上へ浮かべる。
  // 意匠は吊り輪付きの羅針の針先(下向きの菱形)。世界の真鍮言語(BRZ)で描き、
  // 逆操作(addle)中は妖弾と同じ桃色に染めてゆらゆら揺らし、「素直に動かない」
  // ことを色と動きでも伝える。
  var guide = null, guideCore = null;
  var guideT = 0, guideShown = false, guideAddle = false;
  var GUIDE_Y = -122;   // 砲口(-53)より上、照準の点線に重ねて「いまここ」を示す高さ

  // 特殊弾ストックスロットのクリック判定の半幅。位置は次弾ラックの鏡像
  // (大砲の左脇)で、RACK_X の定義後に STOCK_X / STOCK_Y として決める。
  // swap(Space/右クリック)が装填⇔待機の双方向トグルなので、スロットを
  // 直接クリックしなくても出し入れできる(直タップはタッチ向けの補助)。
  var STOCK_R = 34;

  // ---------- 素材(道・洞窟・樽と同じ金属言語で喋らせる) ----------
  // 以前の砲身は #11151c〜#565f70 のガンメタルで、世界中が磨いた真鍮
  // (木道 #b98b3e / 洞窟のリング / 樽のたが)で出来ているのに一人だけ
  // クロームの筒だった。ブロンズに寄せると甲板の一部として据わり、
  // 冷たい月光のリムで海から切り出される(玉のフレネルと同じ考え方)。
  var BRZ = {
    DARK:  "#3a2a12",                   // 下地ブロンズ(影)
    SHADE: "#8a6428",                   // 陰
    BODY:  "#b98b3e",                   // 胴
    LIT:   "#e6c078",                   // 照り
    SPEC:  "#f2dca8",                   // スペキュラ
    BORE:  "#07090c",                   // 砲腔
    RIM:   "rgba(180,208,236,0.45)",    // 月光リム(冷)
    OAK:   "#5a3c1c",                   // 樫の砲架(樽 #8a5a2b と同族)
    OAKD:  "#2a1a0a"
  };

  // 砲身の輪郭(左半分)。y と半幅の対。
  //
  // 太さの根拠: この砲が撃つのは半径 24 の玉なので、砲腔は最低でも直径 48 いる。
  // 従来の drawRoundRect(-9,-52,18,44,8) は幅 18 しかなく、装填した玉(直径 48)に
  // 完全に覆い隠されていた — どれだけ砲身を作り込んでも一切見えない。
  // 口径に見合う太さにすると必然的に「短く太い」= 臼砲(mortar)になる。
  // 真上へ玉を打ち上げる砲としてはこれが正しく、海賊の甲板砲としても筋が通る。
  //
  // シルエットの要点: 尾栓を丸く絞り、砲口を大きく開く。上下とも同じ太さで
  // 胴に横帯を巻くと、どう塗っても「木の桶」にしか見えない。下すぼまり+口の
  // 大きな開き = 臼砲/カロネード砲の形にすることで、初めて砲として読める。
  var PROFILE = [
    [ 21, 16.0],   // 尾栓の底(丸く絞る)
    [ 16, 25.0],
    [  9, 29.5],
    [ -6, 28.0],
    [-22, 26.5],   // 胴のくびれ
    [-36, 28.0],
    [-45, 33.0],   // 砲口の膨らみ(muzzle swell)へ立ち上がる
    [-50, 37.0],   // 膨らみの頂点
    [-53, 35.0]    // 砲口面
  ];
  var BORE = 25.5;   // 砲腔の半径(玉 24 がちょうど収まる)
  var MUZZLE_Y = -50;            // 砲口の楕円の中心
  var MUZZLE_RY = BORE * 0.40;   // 砲口を見下ろす角度(真上からやや手前)
  var LOAD_Y = -52;  // 装填した玉の中心。砲口(-53)にちょうど収まり、
                     // fire() が玉を出す位置(-MUZZLE_LEN = -52)と一致する
  var RACK_X = 74, RACK_Y = -6;   // 次弾の弾架(太った砲架 RX=46 を避けた位置)
  var STOCK_X = -RACK_X, STOCK_Y = RACK_Y;   // 特殊弾スロット(次弾ラックの鏡像=左脇)

  // 砲身のある y での半幅(補強帯・トラニオン・リムを輪郭に合わせるため)
  function halfAt(y) {
    if (y >= PROFILE[0][0]) return PROFILE[0][1];
    for (var i = 0; i + 1 < PROFILE.length; i++) {
      var a = PROFILE[i], b = PROFILE[i + 1];
      if (y <= a[0] && y >= b[0]) {
        var t = (a[0] - y) / (a[0] - b[0] || 1);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return PROFILE[PROFILE.length - 1][1];
  }

  // 中心 (cx,cy)・半径 (rx,ry) の楕円弧を線分で引く。
  // Graphics.arc は真円しか引けないので、砲口の楕円はこれで描く
  // (真円を描いて scaleY で潰すと、潰し方を誤ると角が跳ねて「角」に見える)。
  function ellipseArc(g, cx, cy, rx, ry, a0, a1, n) {
    for (var i = 0; i <= n; i++) {
      var a = a0 + (a1 - a0) * (i / n);
      var x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
  }

  // 輪郭を左右対称の閉じたパスとして引く(inset>0 で内側に縮めた相似形)
  function traceTube(g, inset) {
    inset = inset || 0;
    var i;
    g.moveTo(-(PROFILE[0][1] - inset), PROFILE[0][0]);
    for (i = 1; i < PROFILE.length; i++) g.lineTo(-(PROFILE[i][1] - inset), PROFILE[i][0]);
    for (i = PROFILE.length - 1; i >= 0; i--) g.lineTo(PROFILE[i][1] - inset, PROFILE[i][0]);
    g.closePath();
  }

  // ホットループ用の使い回しオブジェクト(posAtInto の書き込み先)。毎フレーム
  // 玉数ぶん posAt が呼ばれる当たり判定・照準で、座標オブジェクトの確保を無くす。
  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };

  // --- 砲架(甲板に寝た旋回台)。奥のレイヤー = 砲身の下に敷く ---
  function buildCarriage() {
    var s = new createjs.Shape();
    var g = s.graphics;
    var RX = 46, RY = 25;   // 円ではなく楕円。円は「カメラを向いた円盤」に見えるが、
                            // 楕円なら甲板に置かれているように見える

    // 甲板への接地影。道の影(traceRail(4,6))と同じ +x/+y 方向へ揃える
    g.beginRadialGradientFill(["rgba(0,0,0,0.5)", "rgba(0,0,0,0)"], [0, 1],
      4, 7, 4, 4, 7, RX * 1.15)
      .drawEllipse(4 - RX * 1.15, 7 - RY * 1.0, RX * 2.3, RY * 2.0);

    // 樫の台。左上から光が来る想定でグラデの中心をずらす
    g.beginRadialGradientFill([BRZ.OAK, "#43290f", BRZ.OAKD], [0, 0.6, 1],
      -RX * 0.32, -RY * 0.38, 3, 0, 0, RX)
      .drawEllipse(-RX, -RY, RX * 2, RY * 2);

    // 板の継ぎ目(甲板の板目に沿った横線)
    for (var i = -2; i <= 2; i++) {
      var sy = (i / 2.6) * RY;
      var hw = RX * Math.sqrt(Math.max(0, 1 - (sy / RY) * (sy / RY))) - 2;
      g.setStrokeStyle(1.3).beginStroke("rgba(24,14,4,0.5)")
        .moveTo(-hw, sy).lineTo(hw, sy).endStroke();
      g.setStrokeStyle(0.8).beginStroke("rgba(230,192,120,0.12)")
        .moveTo(-hw, sy - 1.2).lineTo(hw, sy - 1.2).endStroke();
    }

    // 真鍮の縁帯 + 左上の照り / 下の陰
    // (楕円の弧は Graphics.arc では引けないので、短い線分で近似する)
    g.setStrokeStyle(3).beginStroke(BRZ.DARK).drawEllipse(-RX, -RY, RX * 2, RY * 2);
    g.setStrokeStyle(2).beginStroke(BRZ.BODY).drawEllipse(-RX, -RY, RX * 2, RY * 2);
    var k;
    g.setStrokeStyle(2.2, "round").beginStroke(BRZ.LIT);
    for (k = 0; k <= 12; k++) {
      var a1 = Math.PI * (1.02 + 0.62 * (k / 12));
      var px = Math.cos(a1) * RX, py = Math.sin(a1) * RY;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.endStroke();
    g.setStrokeStyle(2.2, "round").beginStroke("rgba(0,0,0,0.5)");
    for (k = 0; k <= 12; k++) {
      var a2 = Math.PI * (0.08 + 0.7 * (k / 12));
      var qx = Math.cos(a2) * RX, qy = Math.sin(a2) * RY;
      if (k === 0) g.moveTo(qx, qy); else g.lineTo(qx, qy);
    }
    g.endStroke();

    // 鉄のボルト(縁に打ち込まれた鋲)
    for (var b = 0; b < 8; b++) {
      var ang = Math.PI * 2 * (b / 8) + 0.2;
      var bx = Math.cos(ang) * (RX - 4), by = Math.sin(ang) * (RY - 3);
      g.beginFill("#20242b").drawCircle(bx, by, 2.4);
      g.beginFill("rgba(214,228,244,0.55)").drawCircle(bx - 0.7, by - 0.8, 1);
    }
    return s;
  }

  // --- 砲身。先細り + 砲口の膨らみ + 補強帯 + カスカベル ---
  function buildTube() {
    var s = new createjs.Shape();
    var g = s.graphics;
    var i;

    // カスカベル(尾栓の握り玉)。砲身より先に描いて根本に潜り込ませる
    g.beginRadialGradientFill([BRZ.BODY, BRZ.SHADE, BRZ.DARK], [0, 0.6, 1], -3, 24, 1, 0, 28, 8)
      .drawCircle(0, 24, 6.5);

    // 胴。両端をぐっと落として中央左に細い照りを置くと、平らな板ではなく
    // 円筒として立ち上がる。左を光源側にしてグラデを非対称に置く。
    g.beginLinearGradientFill(
      ["#1d1408", "#5c4118", BRZ.BODY, BRZ.LIT, BRZ.SPEC, BRZ.BODY, BRZ.SHADE, "#241a0a", "#140d04"],
      [0, 0.07, 0.2, 0.31, 0.38, 0.55, 0.78, 0.93, 1], -36, 0, 36, 0)
      .beginStroke("rgba(20,13,3,0.85)").setStrokeStyle(1.6);
    traceTube(g, 0);
    g.endStroke();

    // 補強帯(astragal)。本数を絞り、鋭い照りを一本入れて金属の帯として立てる。
    // 幅広の帯を何本も巻くと樽のたがに見えるので、細く・少なく。
    [4, -26].forEach(function (y) {
      var hw = halfAt(y) + 2.2;
      g.beginLinearGradientFill(["#2c1f0b", BRZ.SHADE, BRZ.SPEC, BRZ.BODY, BRZ.SHADE, "#1d1408"],
        [0, 0.14, 0.34, 0.55, 0.84, 1], -hw, 0, hw, 0)
        .drawRoundRect(-hw, y - 2.8, hw * 2, 5.6, 1.8);
      g.setStrokeStyle(1).beginStroke("rgba(255,240,196,0.6)")
        .moveTo(-hw + 2, y - 2.8).lineTo(hw - 2, y - 2.8).endStroke();
      g.setStrokeStyle(1.1).beginStroke("rgba(0,0,0,0.5)")
        .moveTo(-hw + 2, y + 2.8).lineTo(hw - 2, y + 2.8).endStroke();
    });
    // 火門(点火口)の突起。小さいが「これは砲だ」と言う細部
    g.beginFill(BRZ.SHADE).drawRoundRect(-4.5, -14, 9, 7, 2);
    g.beginFill("#120c04").drawCircle(0, -10.5, 1.9);
    g.setStrokeStyle(0.9).beginStroke("rgba(240,222,180,0.4)")
      .moveTo(-3.5, -13.6).lineTo(3.5, -13.6).endStroke();

    // 砲腔。ここに玉が収まる。奥ほど暗く、内壁の左側だけ月光が差す
    g.beginRadialGradientFill([BRZ.BORE, "#0d1116", "#04060a"], [0, 0.5, 1],
      -6, MUZZLE_Y - 2, 2, 0, MUZZLE_Y, BORE)
      .drawEllipse(-BORE, MUZZLE_Y - MUZZLE_RY, BORE * 2, MUZZLE_RY * 2);
    g.setStrokeStyle(1.4, "round").beginStroke("rgba(190,214,240,0.22)");
    ellipseArc(g, 0, MUZZLE_Y, BORE - 1.6, MUZZLE_RY - 1.4, Math.PI * 1.02, Math.PI * 1.98, 20);
    g.endStroke();
    // 砲腔の底に残る残熱(前弾の名残)
    g.beginRadialGradientFill(["rgba(255,150,60,0.16)", "rgba(255,120,20,0)"], [0, 1],
      0, MUZZLE_Y + 2, 1, 0, MUZZLE_Y + 2, BORE * 0.8)
      .drawEllipse(-BORE * 0.8, MUZZLE_Y + 2 - MUZZLE_RY * 0.7, BORE * 1.6, MUZZLE_RY * 1.4);

    // 月光の冷たいリム。暖色の砲身を暗い海から切り出す(玉のフレネルと同じ役割)
    g.setStrokeStyle(2, "round").beginStroke(BRZ.RIM);
    for (i = 0; i < PROFILE.length; i++) {
      var p = PROFILE[i];
      if (i === 0) g.moveTo(-(p[1] - 1), p[0]); else g.lineTo(-(p[1] - 1), p[0]);
    }
    g.endStroke();

    // 胴を縦に走るスペキュラ(円筒であることを言う一本)
    g.setStrokeStyle(3.4, "round").beginStroke("rgba(255,240,200,0.18)")
      .moveTo(-22, 10).lineTo(-17, -40).endStroke();
    return s;
  }

  // --- 砲口の手前側の唇。装填した玉より上に重ねて、玉が口へ「沈んで」見せる ---
  // 樽の口(course-view.js の buildBarrel)が front レイヤーで使っているのと同じ手。
  function buildMuzzleFront() {
    var s = new createjs.Shape();
    var g = s.graphics;
    var RX = BORE + 4.5, RY = MUZZLE_RY + 4;
    var PI = Math.PI;

    // 口の内側に落ちる影(玉の下端を暗くして、穴に入っているように見せる)
    g.beginLinearGradientFill(["rgba(0,0,0,0)", "rgba(0,0,0,0.62)"], [0, 1],
      0, MUZZLE_Y - 3, 0, MUZZLE_Y + MUZZLE_RY + 4)
      .drawEllipse(-BORE, MUZZLE_Y - MUZZLE_RY, BORE * 2, MUZZLE_RY * 2);

    // 手前半分の唇(厚いブロンズ)。奥半分は玉の後ろに隠れるので描かない
    g.setStrokeStyle(9, "round").beginStroke(BRZ.SHADE);
    ellipseArc(g, 0, MUZZLE_Y, RX, RY, 0.02 * PI, 0.98 * PI, 26); g.endStroke();
    g.setStrokeStyle(5.5, "round").beginStroke(BRZ.BODY);
    ellipseArc(g, 0, MUZZLE_Y, RX, RY, 0.05 * PI, 0.95 * PI, 26); g.endStroke();
    g.setStrokeStyle(2.2, "round").beginStroke(BRZ.LIT);
    ellipseArc(g, 0, MUZZLE_Y, RX, RY + 1.6, 0.56 * PI, 0.97 * PI, 16); g.endStroke();
    g.setStrokeStyle(1.6, "round").beginStroke(BRZ.RIM);
    ellipseArc(g, 0, MUZZLE_Y, RX + 1, RY + 2.6, 0.62 * PI, 0.99 * PI, 16); g.endStroke();
    return s;
  }

  // --- 砲架の頬板。砲身より前面に置いて、砲身が架台に挟まれて見えるようにする ---
  function buildCheeks() {
    var s = new createjs.Shape();
    var g = s.graphics;
    // 砲身(半幅 36)の脇から少し覗くだけの控えめな金具にする。大きく明るくすると
    // 砲身の両脇で羽ばたく板に見えて、砲のシルエットを壊す。
    [-1, 1].forEach(function (sx) {
      var x0 = sx * 24, x1 = sx * 41;
      g.beginLinearGradientFill(sx < 0 ? [BRZ.SHADE, "#5c4118", "#241a0a"] : ["#241a0a", "#4a340f", "#140d04"],
        [0, 0.5, 1], Math.min(x0, x1), 0, Math.max(x0, x1), 0)
        .moveTo(x0, 2).lineTo(x1, 7).lineTo(x1, 20).lineTo(x0, 23).closePath();
      g.setStrokeStyle(1.3).beginStroke("rgba(14,9,2,0.85)")
        .moveTo(x0, 2).lineTo(x1, 7).lineTo(x1, 20).lineTo(x0, 23).endStroke();
      // トラニオン(砲身が乗る耳軸)。金具の上に丸い鋲として見える
      g.beginRadialGradientFill([BRZ.SPEC, BRZ.BODY, BRZ.DARK], [0, 0.5, 1],
        sx * 33, 9, 1, sx * 34, 10, 7)
        .drawCircle(sx * 34, 10, 6);
      g.setStrokeStyle(1.2).beginStroke("rgba(20,13,3,0.85)").drawCircle(sx * 34, 10, 6);
      g.beginFill("rgba(240,222,180,0.4)").drawCircle(sx * 34 - 1.8, 8, 1.7);
    });
    return s;
  }

  // --- 次弾の弾架。裸で浮いていた次弾とラベルを甲板に係留する ---
  function buildRack() {
    var s = new createjs.Shape();
    var g = s.graphics;
    var CX = RACK_X, CY = RACK_Y;

    g.beginRadialGradientFill(["rgba(0,0,0,0.45)", "rgba(0,0,0,0)"], [0, 1], CX + 3, CY + 16, 2, CX + 3, CY + 16, 24)
      .drawEllipse(CX - 21, CY + 8, 48, 17);
    // 受け皿(玉が収まるブロンズのリング)
    g.beginLinearGradientFill([BRZ.DARK, BRZ.SHADE, BRZ.BODY, "#2c1f0b"], [0, 0.35, 0.6, 1], CX - 19, 0, CX + 19, 0)
      .drawEllipse(CX - 19, CY - 6, 38, 22);
    g.setStrokeStyle(2.4).beginStroke(BRZ.BODY).drawEllipse(CX - 18, CY - 5, 36, 20);
    g.setStrokeStyle(1.2).beginStroke(BRZ.LIT).drawEllipse(CX - 18, CY - 6.4, 36, 20);
    g.beginFill("rgba(0,0,0,0.5)").drawEllipse(CX - 13, CY - 1, 26, 13);
    // 鋲
    for (var b = 0; b < 4; b++) {
      var ang = Math.PI * (0.25 + b * 0.5);
      var bx = CX + Math.cos(ang) * 17, by = CY + 5 + Math.sin(ang) * 9;
      g.beginFill("#20242b").drawCircle(bx, by, 1.8);
      g.beginFill("rgba(214,228,244,0.5)").drawCircle(bx - 0.6, by - 0.6, 0.8);
    }
    // 銘板
    g.beginLinearGradientFill([BRZ.SHADE, BRZ.DARK], [0, 1], 0, CY + 14, 0, CY + 27)
      .drawRoundRect(CX - 17, CY + 14, 34, 13, 3);
    g.setStrokeStyle(1).beginStroke(BRZ.BODY).drawRoundRect(CX - 17, CY + 14, 34, 13, 3);
    return s;
  }

  function build() {
    var layer = PP.layers.cannon;

    // 照準ガイド(絶対座標で描画)
    aimLine = new createjs.Shape();
    aimLine.alpha = 0.25;
    layer.addChild(aimLine);

    root = new createjs.Container();
    root.x = PP.cannon.x;
    root.y = PP.cannon.y;
    layer.addChild(root);

    // 静止パーツは焼いてから貼る(ball.js と同じ手)。毎フレームのベクタ再描画が消える。
    // 砲身コンテナ barrel は装填中の玉を子に持つので cache しない — 中身だけを焼く。
    // 砲架は砲身の重心より下へずらして敷く。中心を原点に置くと、下すぼまりの
    // 尾栓(y=+21)とカスカベル(y=+24)が台の下からはみ出して宙に浮いて見える。
    var carriage = buildCarriage();
    carriage.y = 9;
    carriage.cache(-62, -40, 124, 78);
    root.addChild(carriage);

    // barrel の子の順序が「玉が砲口に収まって見える」ことの全て:
    //   tube(砲身) → loadSlot(装填した玉) → muzzleFront(砲口の手前の縁)
    // 縁を玉より上に置くことで、玉の下半分が口に沈んで見える(樽の口と同じ手)。
    barrel = new createjs.Container();
    var tube = buildTube();
    tube.cache(-40, -62, 80, 92);
    barrel.addChild(tube);
    loadSlot = new createjs.Container();
    barrel.addChild(loadSlot);
    var muzzleFront = buildMuzzleFront();
    muzzleFront.cache(-38, -64, 76, 30);
    barrel.addChild(muzzleFront);
    root.addChild(barrel);

    var cheeks = buildCheeks();
    cheeks.cache(-52, -24, 104, 48);
    root.addChild(cheeks);

    var rack = buildRack();
    rack.cache(RACK_X - 30, RACK_Y - 26, 60, 56);
    root.addChild(rack);

    buildGuide();   // 現在位置ガイド(root の子なので横移動に自動で追従する)

    // 次弾ラベル(銘板に彫り込んだ体裁。フォントは fx.floatText と揃える)
    var nextLabel = new createjs.Text(PP.i18n.t("cannon.next"),
      '700 11px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', BRZ.LIT);
    nextLabel.x = RACK_X; nextLabel.y = RACK_Y + 20.5;
    nextLabel.textAlign = "center";
    nextLabel.textBaseline = "middle";
    nextLabel.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 1, 1);
    root.addChild(nextLabel);

    // 特殊弾のストックスロット(大砲の左脇=次弾ラックの鏡像。特殊弾を
    // 持っている間だけ表示)。台座は次弾ラック(buildRack)と同じブロンズの言語で描く。
    stockSlot = new createjs.Container();
    stockSlot.x = STOCK_X; stockSlot.y = STOCK_Y;
    stockSlot.visible = false;
    var plate = new createjs.Shape();
    plate.graphics
      .beginLinearGradientFill([BRZ.SHADE, BRZ.DARK], [0, 1], 0, -28, 0, 30)
      .drawRoundRect(-30, -28, 60, 58, 8);
    plate.graphics.setStrokeStyle(1.5).beginStroke(BRZ.BODY).drawRoundRect(-30, -28, 60, 58, 8);
    plate.graphics
      .beginRadialGradientFill(["rgba(0,0,0,0.55)", "rgba(0,0,0,0.15)"], [0, 1], 0, -4, 2, 0, -4, 22)
      .drawEllipse(-22, -22, 44, 36);
    plate.cache(-32, -30, 64, 62);
    stockSlot.addChild(plate);
    stockLabel = new createjs.Text("",
      '700 10px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', BRZ.LIT);
    stockLabel.x = 0; stockLabel.y = 21;
    stockLabel.textAlign = "center";
    stockLabel.textBaseline = "middle";
    stockLabel.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 1, 1);
    stockSlot.addChild(stockLabel);
    var caption = new createjs.Text(PP.i18n.t(PP.TOUCH ? "cannon.swapTouch" : "cannon.swapKey"),
      '700 10px "Hiragino Kaku Gothic ProN","Meiryo",serif', "#f5e8c8");
    caption.x = 0; caption.y = 40;
    caption.textAlign = "center";
    caption.textBaseline = "middle";
    caption.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 1, 1);
    stockSlot.addChild(caption);
    root.addChild(stockSlot);   // 大砲コンテナの子にして横移動に追従させる

    // 言語切り替え時: build で文字を焼き込んだラベルだけ貼り替える。
    // stockLabel は refreshStock が状態から毎回組み直すので、それを呼べば足りる
    PP.i18n.onChange(function () {
      nextLabel.text = PP.i18n.t("cannon.next");
      caption.text = PP.i18n.t(PP.TOUCH ? "cannon.swapTouch" : "cannon.swapKey");
      refreshStock();
    });
  }

  function buildGuide() {
    guide = new createjs.Container();
    guide.y = GUIDE_Y;
    guide.visible = false;
    guideCore = new createjs.Shape();
    drawGuideCore(false);
    guide.addChild(guideCore);
    root.addChild(guide);
  }

  // ガイドの作画(通常=真鍮の金 / 逆操作中=妖弾と同じ桃)。
  // 色が切り替わる瞬間だけ描き直す(毎フレームのベクタ再描画はしない)
  function drawGuideCore(addle) {
    var body = addle ? "#ff5d8f" : BRZ.BODY;
    var lit  = addle ? "#ffc2d6" : BRZ.LIT;
    var dark = addle ? "#6e1b34" : BRZ.DARK;
    var g = guideCore.graphics;
    g.clear();
    // 柔らかい後光(小さく・薄く。照準の点線より少し目立つ程度)
    g.beginRadialGradientFill(
      [addle ? "rgba(255,93,143,0.28)" : "rgba(240,192,64,0.26)", "rgba(0,0,0,0)"],
      [0, 1], 0, 0, 2, 0, 0, 24).drawCircle(0, 0, 24);
    // 吊り輪(ランタンを吊るす環と同じ言葉遣い)
    g.setStrokeStyle(2).beginStroke(lit).drawCircle(0, -13, 4.5);
    // 針先: 下向きの菱形。上から照りが差す(玉・砲身と同じ光の向き)
    g.beginLinearGradientFill([lit, body, dark], [0, 0.45, 1], 0, -8, 0, 16)
      .moveTo(0, 16).lineTo(8.5, -1).lineTo(0, -8).lineTo(-8.5, -1).closePath();
    g.setStrokeStyle(1.2).beginStroke(dark)
      .moveTo(0, 16).lineTo(8.5, -1).lineTo(0, -8).lineTo(-8.5, -1).closePath();
    // 中央の稜線(磨いた金属のスペキュラ)
    g.setStrokeStyle(1).beginStroke(addle ? "#ffe6ef" : BRZ.SPEC)
      .moveTo(0, -6).lineTo(0, 13);
  }

  // 毎フレーム更新(main.js の tick が updateAim と並べて呼ぶ)。
  // タッチ端末では出さない: カーソルの代役という役目がそもそも無く、
  // 画面も小さいので盤面の邪魔になるだけ
  function updateGuide(dt) {
    if (!guide) return;
    var st = PP.game.state;
    var show = !PP.TOUCH && (st === "playing" || st === "intro");
    if (show !== guideShown) { guideShown = show; guide.visible = show; }
    if (!show) return;
    guideT += dt;
    // 停泊中の錨のように静かに上下する(主張しすぎない振幅)
    guide.y = GUIDE_Y + Math.sin(guideT * 2.4) * 3;
    var addle = PP.game.bossFx.addle > 0;
    if (addle !== guideAddle) {
      guideAddle = addle;
      drawGuideCore(addle);
      guide.rotation = 0;
    }
    // 逆操作中は振り子のように揺れ、「羅針が狂っている」ことを見せる
    if (addle) guide.rotation = Math.sin(guideT * 6) * 14;
  }

  // ストックスロットの表示を現在の状態に合わせて組み直す
  function refreshStock() {
    var g = PP.game;
    if (!stockSlot) return;
    if (stockIcon) {
      if (stockIcon.spark) createjs.Tween.removeTweens(stockIcon.spark);
      stockSlot.removeChild(stockIcon);
      stockIcon = null;
    }
    if (!g.special) { stockSlot.visible = false; return; }
    stockSlot.visible = true;
    stockIcon = g.special === "missile" ? PP.ball.makeMissileView() : PP.ball.makeBombView();
    stockIcon.x = 0; stockIcon.y = -4;
    stockIcon.scaleX = stockIcon.scaleY = 0.55;
    if (g.specialLoaded) {
      // 砲身の方に入っている: スロットには薄いゴーストだけ残す
      stockIcon.alpha = 0.35;
      stockLabel.text = PP.i18n.t("cannon.loaded");
    } else {
      stockIcon.alpha = 1;
      stockLabel.text = PP.i18n.t("cannon.wait");
    }
    stockSlot.addChildAt(stockIcon, 1);   // 台座の上・ラベルの下
  }

  // (sx, sy) がストックスロットのクリック範囲内か(特殊弾所持中のみ有効)。
  // スロットは大砲に追従するので判定も大砲相対。タッチ端末では指の太さぶん
  // 判定を広げる(見た目はそのまま)
  var STOCK_PAD = PP.TOUCH ? 12 : 0;
  function hitStock(sx, sy) {
    return PP.game.state === "playing" && !!PP.game.special &&
           Math.abs(sx - (PP.cannon.x + STOCK_X)) < STOCK_R + STOCK_PAD &&
           Math.abs(sy - (PP.cannon.y + STOCK_Y)) < STOCK_R + STOCK_PAD;
  }

  // マウス追従の横移動(縦は固定)
  function setX(mx) {
    if (PP.game.bossFx.freeze > 0) return;   // ボスの「停止!」中は動けない
    var m = PP.CANNON_MARGIN;
    PP.cannon.x = Math.max(m, Math.min(PP.W - m, mx));
    root.x = PP.cannon.x;
  }

  // 強制移動(ボスの大津波に押し流される)。freeze 中でも動かされる
  function forceX(mx) {
    var m = PP.CANNON_MARGIN;
    PP.cannon.x = Math.max(m, Math.min(PP.W - m, mx));
    root.x = PP.cannon.x;
  }

  // ---------- 被弾後の無敵の見た目(点滅) ----------
  // 無敵の当たり判定そのものは boss.js(orbHitCd)/ skull.js(playerHitCd)が
  // 持つ。ここは「見た目」の一元管理: 被弾処理が setHurt(無敵秒数) を呼ぶと、
  // 残り時間のあいだ大砲全体が明滅する(切れた瞬間に必ず元の濃さへ戻る)
  var hurtT = 0;
  function setHurt(sec) { hurtT = Math.max(hurtT, sec || 0); }
  function clearHurt() { hurtT = 0; if (root) root.alpha = 1; }
  function updateHurt(dt) {
    // リトライ暗転・クリア画面などへ抜けたら点滅を残留させない
    if (PP.game.state !== "playing") { if (hurtT > 0) clearHurt(); return; }
    if (hurtT <= 0) return;
    hurtT -= dt;
    root.alpha = hurtT <= 0 ? 1 : 0.55 + 0.3 * Math.sin(hurtT * 25);   // 約4Hzの明滅
  }

  // 特殊弾(爆弾/ミサイル)をキャッチした: 自動で装填する(装填中の色玉は温存)。
  // 持てるのは1個まで。すでに持っていたら新しい方に置き換える。
  function loadSpecial(kind) {
    var g = PP.game;
    if (g.special && g.special !== kind) {
      PP.fx.floatText(PP.i18n.t("cannon.swapped"), PP.cannon.x, PP.cannon.y - 80, "#8ef0d0", 16);
    }
    g.special = kind;
    g.specialLoaded = true;
    refreshBalls();
    PP.audio.specialLoad();
  }

  // 互換ラッパ(既存呼び出し向け)
  function loadBomb() { loadSpecial("bomb"); }

  // 特殊弾を「砲身に装填」⇔「スロットで待機」で切り替える。
  // ストックスロットの左クリック、または装填中の Space/右クリックから呼ばれる。
  function toggleSpecial() {
    var g = PP.game;
    if (g.state !== "playing" || !g.special) return;
    g.specialLoaded = !g.specialLoaded;
    refreshBalls();
    PP.audio.swap();
  }

  function fire() {
    var g = PP.game;
    // ボスの「停止!」中は発射も受け付けない(交換 swap だけは許す)
    if (g.bossFx.freeze > 0) {
      PP.audio.beep(120, 0.06, "square", 0.05);   // 空撃ちのカチッという手応え
      return;
    }
    var mx = PP.cannon.x;
    var my = PP.cannon.y - MUZZLE_LEN;
    var special = (g.special && g.specialLoaded) ? g.special : null;
    // 【強化】救済(海神の加護)の万能玉は通常色弾だけ。特殊弾を撃つときは
    // 消費せず持ち越す(色玉に戻した次の1発が万能玉になる)
    var wild = !special && PP.upgrades.wildArmed();
    if (wild) PP.upgrades.consumeWild();
    var view = special === "missile" ? PP.ball.makeMissileView()
             : special === "bomb"    ? PP.ball.makeBombView()
             : wild                  ? PP.ball.makeWildView()
             : PP.ball.makeView(g.currentColor);
    view.x = mx; view.y = my;
    PP.layers.shot.addChild(view);
    g.shots.push({
      x: mx, y: my,
      vx: 0,
      // 真上に発射。ミサイルは遅い初速から加速していく(updateShots 参照)
      vy: -(special === "missile" ? PP.MISSILE_SPEED0 : PP.SHOT_SPEED),
      spd: PP.MISSILE_SPEED0, // ミサイル用のスカラー速度(他の弾は未使用)
      roll: 0,              // 転がり表現用の累積距離
      special: special,     // null | "bomb" | "missile"
      wild: wild,           // 【強化】万能玉(着弾時に当てた玉の色を継承 = chain.js)
      color: g.currentColor, view: view
    });
    // 砲身の反動(下に沈む)
    createjs.Tween.get(barrel, { override: true })
      .to({ y: 6 }, 50).to({ y: 0 }, 120, createjs.Ease.quadOut);
    // 砲口の閃光と白煙、そして軽い揺れ。ブロンズの砲に「撃った」手応えを出す
    if (special === "missile") {
      PP.audio.missile();
      // 白熱の芯 + 青白い火球の二枚重ね(ボムの爆発と同じ文法)
      PP.fx.flash(mx, my, "rgba(255,255,240,1)", 46);
      PP.fx.flash(mx, my, "rgba(160,220,255,0.95)", 90);
      PP.fx.ring(mx, my, "#7ad9ff", 8, 70, 380);
      PP.fx.ring(mx, my, "#aee6ff", 4, 40, 280);
      PP.fx.burst(mx, my, "rgba(190,196,204,0.6)", 18, 1.4);
      // これから薙ぎ払う縦回廊を一瞬光らせて「この幅が消える」予告を出す
      PP.fx.missileTrail(mx, 0, my, PP.MISSILE_HIT_HALF * 2);
      PP.fx.shake(12, 0.3);
    } else {
      // 発射音は非ミサイルだけ(ミサイルは missile.mp3 が主役。Fire.mp3 と重ねない)
      PP.audio.fire();
      PP.fx.flash(mx, my, "rgba(255,214,140,0.9)", 34);
      PP.fx.burst(mx, my, "rgba(190,196,204,0.45)", 6);
      PP.fx.shake(2, 0.12);
    }

    if (special) {
      // 特殊弾は色玉の順番を消費しない。撃ったら元の色玉に戻る
      g.special = null;
      g.specialLoaded = false;
    } else {
      g.currentColor = g.nextColor;
      // 次弾は「いま装填した色」を避けて引く(手札が同じ色2個になるのを防ぐ)
      g.nextColor = PP.ball.pickColor(g.currentColor);
    }
    refreshBalls();
  }

  // 「今の玉」と「次の玉」を交換。特殊弾を持っている間は「砲身 ⇔ 左脇スロット」の
  // 双方向トグルになる(押すたびに特殊弾と色玉が入れ替わる)。このため特殊弾の
  // 所持中は色玉同士の交換はできないが、特殊弾は色玉の順番を消費しないので
  // 「色玉に戻す → 撃つ → 特殊弾に戻す」で困らない。
  function swap() {
    var g = PP.game;
    if (g.state !== "playing") return;
    if (g.special) { toggleSpecial(); return; }
    var t = g.currentColor;
    g.currentColor = g.nextColor;
    g.nextColor = t;
    refreshBalls();
    PP.audio.swap();
  }

  // 装填色の見張り(原作 Zuma 準拠の手詰まり防止)。
  // 撃つ前に盤面からその色が消えてしまったら、その玉はもう何にも刺さらない
  // ただのゴミなので、静かに引き直す。飛行中の玉は色を持って出ているので、
  // ここで引き直しても撃った結果は変わらない。
  function syncColors() {
    var g = PP.game;
    if (g.state !== "playing") return;
    // 盤面の玉と手札は毎フレームは変わらない。玉の増減(chain.js)と手札の変更
    // (refreshBalls)が colorsDirty を立てたフレームだけ全レーン走査する。
    // 同じ入力でこの関数を再実行しても結果は変わらない(色を引き直すのは
    // 「装填色が盤面に無い」ときだけ)ので、スキップしても挙動は同一。
    if (!g.colorsDirty) return;
    g.colorsDirty = false;
    // 全レーンの盤面から実在色を集計する(手詰まり防止を全レーンで成立させる)
    var present = [], nPresent = 0, anyBalls = false, anyPending = false;
    g.eachLane(function (lane) {
      if (lane.balls.length > 0) anyBalls = true;
      if (lane.pending > 0 || lane.needTreasure) anyPending = true;
    });
    g.eachLaneBall(function (b) {
      if (b.treasure || present[b.color]) return;
      present[b.color] = true;
      nPresent++;
    });
    if (!anyBalls) return;
    // レベル開始直後は洞窟から数個しか出ておらず、盤面が1色しかないことがある。
    // 補給の途中なら色が出そろうまで待つ。掃討フェーズなら本当に1色なので直す。
    if (nPresent < 2 && anyPending) return;

    var changed = false;
    // 【強化】万能玉の装填中は current の引き直しをしない(色は着弾時に決まる)
    if (!(g.special && g.specialLoaded) && !present[g.currentColor] &&
        !PP.upgrades.wildArmed()) {
      g.currentColor = PP.ball.pickColor(g.nextColor);
      changed = true;
    }
    if (!present[g.nextColor]) {
      g.nextColor = PP.ball.pickColor(g.currentColor);
      changed = true;
    }
    // 引き直しで2個とも同じ色になったら、色が他にある限りもう一度引く
    if (changed && g.currentColor === g.nextColor && nPresent >= 2) {
      g.nextColor = PP.ball.pickColor(g.currentColor);
    }
    if (changed) {
      refreshBalls();
      PP.audio.swapAuto();   // 自動引き直しはプレイヤー操作ではないので控えめな合成音のみ
    }
  }

  function refreshBalls() {
    var g = PP.game;
    // 手札(装填色・次弾・特殊弾の装填状態)が変わる経路は必ずここを通るので、
    // 装填色の見張り(syncColors)の再実行はここでまとめて予約する
    g.colorsDirty = true;
    if (currentView) {
      if (currentView.spark) createjs.Tween.removeTweens(currentView.spark);
      currentView.parent.removeChild(currentView);
    }
    if (nextView) { nextView.parent.removeChild(nextView); }
    // 装填した玉は砲口にちょうど収まる原寸(= これから撃たれる玉そのもの)。
    // 砲口の縁 muzzleFront が loadSlot より上にあるので、下半分が口に沈んで見える。
    currentView = (g.special && g.specialLoaded)
      ? (g.special === "missile" ? PP.ball.makeMissileView() : PP.ball.makeBombView())
      : PP.upgrades.wildArmed() ? PP.ball.makeWildView()   // 【強化】救済中は虹の万能玉
      : PP.ball.makeView(g.currentColor);
    currentView.x = 0; currentView.y = LOAD_Y;
    loadSlot.addChild(currentView);
    nextView = PP.ball.makeView(g.nextColor);
    nextView.x = RACK_X; nextView.y = RACK_Y - 3;
    nextView.scaleX = nextView.scaleY = 0.62;
    root.addChild(nextView);
    refreshStock();
  }

  // 照準ガイドの前回描画時の入力。描く内容は (x, 望遠鏡, topY, 装填中の特殊弾) の
  // 純関数なので、入力が同じフレームは clear()+再描画を丸ごと飛ばす。
  // 比較は === の厳密一致(近似で飛ばすと1pxでも絵が変わりうる)。
  var aimDrawn = false;   // いま照準線が描かれているか(非プレイ時のクリアを1回にする)
  var aimX = null, aimSpy = null, aimTopY = null, aimSp = null;

  // firstHitY(全玉走査)の間引きキャッシュ。望遠鏡中は毎フレーム呼ばれるが、
  // 着弾円が縦に 2〜3 フレーム遅れても知覚できないので、砲が動いた(x が変わった)
  // ときだけ即再計算し、静止中は 0.05 秒間隔まで走査を減らす(横ずれは見せない)
  var fhCacheY = 66, fhCacheX = null, fhAge = 1;

  // 照準ガイド(入力が変わった tick だけ再描画)。望遠鏡が有効な間は着弾点まで伸びる
  function updateAim(dt) {
    if (PP.game.state !== "playing") {
      if (aimDrawn) { aimLine.graphics.clear(); aimDrawn = false; aimX = null; }
      return;
    }
    var x = PP.cannon.x;
    var spy = PP.game.effects.spyglass > 0;
    var topY;
    if (spy) {
      fhAge += dt || 0;
      if (x !== fhCacheX || fhAge >= 0.05) {
        fhCacheX = x; fhAge = 0;
        fhCacheY = firstHitY(x);
      }
      topY = fhCacheY;
      aimLine.alpha = 0.55;
    } else {
      topY = PP.cannon.y - MUZZLE_LEN - 90;
      aimLine.alpha = 0.25;
    }
    var sp = (PP.game.special && PP.game.specialLoaded) ? PP.game.special : null;
    if (aimDrawn && x === aimX && spy === aimSpy && topY === aimTopY && sp === aimSp) return;
    aimDrawn = true; aimX = x; aimSpy = spy; aimTopY = topY; aimSp = sp;
    var g = aimLine.graphics;
    g.clear();
    g.setStrokeStyle(2).beginStroke(
      sp === "missile" ? "#7ad9ff" : sp === "bomb" ? "#ff7a3c" : "#f5e8c8");
    // 装填した玉(砲口の -52 に原寸で乗る)の上端から引き始める。玉に食い込ませない。
    for (var y = PP.cannon.y - MUZZLE_LEN - PP.R - 8; y > topY; y -= 14) {
      g.moveTo(x, y).lineTo(x, Math.max(y - 7, topY));
    }
    if (spy) {
      g.beginStroke("#ffe08a").setStrokeStyle(2).drawCircle(x, topY, 7);
    }
  }

  // 真上に撃ったとき最初に当たるチェーン玉の高さ(なければ HUD 下端 66)。
  // 全レーンを対象にし、トンネル内の玉(撃てない)は無視する。
  function firstHitY(x) {
    var best = 66;
    PP.game.eachLaneBall(function (b, lane) {
      if (b.treasure || b.d < PP.R) return;
      if (lane.rail.tunnelAt(b.d)) return;
      var p = lane.rail.posAtInto(b.d, _pos);
      if (Math.abs(p.x - x) <= PP.D * 0.9 &&
          p.y < PP.cannon.y - MUZZLE_LEN && p.y > best) {
        best = p.y;
      }
    });
    return best;
  }

  // updateShots の玉座標キャッシュ。中身は毎フレーム書き直すが、配列やレーン毎の
  // 入れ物はモジュールに置いて使い回す(弾が飛んでいる間の毎フレーム確保を無くす)。
  var _cache = [], _cacheN = 0, _overPts = [], _overN = 0;
  var _posDirty = true;   // 玉座標キャッシュの要更新フラグ(サブステップ間で持ち越す)

  // 発射玉の移動とチェーンへの命中判定(全レーン横断)。
  // dt が大きいフレーム(処理落ち等)では、弾が1フレームで当たり判定の半径を
  // 超えて動いてチェーンをすり抜けることがある(config.js の SHOT_SPEED_MAX の
  // 注釈参照)。そこで dt が大きいときは短い時間に等分して stepShots を複数回
  // 呼び、通常速度と同じ細かさで動かす。
  // 通常速度(60fps で dt ≈ 0.0167 秒)では従来どおり 1 回だけ呼ばれる。
  // ステップ数は 4 で頭打ちにする: 上限が無いと「重い → 分割数が増える →
  // さらに重い」の悪循環(処理落ちスパイラル)になる。上限後の 1 ステップは
  // 最悪でも dt/4 で、弾半径に対するすり抜け余裕は実用上足りる
  function updateShots(dt) {
    var steps = (dt > 0.02) ? Math.min(4, Math.ceil(dt / 0.0167)) : 1;
    var h = dt / steps;
    _posDirty = true;   // チェーンはフレーム間でしか進まないので、引き直しはフレームに1回
    for (var i = 0; i < steps; i++) stepShots(h);
  }
  function stepShots(dt) {
    var g = PP.game;
    var shots = g.shots;
    if (shots.length === 0) return;   // 弾が無いフレームは何もしない
    // 「時間の滞留」(ボスの妖弾・パワーダウン⏳): 発射玉の時間だけ極端に
    // 遅く流れる。弾の積分にだけ倍率を掛ける(チェーンや演出は通常速度のまま)。
    if (g.bossFx.shotSlow > 0) dt *= PP.BOSS.shotSlow.factor;
    var lanes = g.lanes;
    var R = PP.R, D = PP.D;

    // 玉の画面座標(と立体交差の上下・トンネルの内外)は d から一意に決まる。
    // 弾ごとに全玉ぶん引き直すと「弾数 × 玉数」になるので、盤面が変わらない限り
    // 玉あたり 1 回に集約する。割り込み/爆発で列が変わったら posDirty で作り直す。
    // (キャッシュ自体はサブステップをまたいで有効。updateShots がフレーム頭で dirty にする)
    function refreshBallPos() {
      _overN = 0;   // 橋(上の帯)に乗っている玉の画面座標。下の玉の遮蔽判定に使う
      for (var li = 0; li < lanes.length; li++) {
        var lane = lanes[li];
        var balls = lane.balls;
        var c = _cache[li] ||
          (_cache[li] = { lane: null, balls: null, n: 0, bx: [], by: [], bover: [], btun: [] });
        c.lane = lane; c.balls = balls; c.n = balls.length;
        for (var k = 0; k < balls.length; k++) {
          var p = lane.rail.posAtInto(balls[k].d, _pos);
          c.bx[k] = p.x; c.by[k] = p.y;
          c.bover[k] = lane.rail.heightAt(balls[k].d) > 0;
          c.btun[k] = lane.rail.tunnelAt(balls[k].d);
          if (c.bover[k] && !c.btun[k] && balls[k].d >= PP.R) {
            _overPts[_overN++] = p.x; _overPts[_overN++] = p.y;
          }
        }
      }
      _cacheN = lanes.length;
      _posDirty = false;
    }

    // 下の帯の玉(ground)が、橋の桁の下に隠れているか。橋に乗っている玉の画面座標が
    // 近く(桁幅ぶん)にあれば、その地上玉は桁に覆われて見えない=撃てない。
    // 立体交差の無いコースでは overPts が空なので常に false。
    //
    // 半径は course-view.js の DECK_HALF(桁の視覚幅 = 片側 40px)と対にする。
    // ずれると「桁に隠れて見えないのに撃てる玉」が生まれ、見えている先の玉を
    // 狙った弾がその手前で止まる。桁の幅を変えるときは必ずここも動かすこと。
    var OCCLUDE_R2 = (D * 0.85) * (D * 0.85);
    function occludedByDeck(x, y) {
      for (var o = 0; o < _overN; o += 2) {
        var dx = x - _overPts[o], dy = y - _overPts[o + 1];
        if (dx * dx + dy * dy < OCCLUDE_R2) return true;
      }
      return false;
    }

    for (var s = shots.length - 1; s >= 0; s--) {
      var sh = shots[s];

      // ミサイル: 等加速で真上へ直進し、通過した回廊上の玉を貫通して消す。
      // 速度に上限が無いので、1フレームの移動区間ごと当てるスイープ判定
      // (chain.pierceSegment)を使い、高速でもすり抜けないようにする。
      // 何かに当たっても止まらず、画面上端へ抜けたところで消える。
      if (sh.special === "missile") {
        var v0 = sh.spd;
        sh.spd += PP.MISSILE_ACCEL * dt;
        var yPrev = sh.y;
        sh.y -= (v0 + sh.spd) * 0.5 * dt;   // 等加速の厳密積分
        sh.view.y = sh.y;
        PP.fx.missileTrail(sh.x, sh.y + R, Math.min(140, (yPrev - sh.y) + 40),
          PP.MISSILE_HIT_HALF * 2);
        if (PP.fx.particleLoad() < 0.75) {
          PP.fx.burst(sh.x, sh.y + R * 1.2, "rgba(255,190,90,0.5)", 2);
        }
        var hits = PP.chain.pierceSegment(sh.x, sh.y, yPrev);
        if (hits > 0) {
          _posDirty = true;   // 列が変わった → 通常弾は座標を引き直す
          // 貫通のたびにボム級へ迫る強い揺れ(ボムの 80 は超えない)
          PP.fx.shake(Math.min(60, 12 + hits * 8), 0.5);
        }
        // ボス戦: ミサイルはボスも貫く(1発ぶんの無敵時間で多段ヒットは防ぐ)。
        // 高速なので今フレームの移動区間の中点でも判定してすり抜けを防ぐ
        if (g.bossMode &&
            (PP.boss.hitTest(sh.x, sh.y) || PP.boss.hitTest(sh.x, (sh.y + yPrev) / 2))) {
          PP.boss.onHit(PP.BOSS.dmg.missile, sh.x, sh.y);
        }
        if (sh.y < -R * 3) {
          if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
          PP.layers.shot.removeChild(sh.view);
          shots.splice(s, 1);
        }
        continue;   // 通常弾の加速・割り込み・命中ロジックには入らない
      }

      // 発射後は加速していく(等速直線をやめる)。真上固定なので速度ベクトルは
      // 向きを保ったまま増速し、SHOT_SPEED_MAX で頭打ちにする。
      var sp = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy);
      if (sp > 0 && sp < PP.SHOT_SPEED_MAX) {
        var nsp = Math.min(PP.SHOT_SPEED_MAX, sp + PP.SHOT_ACCEL * dt);
        sh.vx *= nsp / sp; sh.vy *= nsp / sp;
        sp = nsp;
      }
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      sh.roll += sp * dt;   // 転がりも実速度に追従させる
      sh.view.x = sh.x; sh.view.y = sh.y;
      sh.view.spin.rotation = -sh.roll * PP.SPIN_K;
      // ボス戦: 玉列の隙間を抜けて上まで届いた弾がクラーケンに当たる。
      // ボスの当たり判定はレーンよりほぼ上にあるので、チェーン判定より先で良い
      if (g.bossMode && PP.boss.hitTest(sh.x, sh.y)) {
        var bdmg = sh.special === "bomb" ? PP.BOSS.dmg.bomb : PP.BOSS.dmg.shot;
        if (sh.special === "bomb") {
          PP.chain.explodeAt(sh.x, sh.y);   // 爆風の演出ごと炸裂
          _posDirty = true;                 // 爆風で列が変わったかもしれない
        }
        PP.boss.onHit(bdmg, sh.x, sh.y);
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        continue;
      }
      // 画面外
      if (sh.x < -R * 2 || sh.x > PP.W + R * 2 || sh.y < -R * 2 || sh.y > PP.H + R * 2) {
        // 外した爆弾は不発のまま画面外へ
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        continue;
      }
      // チェーンとの衝突(全レーンで最近接の玉)。立体交差では、画面上で重なる
      // 上下の帯のうち「見えている上の帯」を優先する(スコアを少し下げて同点付近
      // で勝たせる)。トンネル内の玉(隠れている)は当たり判定から外す=撃てない。
      // 命中の可否判定そのものは実距離で行う。
      if (_posDirty) refreshBallPos();
      var bestLane = -1, bestI = -1, bestScore = Infinity, bestDist = Infinity;
      var OVER_BIAS = (D * 0.6) * (D * 0.6);
      // 命中に必要な距離²(下の判定と同じ値)。score は最悪でも dist - OVER_BIAS
      // なので、dist ≥ HIT_R2 + OVER_BIAS の玉は「命中し得る玉」(score < HIT_R2)
      // に絶対勝てない = 飛ばしても結果は変わらない。まず dy だけで粗く弾く。
      var HIT_R2 = (D * 0.92) * (D * 0.92);
      var SKIP_R2 = HIT_R2 + OVER_BIAS;
      for (var li = 0; li < _cacheN; li++) {
        var c = _cache[li];
        for (var i = 0; i < c.n; i++) {
          var dy = sh.y - c.by[i];
          if (dy * dy >= SKIP_R2) continue;   // 縦距離だけで既に候補外
          var b = c.balls[i];
          // 宝玉は割り込みの対象外。ただし爆弾は宝玉に当たっても起爆する
          if (b.treasure && sh.special !== "bomb") continue;
          if (b.d < R) continue;    // まだ洞窟の中
          if (c.btun[i]) continue;  // トンネル内=隠れていて撃てない
          var dx = sh.x - c.bx[i];
          var dist = dx * dx + dy * dy;
          if (dist >= SKIP_R2) continue;      // 実距離でも候補外(遮蔽判定より先に安く弾く)
          // 下の帯の玉が橋の桁の下に隠れているなら撃てない(見えている上の帯を撃つ)
          if (!c.bover[i] && occludedByDeck(c.bx[i], c.by[i])) continue;
          var score = dist;
          if (c.bover[i]) score -= OVER_BIAS;
          if (score < bestScore) { bestScore = score; bestDist = dist; bestI = i; bestLane = li; }
        }
      }
      if (bestI >= 0 && bestDist < HIT_R2) {
        var hitLane = _cache[bestLane].lane;
        if (sh.special === "bomb") PP.chain.explodeAt(sh.x, sh.y);
        else if (sh.wild) PP.chain.wildBlast(hitLane, sh, bestI);   // 虹玉は炸裂(挿入しない)
        else PP.chain.insertShot(hitLane, sh, bestI);
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        _posDirty = true;  // 割り込み/爆発で列が変わった → 次弾は座標を引き直す
      }
    }
  }

  PP.cannon = {
    x: PP.W / 2,
    y: PP.CANNON_Y,
    build: build,
    setX: setX,
    forceX: forceX,
    fire: fire,
    swap: swap,
    loadBomb: loadBomb,
    loadSpecial: loadSpecial,
    toggleSpecial: toggleSpecial,
    hitStock: hitStock,
    refreshBalls: refreshBalls,
    syncColors: syncColors,
    updateAim: updateAim,
    updateGuide: updateGuide,   // 現在位置ガイド(main.js の tick が毎フレーム呼ぶ)
    updateShots: updateShots,
    setHurt: setHurt,        // 被弾側(boss.js / skull.js)が無敵秒数を渡す
    clearHurt: clearHurt,    // ステージリセット時の点滅解除
    updateHurt: updateHurt   // main.js の tick が毎フレーム呼ぶ
  };
})();
