/* =========================================================
 * boss.js — ボス戦(クラーケンの海域)
 *
 * Stage 5 クリア後の最終ステージ。画面上部をクラーケンが往復し、
 * 中央には蛇行3レーンの玉列が絶え間なく流れ込む(補給は chain.js)。
 * 樽あふれ=ゲームオーバーは通常ステージと同じ。勝利条件だけが違い、
 * プレイヤーの弾をボス本体に当てて HP(PP.BOSS.hp)を削り切れば勝ち。
 * 「消して樽を守る」弾と「穴からボスを撃つ」弾が同じ1発なのが駆け引きの軸。
 *
 * 攻撃は弾幕シューティング式。状態異常は勝手にかからない:
 *   予兆(チャージリング+宣言)→ ボスが妖弾を発射 → 大砲に当たったときだけ発動
 * 対抗手段は3つ:
 *   1) 横移動でかわす(妖弾は見てから避けられる速さ)
 *   2) 自分の弾をぶつけて迎撃する(通常弾は1発と交換。ミサイルは貫通で消えない)
 *   3) 予兆中にボスへダメージを与えると攻撃そのものをキャンセル
 *      (予兆中はボスの移動が遅くなる=撃ち込みの狙い目)
 * 状態異常の残り秒数 PP.game.bossFx の減算はこのファイルの update() ただ
 * 1か所でだけ行う。消費側(main.js / cannon.js)は「> 0 か」を読むだけなので、
 * タイマーが 0 になれば入力・弾速・視界は必ず通常へ戻る。
 *   ink      タコスミ     … 山なりの墨玉×5。着弾点に墨だまり、直撃なら大きく視界妨害
 *   addle    Addle!!      … 速い単発。被弾でマウス左右反転(main.js の aimStageX)
 *   freeze   停止!        … 7方向の扇弾。被弾で大砲の移動・発射不能(cannon.js)
 *   shotSlow 時間の滞留   … 大きく遅い弾。被弾で発射玉が極端に遅くなる(stepShots)
 *   randomize ランダマイズ … 被弾でチェーン全体の色がシャッフルされる(chain.js)
 *   tentacle 触手突き上げ … 大砲の高さに⚠予告 → 画面下から触手が突き上げ、
 *                           範囲内にいるとランダムなデバフ。予告中が最大の撃ち込み時
 *   tsunami  大津波       … 光の安全柱以外の低空を水壁が横断。柱の外だと押し流される
 *   barrage  妖弾の雨     … 下向きの扇弾幕を複数ボレー。隙間を縫うか撃ち落とす
 * 同種の重ね掛けは抽選時に「効果中の技」を候補から外して防ぐ。HP が半分を切ると
 * 怒りフェーズ: 攻撃間隔短縮・弾速アップ・発射後のコンボ追撃(短予兆の ink/freeze)。
 * 通知は「技名バナー(画面上部の帯)+HUD の状態異常チップ」の2系統に整理し、
 * 発生・解除のたびに文字を飛ばすことはしない。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var built = false;      // 表示物を組み立て済みか(初回の setActive(true) で組む)
  var active = false;     // ボス戦中か

  // ---- 表示物 ----
  var cont = null;        // fx レイヤー内の入れ物(本体+妖弾+墨)。玉より上・大砲/HUDより下
  var body = null;        // クラーケン本体(頭・目・触手)。x,y = 頭の中心
  var tentShape = null;   // 触手(毎フレーム描き直す)
  var pupilL = null, pupilR = null;   // 瞳(大砲を目で追う)
  var charge = null;      // 予兆のチャージリング(telegraph 中だけ描く)
  var hurt = null;        // 被弾の白フラッシュ(頭に重ねる)
  var inkCont = null;     // 墨だまりの入れ物
  var bulletCont = null;  // 妖弾の入れ物
  var inkBlobs = [];      // {sh, bx, by, ph, life}
  var bullets = [];       // {type, x, y, vx, vy, grav, r, view, t}
  var hpCont = null;      // HUD レイヤー内の HP バー(枠・バー・ラベル・状態チップ)
  var hpBarSh = null, hpLabel = null, fxChips = null;
  var lastHpDrawn = -1, lastChipText = null;
  var eyeGlows = [];      // 目の奥の赤いグロー(明滅)
  var biolumA = null, biolumB = null;   // 生体発光(A=青緑/通常、B=血赤/怒り)
  var rageRim = null;     // 怒りフェーズの赤いリムライト
  var warnCont = null;    // ⚠予告マーカーの入れ物(妖弾より下)
  var warnings = [];      // {x, y, r, timer, total, sh, txt, onResolve}
  var strikeCont = null;  // 突き上げ触手・津波の入れ物
  var strikes = [];       // 突き上げ触手 {sh, x, timer, phase}
  var wave = null;        // 津波 {sh, x, dir, safeX, hitDone}
  var safePillar = null;  // 津波の安全地帯(光の柱)
  var banner = null, bannerText = null, bannerTween = null;   // 技名バナー

  // ---- 戦闘状態 ----
  var t = 0;              // 演出用の時計(dt 積算なのでポーズで止まる)
  var moveT = 0;          // 移動用の時計(予兆中は telegraphSlow 倍で遅く進む)
  var hp = 0;
  var iFrames = 0;        // 被弾後の無敵(1発のサブステップ多重ヒット防止)
  var hurtT = 0;          // 被弾フラッシュの残り
  var state = "idle";     // idle → telegraph → recover → idle / dying → dead
  var stateT = 0;         // いまの状態の残り秒
  var curAttack = null;   // telegraph 中の攻撃キー
  var lastAttack = null;  // 直前に使った攻撃(連続で同じ技は使わない)
  var victoryPending = false, victoryConsumed = false;
  var phase2 = false;     // 怒りフェーズ(HP が phase2.hpRatio 以下)
  var attackCount = 0;    // 使った攻撃の回数(⚠攻撃は2回目以降に解禁)
  var queuedAttack = null;               // 怒りフェーズのコンボ追撃(recover 後に短予兆で撃つ)
  var curTeleTotal = 1;   // いまの予兆の全長(drawCharge の進行度用)
  var tsuSafeX = 0, tsuDir = 1;          // 津波の安全地帯と進行方向
  var barrageLeft = 0, barrageT = 0;     // 弾幕の残りボレー数と次弾までの秒

  // ランダマイズ(色ルーレット)は攻撃状態と独立に回す
  var rndSpinT = 0, rndStepT = 0, rndOrig = 0;

  // 攻撃の定義(色は予兆リング・妖弾・宣言バナーに使う)
  var ATTACKS = {
    ink:       { name: "🦑 タコスミ!!",     color: "#8a97a8" },
    addle:     { name: "🌀 Addle!!",         color: "#ff5d8f" },
    freeze:    { name: "⚓ 停止!!",          color: "#ffd24a" },
    shotSlow:  { name: "⏳ 時間の滞留",      color: "#c46ffb" },
    randomize: { name: "🎲 ランダマイズ!!",  color: "#8ef0d0" },
    tentacle:  { name: "🐙 触手突き上げ!!", color: "#ff5030" },
    tsunami:   { name: "🌊 大津波!!",        color: "#4ac8e8" },
    barrage:   { name: "☄️ 妖弾の雨!!",     color: "#ffa040" }
  };
  var ATTACK_KEYS = ["ink", "addle", "freeze", "shotSlow", "randomize",
                     "tentacle", "tsunami", "barrage"];

  // ---------- クラーケンの作画 ----------
  // 既存の砲台・玉と同じ「ベクター+グラデーション」の文法で描く。
  // 深海の闇に溶ける青黒い外套膜、歴戦の傷跡、血赤にギラつくスリット瞳、
  // 骨白の牙。下から8本の太い触手がうねる(毎フレーム tentShape に描き直す)。
  // HP半分の怒りフェーズでは生体発光が血赤に変わり、輪郭が赤く燃える。
  function buildBody() {
    body = new createjs.Container();
    body.scaleX = body.scaleY = 1.12;   // ひと回り大きく(当たり判定は config で別管理)

    // 触手(頭より下に描くので先に追加)
    tentShape = new createjs.Shape();
    body.addChild(tentShape);

    // 頭(外套膜): 上へ膨らむドーム+下すぼまり。深緑〜青黒の放射グラデ
    var head = new createjs.Shape();
    var hg = head.graphics;
    hg.beginRadialGradientFill(["#2e5c4a", "#1a3028", "#0c1a14"], [0, 0.55, 1],
        -24, -46, 10, 0, -20, 110)
      .moveTo(-78, 26)
      .curveTo(-96, -40, -52, -88)    // 左肩 → 頭頂へ
      .curveTo(0, -122, 52, -88)      // 頭頂の丸み
      .curveTo(96, -40, 78, 26)       // 右肩へ
      .curveTo(40, 46, 0, 46)         // あご下
      .curveTo(-40, 46, -78, 26)
      .closePath();
    // 輪郭(闇に沈み切らないよう黒で締める)
    hg.setStrokeStyle(2.5).beginStroke("rgba(0,0,0,0.9)")
      .moveTo(-78, 26)
      .curveTo(-96, -40, -52, -88)
      .curveTo(0, -122, 52, -88)
      .curveTo(96, -40, 78, 26);
    // 頭頂の照り返し(月光。嵐の海なので鈍く)
    hg.endStroke().beginFill("rgba(180,220,200,0.10)")
      .drawEllipse(-52, -100, 62, 30);
    // 額の斑点(深海生物の模様)
    hg.beginFill("rgba(6,18,12,0.55)");
    hg.drawCircle(-30, -66, 7).drawCircle(6, -80, 5).drawCircle(34, -60, 6)
      .drawCircle(-6, -52, 4).drawCircle(48, -34, 4).drawCircle(-48, -38, 5);
    // 歴戦の傷跡: 頭を斜めに横切る太い裂傷+瘢痕、小傷2本
    hg.setStrokeStyle(4, "round").beginStroke("#41604f")
      .moveTo(-58, -84).lineTo(-38, -70).lineTo(-44, -58).lineTo(-24, -44).endStroke();
    hg.setStrokeStyle(1.5, "round").beginStroke("rgba(150,180,160,0.35)")
      .moveTo(-61, -82).lineTo(-41, -68).lineTo(-47, -56).lineTo(-27, -42).endStroke();
    hg.setStrokeStyle(2.5, "round").beginStroke("#3a564a")
      .moveTo(44, -92).lineTo(56, -74).endStroke()
      .setStrokeStyle(2, "round").beginStroke("#3a564a")
      .moveTo(60, -50).lineTo(74, -38).endStroke();
    // 刺さったままの銛の折れ先(討ち損じの証)
    hg.setStrokeStyle(3.5, "butt").beginStroke("#6a5238")
      .moveTo(58, -70).lineTo(72, -88).endStroke();
    hg.beginFill("#8a8a92").moveTo(70, -85).lineTo(78, -96).lineTo(75, -83).closePath();
    body.addChild(head);

    // 生体発光の斑点(通常=青緑 / 怒り=血赤 の2セットを重ね、alpha で切替+明滅)
    biolumA = new createjs.Shape();
    biolumB = new createjs.Shape();
    var spots = [[-62, -52, 3], [-40, -84, 2.5], [-14, -98, 3], [16, -96, 2.5],
                 [42, -78, 3], [64, -46, 2.5], [-70, -20, 2], [70, -14, 2]];
    for (var si = 0; si < spots.length; si++) {
      biolumA.graphics.beginFill("#39d8b8").drawCircle(spots[si][0], spots[si][1], spots[si][2]);
      biolumB.graphics.beginFill("#ff5030").drawCircle(spots[si][0], spots[si][1], spots[si][2]);
    }
    biolumA.compositeOperation = biolumB.compositeOperation = "lighter";
    biolumB.alpha = 0;
    body.addChild(biolumA, biolumB);

    // 怒りフェーズの赤いリムライト(普段は透明。enterPhase2 で灯る)
    rageRim = new createjs.Shape();
    rageRim.graphics.setStrokeStyle(5).beginStroke("rgba(255,60,40,0.55)")
      .moveTo(-78, 26)
      .curveTo(-96, -40, -52, -88)
      .curveTo(0, -122, 52, -88)
      .curveTo(96, -40, 78, 26);
    rageRim.compositeOperation = "lighter";
    rageRim.alpha = 0;
    body.addChild(rageRim);

    // 目(血赤の眼球+縦スリット瞳)。瞳は update で大砲の方を向く。
    // 目の奥のグローが明滅して「見られている」圧を作る
    function makeEye(ex) {
      var glow = new createjs.Shape();
      glow.graphics.beginRadialGradientFill(
          ["rgba(255,60,40,0.7)", "rgba(255,60,40,0)"], [0, 1], 0, 0, 0, 0, 0, 30)
        .drawCircle(0, 0, 30);
      glow.compositeOperation = "lighter";
      glow.x = ex; glow.y = -18;
      eyeGlows.push(glow);
      var eye = new createjs.Shape();
      eye.graphics
        .beginRadialGradientFill(["#ffb090", "#cc2222", "#5a0505"], [0, 0.55, 1],
          0, 0, 2, 0, 0, 17)
        .drawEllipse(-15, -17, 30, 34)
        .setStrokeStyle(2).beginStroke("#050a08").drawEllipse(-15, -17, 30, 34);
      eye.x = ex; eye.y = -18;
      var pupil = new createjs.Shape();
      pupil.graphics.beginFill("#050202").drawEllipse(-2.8, -13, 5.6, 26);
      pupil.x = ex; pupil.y = -18;
      body.addChild(glow, eye, pupil);
      return pupil;
    }
    eyeGlows.length = 0;
    pupilL = makeEye(-36);
    pupilR = makeEye(36);

    // 怒り眉(目の上に深く落ちる影のヒレ)
    var browL = new createjs.Shape();
    browL.graphics.beginFill("#06120c").moveTo(-62, -48).lineTo(-12, -38).lineTo(-54, -24).closePath();
    var browR = new createjs.Shape();
    browR.graphics.beginFill("#06120c").moveTo(62, -48).lineTo(12, -38).lineTo(54, -24).closePath();
    body.addChild(browL, browR);

    // くちばし(大きく裂けた口+骨白の牙)。妖弾はここから吐き出される
    var beak = new createjs.Shape();
    beak.graphics
      .beginFill("#0a0f0c").moveTo(-14, 14).lineTo(0, 34).lineTo(14, 14).closePath()
      .beginFill("rgba(200,40,30,0.4)").moveTo(-8, 17).lineTo(0, 28).lineTo(8, 17).closePath()
      // 牙(上あご2本+下あご2本)
      .beginFill("#d8d2b8")
      .moveTo(-12, 15).lineTo(-8, 24).lineTo(-5, 15).closePath()
      .moveTo(12, 15).lineTo(8, 24).lineTo(5, 15).closePath()
      .moveTo(-4, 30).lineTo(-2, 22).lineTo(1, 29).closePath()
      .moveTo(5, 29).lineTo(3, 22).lineTo(0, 28).closePath();
    body.addChild(beak);

    // 被弾の白フラッシュ(普段は透明)
    hurt = new createjs.Shape();
    hurt.graphics.beginFill("#ffffff")
      .moveTo(-78, 26).curveTo(-96, -40, -52, -88).curveTo(0, -122, 52, -88)
      .curveTo(96, -40, 78, 26).curveTo(40, 46, 0, 46).curveTo(-40, 46, -78, 26).closePath();
    hurt.alpha = 0;
    body.addChild(hurt);

    return body;
  }

  // 触手を描き直す(8本。sin で位相をずらしてうねらせる)。
  // dying 中は droop(0→1)でだらりと垂れ下がる。
  function drawTentacles(droop) {
    var g = tentShape.graphics;
    g.clear();
    for (var i = 0; i < 8; i++) {
      var bx = -70 + i * 20;                       // 付け根(あご下に等間隔)
      var ph = i * 1.7;
      var sway = Math.sin(t * 2.0 + ph) * 24 * (1 - droop * 0.8);
      var reach = 126 + Math.sin(t * 1.3 + ph * 1.3) * 22;
      var ex = bx * 1.7 + sway * 2;                // 先端(外へ開きつつ揺れる)
      var ey = 34 + reach + droop * 46;
      var cx = bx * 1.15 + sway;                   // 中間の制御点
      var cy = 34 + reach * 0.45;
      // 太い根元 → 細い先端の2段描き(ストローク幅は1本の線で変えられないため)
      g.setStrokeStyle(22, "round").beginStroke("#14261e")
        .moveTo(bx, 30).quadraticCurveTo(cx, cy, (cx + ex) / 2, (cy + ey) / 2).endStroke();
      g.setStrokeStyle(12, "round").beginStroke("#1e3830")
        .moveTo((cx + ex) / 2 - 1, (cy + ey) / 2).quadraticCurveTo(ex, ey - 18, ex + sway * 0.4, ey).endStroke();
      // 吸盤(血の気を帯びた赤。生々しさを出す)と先端の丸
      g.beginFill("rgba(200,80,60,0.45)")
        .drawCircle((bx + cx) / 2, (30 + cy) / 2, 3.4)
        .drawCircle(cx, cy + 10, 3.0)
        .drawCircle((cx + ex) / 2, (cy + ey) / 2 + 8, 2.4)
        .drawCircle((cx + ex * 2) / 3, (cy + ey * 2) / 3 + 4, 2.0);
      g.beginFill("#1e3830").drawCircle(ex + sway * 0.4, ey, 6.5);
    }
  }

  // ---------- 組み立て ----------
  function build() {
    built = true;
    cont = new createjs.Container();
    cont.mouseEnabled = false;

    inkCont = new createjs.Container();   // 墨は本体より下(ボスは墨の上に見える)
    cont.addChild(inkCont);

    charge = new createjs.Shape();        // 予兆リング(本体の後ろで光る)
    cont.addChild(charge);

    cont.addChild(buildBody());

    warnCont = new createjs.Container();  // ⚠予告マーカー(妖弾・触手より下)
    cont.addChild(warnCont);

    strikeCont = new createjs.Container();  // 突き上げ触手・津波
    cont.addChild(strikeCont);

    bulletCont = new createjs.Container();  // 妖弾は本体より手前
    cont.addChild(bulletCont);

    // 技名の宣言バナー(画面上部を横切る半透明の帯。fx レイヤー最上段)
    banner = new createjs.Container();
    banner.mouseEnabled = false;
    var bband = new createjs.Shape();
    bband.graphics.beginLinearGradientFill(
        ["rgba(0,0,0,0)", "rgba(0,0,0,0.6)", "rgba(0,0,0,0.6)", "rgba(0,0,0,0)"],
        [0, 0.18, 0.82, 1], 0, 0, PP.W, 0)
      .drawRect(0, -26, PP.W, 52);
    bannerText = new createjs.Text("", '700 30px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffffff");
    bannerText.textAlign = "center"; bannerText.textBaseline = "middle";
    bannerText.x = PP.W / 2;
    bannerText.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    banner.addChild(bband, bannerText);
    banner.y = 160;
    banner.visible = false;
    cont.addChild(banner);

    // fx レイヤーの最背面へ: 粒子・リング等の演出はボスより手前に出る。
    // fx は玉より上・大砲/危機/HUD より下なので、墨・妖弾は盤面の上を通るが
    // 操作系(大砲・HUD)は隠さない
    PP.layers.fx.addChildAt(cont, 0);

    // ---- HP バー(HUD レイヤー。HUD バーのすぐ下に真鍮枠で置く)----
    hpCont = new createjs.Container();
    hpCont.mouseEnabled = false;
    hpLabel = new createjs.Text("🐙 クラーケン", '700 15px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ff9a8a");
    hpLabel.textAlign = "right"; hpLabel.textBaseline = "middle";
    hpLabel.x = 430; hpLabel.y = 80;
    hpLabel.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 2, 4);
    hpBarSh = new createjs.Shape();
    fxChips = new createjs.Text("", '600 14px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#ffd8a8");
    fxChips.textAlign = "left"; fxChips.textBaseline = "middle";
    fxChips.x = 880; fxChips.y = 80;
    fxChips.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 2, 4);
    hpCont.addChild(hpBarSh, hpLabel, fxChips);
    PP.layers.hud.addChild(hpCont);
  }

  var HP_X = 440, HP_Y = 72, HP_W = 420, HP_H = 16;
  function drawHpBar() {
    if (hp === lastHpDrawn) return;
    lastHpDrawn = hp;
    var g = hpBarSh.graphics;
    g.clear();
    g.beginFill("rgba(4,8,12,0.7)").drawRoundRect(HP_X, HP_Y, HP_W, HP_H, 8);
    var ratio = Math.max(0, hp / PP.BOSS.hp);
    if (ratio > 0) {
      g.beginLinearGradientFill(["#ff9a8a", "#e03838", "#7a1420"], [0, 0.5, 1],
          0, HP_Y, 0, HP_Y + HP_H)
        .drawRoundRect(HP_X + 1.5, HP_Y + 1.5, Math.max(6, (HP_W - 3) * ratio), HP_H - 3, 6);
      g.beginFill("rgba(255,255,255,0.25)")
        .drawRoundRect(HP_X + 2.5, HP_Y + 2.5, Math.max(4, (HP_W - 5) * ratio), 3, 2);
    }
    g.setStrokeStyle(1.5).beginStroke("#c9a86a").drawRoundRect(HP_X, HP_Y, HP_W, HP_H, 8);
  }

  // 状態異常チップ(アイコン+残り秒)。文字列が変わったときだけ差し替える
  function updateChips() {
    var fx = PP.game.bossFx;
    var parts = [];
    if (fx.ink > 0) parts.push("🦑" + Math.ceil(fx.ink));
    if (fx.addle > 0) parts.push("🌀" + Math.ceil(fx.addle));
    if (fx.freeze > 0) parts.push("⚓" + Math.ceil(fx.freeze));
    if (fx.shotSlow > 0) parts.push("⏳" + Math.ceil(fx.shotSlow));
    if (rndSpinT > 0) parts.push("🎲");
    var s = parts.join(" ");
    if (s !== lastChipText) { lastChipText = s; fxChips.text = s; }
  }

  // ---------- 妖弾(ボスの弾幕) ----------
  // type: "ink"(山なりの墨玉) / "addle" / "freeze" / "shotSlow" / "randomize"(直進オーブ)
  function makeOrbView(type) {
    var sh = new createjs.Shape();
    if (type === "ink") {
      sh.graphics
        .beginRadialGradientFill(["#3a2a48", "#16101e", "rgba(10,8,14,0.4)"], [0, 0.7, 1],
          -4, -4, 2, 0, 0, 20)
        .drawCircle(0, 0, 18)
        .beginFill("rgba(210,160,235,0.25)").drawCircle(-6, -7, 5);
    } else {
      var col = ATTACKS[type].color;
      var r = (type === "shotSlow") ? PP.BOSS.shotSlow.r : PP.BOSS.orb.r;
      sh.graphics
        .beginRadialGradientFill(["#ffffff", col, "rgba(0,0,0,0)"], [0, 0.45, 1],
          0, 0, 0, 0, 0, r * 1.7)
        .drawCircle(0, 0, r * 1.7)
        .setStrokeStyle(2).beginStroke(col).drawCircle(0, 0, r);
    }
    return sh;
  }

  function spawnBullet(type, x, y, vx, vy, grav, r) {
    var view = makeOrbView(type);
    view.x = x; view.y = y;
    bulletCont.addChild(view);
    bullets.push({ type: type, x: x, y: y, vx: vx, vy: vy, grav: grav || 0,
                   r: r, view: view, t: Math.random() * 6.28 });
  }

  function clearBullets() {
    for (var i = 0; i < bullets.length; i++) {
      if (bullets[i].view.parent) bullets[i].view.parent.removeChild(bullets[i].view);
    }
    bullets.length = 0;
  }

  // 妖弾の進行: 移動 → 自弾との迎撃 → 大砲への命中 → 着弾/画面外の後始末
  function updateBullets(dt) {
    if (bullets.length === 0) return;
    var g = PP.game;
    var O = PP.BOSS.orb;
    var cx = PP.cannon.x, cy = PP.cannon.y;
    for (var i = bullets.length - 1; i >= 0; i--) {
      var b = bullets[i];
      b.vy += b.grav * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.t += dt;
      b.view.x = b.x; b.view.y = b.y;
      var pulse = 1 + 0.12 * Math.sin(b.t * 10);
      b.view.scaleX = b.view.scaleY = pulse;

      // 迎撃: 自分の弾(通常弾・爆弾)をぶつけると相殺して消せる。
      // ミサイルは貫通なので消費せずに薙ぎ払える
      var blocked = false;
      for (var s = g.shots.length - 1; s >= 0; s--) {
        var sh = g.shots[s];
        var dx = sh.x - b.x, dy = sh.y - b.y;
        var rr = b.r + PP.R * 0.9;
        if (dx * dx + dy * dy < rr * rr) {
          PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 10, 1.2);
          PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 34);
          PP.fx.floatText("迎撃!", b.x, b.y - 26, "#8ef0d0", 18);
          PP.audio.beep(720, 0.1, "square", 0.08);
          if (sh.special !== "missile") {   // 通常弾は1発と交換
            if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
            PP.layers.shot.removeChild(sh.view);
            g.shots.splice(s, 1);
          }
          blocked = true;
          break;
        }
      }
      if (blocked) { removeBullet(i); continue; }

      // 大砲への命中(powerups のキャッチ箱と同じ寸法感)
      if (Math.abs(b.x - cx) <= O.catchW &&
          b.y >= cy - O.catchTop && b.y <= cy + O.catchBottom) {
        applyOrbHit(b);
        removeBullet(i);
        continue;
      }

      // 墨玉は大砲の高さまで落ちたら着弾(外れても足元に墨だまりが残る)
      if (b.type === "ink" && b.y >= cy - 30) {
        splatInk(b.x, Math.min(b.y, cy - 30), false);
        removeBullet(i);
        continue;
      }
      // 画面外
      if (b.y > PP.H + 40 || b.x < -60 || b.x > PP.W + 60) removeBullet(i);
    }
  }

  function removeBullet(i) {
    var b = bullets[i];
    if (b.view.parent) b.view.parent.removeChild(b.view);
    bullets.splice(i, 1);
  }

  // デバフの付与(妖弾の直撃・触手突き上げの双方から呼ぶ)。
  // 通知は HUD の状態異常チップ(updateChips)に一本化し、文字は飛ばさない
  function applyDebuff(type, durMul) {
    var g = PP.game;
    var B = PP.BOSS;
    var mul = durMul || 1;
    if (type === "addle") {
      g.bossFx.addle = B.addle.dur * mul;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ff5d8f", 10, 90, 500);
    } else if (type === "freeze") {
      g.bossFx.freeze = B.freeze.dur * mul;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffd24a", 10, 90, 500);
    } else if (type === "shotSlow") {
      g.bossFx.shotSlow = B.shotSlow.dur * mul;
      PP.fx.screenFlash("rgba(138,32,216,0.22)", 0.22, 600);
    }
  }

  // 妖弾が大砲に当たった: ここで初めて状態異常がかかる
  function applyOrbHit(b) {
    var g = PP.game;
    var B = PP.BOSS;
    PP.fx.shake(8, 0.25);
    PP.audio.beep(150, 0.25, "sawtooth", 0.12);
    if (b.type === "ink") {
      splatInk(b.x, b.y, true);     // 直撃は大きな目つぶし
      g.bossFx.ink = B.ink.dur;
    } else if (b.type === "addle" || b.type === "freeze" || b.type === "shotSlow") {
      applyDebuff(b.type, 1);
    } else if (b.type === "randomize" || b.type === "barrage") {
      // barrage 弾も当たれば色ルーレット(弾幕を全部は捌けない前提の軽いペナルティ)
      rndSpinT = B.randomize.spin;
      rndStepT = 0;
      rndOrig = g.currentColor;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 10, 70, 400);
    }
  }

  // ---------- 墨だまり(タコスミの着弾跡) ----------
  // direct=true(大砲に直撃)は大きな墨が視界の中心も覆う。外れた墨玉も
  // 着弾点に墨だまりを残す(避けても足元の視界は少し悪くなる)
  function splatInk(x, y, direct) {
    var B = PP.BOSS.ink;
    var n = direct ? 3 : 1;
    for (var i = 0; i < n; i++) {
      var r = B.rMin + Math.random() * (B.rMax - B.rMin);
      var bx = x, by = y;
      if (direct && i > 0) {        // 直撃は追加の墨が盤面中央へ飛び散る
        bx = 250 + Math.random() * (PP.W - 500);
        by = 220 + Math.random() * 260;
        r *= 1.15;
      }
      var sh = new createjs.Shape();
      sh.graphics.beginRadialGradientFill(
        ["rgba(10,8,14,0.98)", "rgba(10,8,14,0.9)", "rgba(10,8,14,0)"], [0, 0.6, 1],
        0, 0, 0, 0, 0, r).drawCircle(0, 0, r);
      sh.x = bx; sh.y = by;
      sh.alpha = 0;
      createjs.Tween.get(sh).to({ alpha: 1 }, 220);
      inkCont.addChild(sh);
      inkBlobs.push({ sh: sh, bx: bx, by: by, ph: Math.random() * 6.28, life: B.dur });
    }
    PP.fx.burst(x, y, "rgba(20,14,26,0.9)", 14, 1.5);
  }

  function removeInk() {
    for (var i = 0; i < inkBlobs.length; i++) {
      createjs.Tween.removeTweens(inkBlobs[i].sh);
      if (inkBlobs[i].sh.parent) inkBlobs[i].sh.parent.removeChild(inkBlobs[i].sh);
    }
    inkBlobs.length = 0;
  }

  function updateInk(dt) {
    for (var i = inkBlobs.length - 1; i >= 0; i--) {
      var b = inkBlobs[i];
      b.life -= dt;
      if (b.life <= 0) {
        createjs.Tween.removeTweens(b.sh);
        if (b.sh.parent) b.sh.parent.removeChild(b.sh);
        inkBlobs.splice(i, 1);
        continue;
      }
      b.sh.x = b.bx + Math.sin(t * 0.7 + b.ph) * 10;
      b.sh.y = b.by + Math.cos(t * 0.5 + b.ph) * 6;
      // 残り 0.8 秒からゆっくり薄れて消える(突然消えるより「晴れていく」)
      if (b.life < 0.8) b.sh.alpha = b.life / 0.8;
    }
  }

  // ---------- 攻撃の選択と発射 ----------
  // 次の攻撃を選ぶ。直前と同じ技は使わない。念のため、効果が残っている
  // 操作妨害系(addle/freeze/shotSlow)も候補から外す(クールダウンが効果より
  // 長いので通常は起きないが、数値をいじられても重ね掛けにならない保険)
  function pickAttack() {
    var fx = PP.game.bossFx;
    var pool = [];
    for (var i = 0; i < ATTACK_KEYS.length; i++) {
      var k = ATTACK_KEYS[i];
      if (k === lastAttack) continue;
      if ((k === "addle" || k === "freeze" || k === "shotSlow") && fx[k] > 0) continue;
      if (k === "ink" && fx.ink > 0) continue;
      // ⚠系の大技は開幕からは撃たない(初見殺し防止)。進行中の同系統も避ける
      if ((k === "tentacle" || k === "tsunami" || k === "barrage") && attackCount < 1) continue;
      if (k === "tsunami" && wave) continue;
      if (k === "barrage" && barrageLeft > 0) continue;
      if (k === "randomize" && rndSpinT > 0) continue;
      pool.push(k);
    }
    if (pool.length === 0) pool = ATTACK_KEYS.slice();
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // 技名バナー: 画面上部の帯に技名を宣言(floatText より視認性が高く、
  // プレイヤーの視線がある盤面〜大砲から必ず視界に入る)
  function showBanner(name, color, dur) {
    if (!banner) return;
    if (bannerTween) bannerTween.setPaused(true);
    bannerText.text = name;
    bannerText.color = color;
    banner.visible = true;
    banner.alpha = 0;
    bannerText.x = PP.W / 2 - 60;
    bannerTween = createjs.Tween.get(banner, { override: true })
      .to({ alpha: 1 }, 150)
      .wait(Math.max(200, dur * 1000 - 450))
      .to({ alpha: 0 }, 300)
      .call(function () { banner.visible = false; });
    createjs.Tween.get(bannerText, { override: true })
      .to({ x: PP.W / 2 }, 260, createjs.Ease.quadOut);
  }

  function hideBanner() {
    if (!banner) return;
    if (bannerTween) bannerTween.setPaused(true);
    createjs.Tween.removeTweens(banner);
    createjs.Tween.removeTweens(bannerText);
    banner.visible = false;
  }

  // ⚠予告マーカーを置く(赤い予告サークル+明滅する⚠)。timer 経過で消える。
  // 解決(触手の突き上げ)は fireAttack 側が pendingZones を読んで行う
  var pendingZones = [];
  function addWarning(x, y, r, timer) {
    var sh = new createjs.Shape();
    sh.x = x; sh.y = y;
    var txt = new createjs.Text("⚠", "700 34px sans-serif", "#ffd24a");
    txt.textAlign = "center"; txt.textBaseline = "middle";
    txt.x = x; txt.y = y;
    txt.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    warnCont.addChild(sh, txt);
    warnings.push({ x: x, y: y, r: r, timer: timer, total: timer, sh: sh, txt: txt });
  }

  function clearWarnings() {
    for (var i = 0; i < warnings.length; i++) {
      if (warnings[i].sh.parent) warnCont.removeChild(warnings[i].sh);
      if (warnings[i].txt.parent) warnCont.removeChild(warnings[i].txt);
    }
    warnings.length = 0;
    pendingZones.length = 0;
  }

  // ⚠マーカーの毎フレーム描画(進行で赤リングが収束+脈動、⚠が明滅)
  function updateWarnings(dt) {
    for (var i = warnings.length - 1; i >= 0; i--) {
      var w = warnings[i];
      w.timer -= dt;
      if (w.timer <= 0) {
        if (w.sh.parent) warnCont.removeChild(w.sh);
        if (w.txt.parent) warnCont.removeChild(w.txt);
        warnings.splice(i, 1);
        continue;
      }
      var k = 1 - w.timer / w.total;                 // 0→1 で収束
      var g = w.sh.graphics;
      g.clear();
      g.setStrokeStyle(3).beginStroke("rgba(255,48,32," + (0.5 + 0.3 * Math.sin(t * 12)).toFixed(2) + ")")
        .drawCircle(0, 0, w.r);
      g.beginFill("rgba(255,48,32,0.14)").drawCircle(0, 0, w.r);
      g.setStrokeStyle(2).beginStroke("rgba(255,120,90,0.8)")
        .drawCircle(0, 0, w.r * (1 - k * 0.85));     // 内側へ収束するリング=残り時間
      w.txt.alpha = 0.6 + 0.4 * Math.sin(t * 10);
    }
  }

  function startTelegraph(key, teleOverride) {
    curAttack = key;
    state = "telegraph";
    stateT = teleOverride || PP.BOSS[key].telegraph;
    curTeleTotal = stateT;
    var a = ATTACKS[key];
    // 宣言バナー + 低い唸りの警告音。
    // チャージリングが出ている間にダメージを与えれば攻撃はキャンセルできる
    showBanner(a.name, a.color, stateT + 0.4);
    PP.audio.beep(140, 0.3, "sawtooth", 0.1);
    PP.audio.beep(110, 0.45, "sine", 0.09);

    if (key === "tentacle") {
      // 大砲の高さに⚠を置く(1個は現在の大砲位置=「動け」という圧)
      var K = PP.BOSS.tentacle;
      var zones = phase2 ? K.zones + 1 : K.zones;
      pendingZones.length = 0;
      var zx = PP.cannon.x;
      for (var i = 0; i < zones; i++) {
        if (i > 0) {
          var off = (180 + Math.random() * 140) * (Math.random() < 0.5 ? -1 : 1);
          zx = Math.max(90, Math.min(PP.W - 90, PP.cannon.x + off));
        }
        pendingZones.push(zx);
        addWarning(zx, PP.CANNON_Y - 20, K.r, stateT);
      }
    } else if (key === "tsunami") {
      // 安全地帯(光の柱)を先に見せる。波は fireAttack で走り出す
      var S = PP.BOSS.tsunami;
      tsuSafeX = 200 + Math.random() * (PP.W - 400);
      tsuDir = Math.random() < 0.5 ? 1 : -1;
      showSafePillar(tsuSafeX, S.gapW);
    }
  }

  // 怒りフェーズは全弾速がこの倍率で上がる
  function spdMul() { return phase2 ? PP.BOSS.phase2.speedMul : 1; }

  // 妖弾の発射。すべて口(あご下)から、狙いは発射時点の大砲の位置。
  // 発射後の軌道は固定なので、見てから移動すれば必ずかわせる
  function fireAttack(key) {
    var B = PP.BOSS;
    lastAttack = key;
    attackCount++;
    var sx = body.x, sy = body.y + 38;
    var tx = PP.cannon.x, ty = PP.cannon.y - 20;
    PP.audio.beep(200, 0.15, "square", 0.1);
    PP.fx.flash(sx, sy, "rgba(120,220,180,0.7)", 40);
    if (key === "ink") {
      // 山なりの墨玉: 大砲狙い1発+左右にばら撒き
      var K = B.ink;
      var targets = [tx];
      for (var ti = 1; ti < K.lobs + (phase2 ? 2 : 0); ti++) {
        var side = (ti % 2 === 0) ? 1 : -1;
        targets.push(tx + side * (160 + Math.random() * 320));
      }
      for (var i = 0; i < targets.length; i++) {
        // 放物線: vy0 で軽く浮かせ、grav で落とす。到達時間から vx を逆算
        var fallT = (Math.sqrt(K.vy0 * K.vy0 + 2 * K.grav * (ty - sy)) - K.vy0) / K.grav;
        spawnBullet("ink", sx, sy, (targets[i] - sx) / fallT * spdMul(), K.vy0, K.grav, 18);
      }
    } else if (key === "freeze") {
      // 扇状の弾幕: 中央は大砲狙い、左右は spread ぶんずらす
      var F = B.freeze;
      var fan = F.fan + (phase2 ? 2 : 0);
      for (var f = 0; f < fan; f++) {
        var off = (f - (fan - 1) / 2) * F.spread;
        var dx = (tx + off) - sx, dy = ty - sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        spawnBullet("freeze", sx, sy, dx / len * F.speed * spdMul(), dy / len * F.speed * spdMul(), 0, B.orb.r);
      }
    } else if (key === "tentacle") {
      // ⚠地点へ画面下から触手が突き上げる(範囲内ならランダムなデバフ)
      for (var z = 0; z < pendingZones.length; z++) spawnStrike(pendingZones[z]);
      pendingZones.length = 0;
      PP.fx.shake(10, 0.25);
      PP.audio.beep(90, 0.4, "sawtooth", 0.14);
    } else if (key === "tsunami") {
      startWave();
    } else if (key === "barrage") {
      // 弾幕: ボレー発射は update 側のタイマーで刻む(1発目はすぐ)
      barrageLeft = B.barrage.volleys + (phase2 ? 1 : 0);
      barrageT = 0;
    } else {
      // 単発の狙い撃ち(addle=速い / shotSlow=大きく遅い / randomize=中速)
      var spec = B[key];
      var r = (key === "shotSlow") ? B.shotSlow.r : B.orb.r;
      var ddx = tx - sx, ddy = ty - sy;
      var dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      spawnBullet(key, sx, sy, ddx / dlen * spec.speed * spdMul(), ddy / dlen * spec.speed * spdMul(), 0, r);
    }
  }

  // ---------- 触手突き上げ(⚠地点に画面下から生える) ----------
  function spawnStrike(x) {
    var K = PP.BOSS.tentacle;
    var sh = new createjs.Shape();
    strikeCont.addChild(sh);
    strikes.push({ sh: sh, x: x, timer: K.riseTime + K.holdTime, rise: K.riseTime,
                   hold: K.holdTime, hitDone: false, seed: Math.random() * 6.28 });
  }

  function clearStrikes() {
    for (var i = 0; i < strikes.length; i++) {
      if (strikes[i].sh.parent) strikeCont.removeChild(strikes[i].sh);
    }
    strikes.length = 0;
  }

  function updateStrikes(dt) {
    var K = PP.BOSS.tentacle;
    for (var i = strikes.length - 1; i >= 0; i--) {
      var s = strikes[i];
      s.timer -= dt;
      if (s.timer <= 0) {
        if (s.sh.parent) strikeCont.removeChild(s.sh);
        strikes.splice(i, 1);
        continue;
      }
      // 伸び 0→1(riseTime で急伸)、hold の後は縮んで戻る
      var elapsed = K.riseTime + K.holdTime - s.timer;
      var k = elapsed < s.rise ? (elapsed / s.rise)
            : (s.timer < 0.18 ? s.timer / 0.18 : 1);
      var topY = PP.H - (PP.H - (PP.CANNON_Y - 90)) * k;   // 画面下端 → 大砲の頭上まで
      var g = s.sh.graphics;
      g.clear();
      var sway = Math.sin(t * 6 + s.seed) * 8;
      // 太い触手柱(本体の触手と同配色)+先端のかぎ爪カーブ
      g.setStrokeStyle(30, "round").beginStroke("#14261e")
        .moveTo(s.x, PP.H + 20).quadraticCurveTo(s.x + sway, (PP.H + topY) / 2, s.x + sway * 0.5, topY + 30).endStroke();
      g.setStrokeStyle(16, "round").beginStroke("#1e3830")
        .moveTo(s.x + sway * 0.5, topY + 34).quadraticCurveTo(s.x + sway * 0.5 + 14, topY + 6, s.x + sway * 0.5 - 10, topY).endStroke();
      // 吸盤(血赤)
      g.beginFill("rgba(200,80,60,0.5)");
      for (var d = 0; d < 4; d++) {
        var dy = PP.H - (PP.H - topY - 40) * (d / 4);
        g.drawCircle(s.x + sway * (d / 4), dy, 5 - d * 0.7);
      }
      // 命中判定は伸び切った瞬間に1回だけ
      if (!s.hitDone && k >= 1) {
        s.hitDone = true;
        PP.fx.burst(s.x, PP.CANNON_Y - 60, "#ff5030", 14, 1.6);
        PP.fx.ring(s.x, PP.CANNON_Y - 40, "#ff5030", 20, 120, 400);
        PP.fx.shake(14, 0.3);
        PP.audio.beep(70, 0.3, "sawtooth", 0.16);
        if (Math.abs(PP.cannon.x - s.x) < K.r + 25) {
          var pool = ["freeze", "addle", "shotSlow"];
          applyDebuff(pool[Math.floor(Math.random() * pool.length)], 0.7);
          PP.fx.shake(10, 0.3);
        }
      }
    }
  }

  // ---------- 大津波(低空を横断する水壁。安全柱の中だけが無事) ----------
  function showSafePillar(x, gapW) {
    if (!safePillar) {
      safePillar = new createjs.Shape();
      strikeCont.addChild(safePillar);
    }
    var g = safePillar.graphics;
    g.clear();
    g.beginLinearGradientFill(
        ["rgba(255,246,214,0)", "rgba(255,246,214,0.30)", "rgba(255,246,214,0.30)", "rgba(255,246,214,0)"],
        [0, 0.3, 0.7, 1], x - gapW / 2, 0, x + gapW / 2, 0)
      .drawRect(x - gapW / 2, PP.CANNON_Y - 160, gapW, 200);
    g.setStrokeStyle(2).beginStroke("rgba(255,240,180,0.7)")
      .moveTo(x - gapW / 2, PP.CANNON_Y - 160).lineTo(x - gapW / 2, PP.CANNON_Y + 40)
      .moveTo(x + gapW / 2, PP.CANNON_Y - 160).lineTo(x + gapW / 2, PP.CANNON_Y + 40);
    safePillar.visible = true;
  }

  function hideSafePillar() {
    if (safePillar) { safePillar.graphics.clear(); safePillar.visible = false; }
  }

  function startWave() {
    var S = PP.BOSS.tsunami;
    var sh = new createjs.Shape();
    var g = sh.graphics;
    // 高さ120pxの水壁(進行方向の面が立ち上がる)+泡の稜線
    g.beginLinearGradientFill(
        ["rgba(150,220,240,0.85)", "rgba(60,140,180,0.75)", "rgba(20,60,90,0.65)"],
        [0, 0.4, 1], 0, -120, 0, 0)
      .drawRect(-70, -120, 140, 120);
    g.beginFill("rgba(235,250,255,0.9)");
    for (var i = 0; i < 8; i++) g.drawCircle(-60 + i * 17, -114 + Math.random() * 10, 4 + Math.random() * 4);
    sh.y = PP.CANNON_Y + 30;
    sh.x = tsuDir > 0 ? -80 : PP.W + 80;
    strikeCont.addChild(sh);
    wave = { sh: sh, x: sh.x, dir: tsuDir, hitDone: false };
    PP.audio.beep(60, 0.6, "sawtooth", 0.16);
  }

  function clearWave() {
    if (wave && wave.sh.parent) strikeCont.removeChild(wave.sh);
    wave = null;
    hideSafePillar();
  }

  function updateWave(dt) {
    if (!wave) return;
    var S = PP.BOSS.tsunami;
    wave.x += S.speed * spdMul() * wave.dir * dt;
    wave.sh.x = wave.x;
    wave.sh.scaleY = 1 + 0.06 * Math.sin(t * 14);
    // しぶき
    if (Math.random() < dt * 20) {
      PP.fx.burst(wave.x + (Math.random() - 0.5) * 100, PP.CANNON_Y - 70,
                  "rgba(190,230,246,0.8)", 3, 0.9);
    }
    // 大砲の x を通過した瞬間に判定(安全柱の中なら無事)
    if (!wave.hitDone &&
        ((wave.dir > 0 && wave.x >= PP.cannon.x) || (wave.dir < 0 && wave.x <= PP.cannon.x))) {
      wave.hitDone = true;
      if (Math.abs(PP.cannon.x - tsuSafeX) > S.gapW / 2 - 10) {
        PP.cannon.forceX(PP.cannon.x + S.push * wave.dir);
        PP.game.bossFx.freeze = Math.max(PP.game.bossFx.freeze, S.stun);
        PP.fx.shake(16, 0.35);
        PP.fx.burst(PP.cannon.x, PP.CANNON_Y - 40, "#4ac8e8", 16, 1.8);
        PP.audio.beep(120, 0.3, "sawtooth", 0.14);
      } else {
        PP.fx.ring(PP.cannon.x, PP.CANNON_Y - 60, "#fff6d6", 16, 90, 400);
        PP.audio.beep(880, 0.12, "triangle", 0.08);
      }
    }
    if (wave.x < -100 || wave.x > PP.W + 100) clearWave();
  }

  // ---------- 弾幕(下向きの扇弾を複数ボレー) ----------
  function updateBarrage(dt) {
    if (barrageLeft <= 0) return;
    barrageT -= dt;
    if (barrageT > 0) return;
    var Q = PP.BOSS.barrage;
    barrageT = Q.interval;
    barrageLeft--;
    var sx = body.x, sy = body.y + 38;
    var n = Q.perVolley + (phase2 ? 2 : 0);
    // 扇の中心を「いまの大砲の方向」へ向ける(追い込み)。広がりは±65度
    var aimAng = Math.atan2((PP.CANNON_Y - 20) - sy, PP.cannon.x - sx);
    for (var i = 0; i < n; i++) {
      var ang = aimAng + (i - (n - 1) / 2) * (2.26 / (n - 1));
      // 下向き以外へ飛ばさない(横〜下の135度に収める)
      ang = Math.max(Math.PI * 0.25, Math.min(Math.PI * 0.75, ang));
      spawnBullet("barrage", sx, sy,
        Math.cos(ang) * Q.speed * spdMul(), Math.sin(ang) * Q.speed * spdMul(), 0, PP.BOSS.orb.r * 0.8);
    }
    PP.audio.beep(240 + barrageLeft * 40, 0.08, "square", 0.08);
    PP.fx.flash(sx, sy, "rgba(255,160,64,0.6)", 36);
  }

  // ランダマイズの進行(被弾したときだけ回り始める)。ルーレットの高速音の後、
  // レーン上のチェーン全体の色をシャッフルする(chain.js scrambleColors)。
  // 狙って揃えていた同色の並びが崩壊する=最も戦略的な妨害。装填玉は変えない。
  function updateRandomize(dt) {
    if (rndSpinT <= 0) return;
    rndSpinT -= dt;
    rndStepT -= dt;
    if (rndSpinT <= 0) {
      PP.chain.scrambleColors();
      PP.fx.screenFlash("rgba(142,240,208,0.25)", 0.25, 500);
      PP.audio.beep(1175, 0.16, "triangle", 0.1);
      return;
    }
    if (rndStepT <= 0) {
      rndStepT = PP.BOSS.randomize.step;
      PP.audio.beep(600 + Math.random() * 600, 0.03, "square", 0.03);
    }
  }

  // 予兆のチャージリング(telegraph 中だけ、本体の後ろで脈打つ)
  function drawCharge() {
    var g = charge.graphics;
    g.clear();
    if (state !== "telegraph" || !curAttack) return;
    var a = ATTACKS[curAttack];
    var k = 1 - stateT / curTeleTotal;                // 0→1 で収束
    var r = 140 - 64 * k + Math.sin(t * 18) * 6;
    charge.x = body.x; charge.y = body.y - 20;
    g.setStrokeStyle(5).beginStroke(a.color).drawCircle(0, 0, r);
    g.setStrokeStyle(2).beginStroke("rgba(255,255,255,0.5)").drawCircle(0, 0, r * 0.7);
  }

  // ---------- 被弾・撃破 ----------
  // 弾がボスに当たった(cannon.js stepShots から)。ダメージが通れば true。
  // 予兆中に通ったダメージは攻撃をキャンセルする(弾幕ボスの「怯み」)
  function onHit(dmg, x, y) {
    if (!active || state === "dying" || state === "dead") return false;
    if (iFrames > 0) return false;
    iFrames = PP.BOSS.iFrames;
    hp = Math.max(0, hp - dmg);
    hurtT = 0.16;
    drawHpBar();
    PP.fx.burst(x, y, "#39d8b8", 10, 1.2);
    PP.fx.flash(x, y, "rgba(255,220,255,0.9)", 40);
    PP.fx.floatText("-" + dmg, x, y - 30, "#ff9a8a", 22);
    PP.fx.shake(6, 0.18);
    PP.audio.hit();
    PP.audio.beep(160, 0.15, "sawtooth", 0.1);
    if (state === "telegraph") {
      // 攻撃の阻止! チャージ中に撃ち込めた読みへのご褒美。
      // ⚠マーカー・安全柱・バナーも一緒に片付ける(攻撃自体が消える)
      state = "recover";
      stateT = PP.BOSS.recover + 0.6;   // 怯みで隙も少し伸びる
      curAttack = null;
      queuedAttack = null;
      charge.graphics.clear();
      clearWarnings();
      hideSafePillar();
      hideBanner();
      PP.fx.floatText("攻撃を阻止した!!", body.x, body.y + 96, "#8ef0d0", 24);
      PP.audio.beep(880, 0.12, "triangle", 0.1);
      PP.audio.beep(1175, 0.18, "triangle", 0.1);
    }
    // HP半分で怒りフェーズへ(1回だけ)
    if (!phase2 && hp > 0 && hp <= Math.ceil(PP.BOSS.hp * PP.BOSS.phase2.hpRatio)) enterPhase2();
    if (hp <= 0) startDying();
    return true;
  }

  // 怒りフェーズ: 攻撃間隔短縮・弾速アップ・コンボ追撃。見た目も血赤に燃える
  function enterPhase2() {
    phase2 = true;
    PP.fx.shake(20, 0.5);
    PP.fx.screenFlash("rgba(200,30,20,0.25)", 0.25, 700);
    showBanner("クラーケンが怒り狂う!!", "#ff5030", 2.0);
    PP.audio.beep(80, 0.5, "sawtooth", 0.16);
    PP.audio.beep(60, 0.7, "sawtooth", 0.12);
    if (rageRim) createjs.Tween.get(rageRim, { override: true }).to({ alpha: 1 }, 600);
    // 生体発光の色替え(青緑→血赤)は update の明滅処理が phase2 を見て行う
  }

  function startDying() {
    state = "dying";
    stateT = 1.6;
    clearStatusFx();               // 撃破の瞬間に全状態異常と妖弾を消す(確実な復元)
    PP.fx.shake(40, 0.8);
    PP.fx.screenFlash("rgba(255,240,200,0.5)", 0.5, 600);
    PP.fx.floatText("クラーケン撃破!!", PP.W / 2, PP.H / 2 - 60, "#ffdf8a", 40);
    PP.audio.explode();
  }

  function updateDying(dt) {
    stateT -= dt;
    body.y += 46 * dt;             // 海へ沈んでいく
    body.alpha = Math.max(0, stateT / 1.6);
    if (Math.random() < dt * 14) { // 沈みながら弾ける
      PP.fx.burst(body.x + (Math.random() - 0.5) * 160,
                  body.y + (Math.random() - 0.5) * 120, "#39d8b8", 8, 1.4);
    }
    if (stateT <= 0) {
      state = "dead";
      cont.visible = false;
      hpCont.visible = false;
      victoryPending = true;
    }
  }

  // 全状態異常・妖弾・墨・⚠・触手・津波を確実に片付ける(撃破時・リセット時)
  function clearStatusFx() {
    var fx = PP.game.bossFx;
    fx.ink = 0; fx.addle = 0; fx.freeze = 0; fx.shotSlow = 0;
    rndSpinT = 0;
    barrageLeft = 0;
    queuedAttack = null;
    removeInk();
    clearBullets();
    clearWarnings();
    clearStrikes();
    clearWave();
    hideBanner();
    if (charge) charge.graphics.clear();
    lastChipText = null;
    if (fxChips) fxChips.text = "";
  }

  // ---------- 毎フレーム(main.js の tick、playing 中のみ) ----------
  function update(dt) {
    if (!active || !built) return;
    var g = PP.game;
    var B = PP.BOSS;
    t += dt;
    // 予兆中は移動が遅くなる(撃ち込みの狙い目を作る)
    moveT += dt * (state === "telegraph" ? B.telegraphSlow : 1);

    // 状態異常タイマーの減算はここ1か所だけ。0 で確実に平常へ戻る。
    // 発生・解除の文字通知は出さない(HUD の状態異常チップに一本化)
    var fx = g.bossFx;
    if (fx.ink > 0) fx.ink = Math.max(0, fx.ink - dt);
    if (fx.addle > 0) fx.addle = Math.max(0, fx.addle - dt);
    if (fx.freeze > 0) fx.freeze = Math.max(0, fx.freeze - dt);
    if (fx.shotSlow > 0) fx.shotSlow = Math.max(0, fx.shotSlow - dt);
    if (iFrames > 0) iFrames -= dt;

    updateInk(dt);
    updateBullets(dt);
    updateRandomize(dt);
    updateWarnings(dt);
    updateStrikes(dt);
    updateWave(dt);
    updateBarrage(dt);
    updateChips();

    if (state === "dead") return;
    if (state === "dying") { updateDying(dt); drawTentacles(1); return; }

    // 移動: 画面上部をゆったり往復+上下の浮遊
    body.x = PP.W / 2 + Math.sin(moveT * B.moveSpeed) * B.moveAmp;
    body.y = B.y + Math.sin(moveT * 0.9) * 8;

    // 瞳が大砲を追う(狙われている感)+目の奥のグローと生体発光の明滅
    var look = Math.max(-6, Math.min(6, (PP.cannon.x - body.x) * 0.02));
    pupilL.x = -36 + look; pupilR.x = 36 + look;
    var glowA = (phase2 ? 0.55 : 0.35) + 0.2 * Math.sin(t * 3);
    for (var ei = 0; ei < eyeGlows.length; ei++) eyeGlows[ei].alpha = glowA;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    if (biolumA) biolumA.alpha = phase2 ? 0 : 0.35 + 0.55 * pulse;
    if (biolumB) biolumB.alpha = phase2 ? 0.45 + 0.55 * pulse : 0;
    if (rageRim && phase2) rageRim.alpha = 0.7 + 0.3 * Math.sin(t * 5);

    // 被弾フラッシュ
    if (hurtT > 0) { hurtT -= dt; hurt.alpha = Math.max(0, hurtT / 0.16) * 0.7; }
    else if (hurt.alpha !== 0) hurt.alpha = 0;

    drawTentacles(0);
    drawCharge();

    // 攻撃のステートマシン: idle(クールダウン)→ telegraph(予兆)→ 発射 → recover。
    // 怒りフェーズでは発射後に一定確率でコンボ追撃(短い予兆の ink/freeze)を仕込む
    stateT -= dt;
    if (state === "idle") {
      if (stateT <= 0) startTelegraph(pickAttack());
    } else if (state === "telegraph") {
      if (stateT <= 0) {
        var fired = curAttack;
        fireAttack(fired);
        curAttack = null;
        charge.graphics.clear();
        state = "recover";
        var P2 = B.phase2;
        if (phase2 && !queuedAttack && fired !== "ink" && fired !== "freeze" &&
            Math.random() < P2.comboChance) {
          queuedAttack = Math.random() < 0.5 ? "ink" : "freeze";
          stateT = P2.comboDelay;
        } else {
          stateT = B.recover;
        }
      }
    } else if (state === "recover") {
      if (stateT <= 0) {
        if (queuedAttack) {
          // コンボ追撃: 予兆は短いが、阻止・回避のルールは同じ
          var qa = queuedAttack;
          queuedAttack = null;
          startTelegraph(qa, B.phase2.comboTelegraph);
        } else {
          state = "idle";
          stateT = phase2
            ? B.phase2.cooldownMin + Math.random() * (B.phase2.cooldownMax - B.phase2.cooldownMin)
            : B.cooldownMin + Math.random() * (B.cooldownMax - B.cooldownMin);
        }
      }
    }
  }

  // ---------- 命中判定(頭部中心の楕円) ----------
  function hitTest(x, y) {
    if (!active || !built || state === "dying" || state === "dead") return false;
    var dx = (x - body.x) / PP.BOSS.hitRX;
    var dy = (y - (body.y - 20)) / PP.BOSS.hitRY;   // 楕円の中心は頭の中央(やや上)
    return dx * dx + dy * dy <= 1;
  }

  // ---------- 開始・終了 ----------
  function reset() {
    hp = PP.BOSS.hp;
    lastHpDrawn = -1;
    state = "idle";
    stateT = PP.BOSS.firstDelay;
    curAttack = null; lastAttack = null;
    iFrames = 0; hurtT = 0; t = 0; moveT = 0;
    victoryPending = false; victoryConsumed = false;
    phase2 = false; attackCount = 0;
    clearStatusFx();
    if (built) {
      body.alpha = 1;
      body.x = PP.W / 2; body.y = PP.BOSS.y;
      hurt.alpha = 0;
      if (rageRim) { createjs.Tween.removeTweens(rageRim); rageRim.alpha = 0; }
      drawHpBar();
    }
  }

  // ボス戦の開始/終了(main.js startLevel から)。開始時は状態も仕切り直す
  function setActive(on) {
    active = !!on;
    if (active && !built) build();
    if (built) {
      cont.visible = active;
      hpCont.visible = active;
    }
    reset();
  }

  // 勝利の受け渡し(1回だけ true)。main.js の tick が levelClear() に繋ぐ
  function consumeVictory() {
    if (victoryPending && !victoryConsumed) { victoryConsumed = true; return true; }
    return false;
  }

  PP.boss = {
    setActive: setActive,
    reset: reset,
    update: update,
    hitTest: hitTest,
    onHit: onHit,
    consumeVictory: consumeVictory,
    isActive: function () { return active; },
    // デバッグ・動作確認用
    getHp: function () { return hp; },
    getState: function () { return state; },
    getBulletCount: function () { return bullets.length; }
  };
})();
