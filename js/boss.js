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
 *   ink      タコスミ     … 山なりの墨玉。着弾点に墨だまり、直撃なら大きく視界妨害
 *   addle    Addle!!      … 速い単発。被弾でマウス左右反転(main.js の aimStageX)
 *   freeze   停止!        … 3方向の扇。被弾で大砲の移動・発射不能(cannon.js)
 *   shotSlow 時間の滞留   … 大きく遅い弾。被弾で発射玉が極端に遅くなる(stepShots)
 *   randomize ランダマイズ … 被弾で装填色がルーレットの後、別の色へ確定
 * クールダウン(4.5〜7秒)は最長の状態異常(4秒)より長いので、強い操作妨害が
 * 同時に重なることはない。さらに抽選時にも効果中の妨害系を候補から外す。
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

  // ランダマイズ(色ルーレット)は攻撃状態と独立に回す
  var rndSpinT = 0, rndStepT = 0, rndOrig = 0;

  // 攻撃の定義(色は予兆リング・妖弾・宣言文字に使う)
  var ATTACKS = {
    ink:       { name: "🦑 タコスミ!!",     color: "#8a97a8" },
    addle:     { name: "🌀 Addle!!",         color: "#ff5d8f" },
    freeze:    { name: "⚓ 停止!!",          color: "#ffd24a" },
    shotSlow:  { name: "⏳ 時間の滞留",      color: "#c46ffb" },
    randomize: { name: "🎲 ランダマイズ!!",  color: "#8ef0d0" }
  };
  var ATTACK_KEYS = ["ink", "addle", "freeze", "shotSlow", "randomize"];

  // ---------- クラーケンの作画 ----------
  // 既存の砲台・玉と同じ「ベクター+グラデーション」の文法で描く。
  // 頭(外套膜)は深紫のドーム、目は月光色のスリット瞳、下から7本の触手が
  // うねる。触手は毎フレーム tentShape に描き直す(sin でうねらせる)。
  function buildBody() {
    body = new createjs.Container();

    // 触手(頭より下に描くので先に追加)
    tentShape = new createjs.Shape();
    body.addChild(tentShape);

    // 頭(外套膜): 上へ膨らむドーム+下すぼまり。深紫の放射グラデ
    var head = new createjs.Shape();
    var hg = head.graphics;
    hg.beginRadialGradientFill(["#9a5ab0", "#6a3084", "#2a0f38"], [0, 0.55, 1],
        -24, -46, 10, 0, -20, 110)
      .moveTo(-78, 26)
      .curveTo(-96, -40, -52, -88)    // 左肩 → 頭頂へ
      .curveTo(0, -122, 52, -88)      // 頭頂の丸み
      .curveTo(96, -40, 78, 26)       // 右肩へ
      .curveTo(40, 46, 0, 46)         // あご下
      .curveTo(-40, 46, -78, 26)
      .closePath();
    // 輪郭(夜の海に沈まないよう淡く縁取る)
    hg.setStrokeStyle(2.5).beginStroke("rgba(20,4,32,0.9)")
      .moveTo(-78, 26)
      .curveTo(-96, -40, -52, -88)
      .curveTo(0, -122, 52, -88)
      .curveTo(96, -40, 78, 26);
    // 頭頂の照り返し(月光)
    hg.endStroke().beginFill("rgba(210,180,255,0.20)")
      .drawEllipse(-52, -100, 62, 30);
    // 額の斑点(タコらしい模様)
    hg.beginFill("rgba(24,6,40,0.5)");
    hg.drawCircle(-30, -66, 7).drawCircle(6, -80, 5).drawCircle(34, -60, 6)
      .drawCircle(-6, -52, 4).drawCircle(48, -34, 4).drawCircle(-48, -38, 5);
    body.addChild(head);

    // 目(白目=骨白、スリット瞳=深黒)。瞳は update で大砲の方を向く
    function makeEye(ex) {
      var eye = new createjs.Shape();
      eye.graphics
        .beginRadialGradientFill(["#fff6d8", "#ffd24a", "#8a6a10"], [0, 0.65, 1],
          0, 0, 2, 0, 0, 17)
        .drawEllipse(-15, -17, 30, 34)
        .setStrokeStyle(2).beginStroke("#1c0a28").drawEllipse(-15, -17, 30, 34);
      eye.x = ex; eye.y = -18;
      var pupil = new createjs.Shape();
      pupil.graphics.beginFill("#140420").drawEllipse(-4.5, -12, 9, 24);
      pupil.x = ex; pupil.y = -18;
      body.addChild(eye, pupil);
      return pupil;
    }
    pupilL = makeEye(-36);
    pupilR = makeEye(36);

    // 怒り眉(目の上の鋭いヒレ)
    var browL = new createjs.Shape();
    browL.graphics.beginFill("#20083a").moveTo(-58, -44).lineTo(-16, -38).lineTo(-52, -26).closePath();
    var browR = new createjs.Shape();
    browR.graphics.beginFill("#20083a").moveTo(58, -44).lineTo(16, -38).lineTo(52, -26).closePath();
    body.addChild(browL, browR);

    // くちばし(タコの口)。妖弾はここから吐き出される
    var beak = new createjs.Shape();
    beak.graphics.beginFill("#140420")
      .moveTo(-9, 18).lineTo(0, 30).lineTo(9, 18).closePath()
      .beginFill("rgba(255,120,80,0.35)").moveTo(-5, 20).lineTo(0, 26).lineTo(5, 20).closePath();
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

  // 触手を描き直す(7本。sin で位相をずらしてうねらせる)。
  // dying 中は droop(0→1)でだらりと垂れ下がる。
  function drawTentacles(droop) {
    var g = tentShape.graphics;
    g.clear();
    for (var i = 0; i < 7; i++) {
      var bx = -66 + i * 22;                       // 付け根(あご下に等間隔)
      var ph = i * 1.7;
      var sway = Math.sin(t * 2.0 + ph) * 20 * (1 - droop * 0.8);
      var reach = 92 + Math.sin(t * 1.3 + ph * 1.3) * 16;
      var ex = bx * 1.7 + sway * 2;                // 先端(外へ開きつつ揺れる)
      var ey = 34 + reach + droop * 46;
      var cx = bx * 1.15 + sway;                   // 中間の制御点
      var cy = 34 + reach * 0.45;
      // 太い根元 → 細い先端の2段描き(ストローク幅は1本の線で変えられないため)
      g.setStrokeStyle(15, "round").beginStroke("#4a1c66")
        .moveTo(bx, 30).quadraticCurveTo(cx, cy, (cx + ex) / 2, (cy + ey) / 2).endStroke();
      g.setStrokeStyle(8, "round").beginStroke("#5a2a72")
        .moveTo((cx + ex) / 2 - 1, (cy + ey) / 2).quadraticCurveTo(ex, ey - 18, ex + sway * 0.4, ey).endStroke();
      // 吸盤の点々と先端の丸
      g.beginFill("rgba(210,160,235,0.35)")
        .drawCircle((bx + cx) / 2, (30 + cy) / 2, 2.6)
        .drawCircle(cx, cy + 8, 2.2)
        .drawCircle((cx + ex) / 2, (cy + ey) / 2 + 6, 1.8);
      g.beginFill("#6a3084").drawCircle(ex + sway * 0.4, ey, 4.5);
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

    bulletCont = new createjs.Container();  // 妖弾は本体より手前
    cont.addChild(bulletCont);

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

  // 妖弾が大砲に当たった: ここで初めて状態異常がかかる
  function applyOrbHit(b) {
    var g = PP.game;
    var B = PP.BOSS;
    PP.fx.shake(8, 0.25);
    PP.audio.beep(150, 0.25, "sawtooth", 0.12);
    if (b.type === "ink") {
      splatInk(b.x, b.y, true);     // 直撃は大きな目つぶし
      g.bossFx.ink = B.ink.dur;
      PP.fx.floatText("目の前が真っ黒だ!", PP.cannon.x, PP.cannon.y - 96, "#8a97a8", 20);
    } else if (b.type === "addle") {
      g.bossFx.addle = B.addle.dur;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ff5d8f", 10, 90, 500);
      PP.fx.floatText("操作が反転!", PP.cannon.x, PP.cannon.y - 96, "#ff5d8f", 20);
    } else if (b.type === "freeze") {
      g.bossFx.freeze = B.freeze.dur;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffd24a", 10, 90, 500);
      PP.fx.floatText("大砲が動かない!", PP.cannon.x, PP.cannon.y - 96, "#ffd24a", 20);
    } else if (b.type === "shotSlow") {
      g.bossFx.shotSlow = B.shotSlow.dur;
      PP.fx.screenFlash("rgba(138,32,216,0.22)", 0.22, 600);
      PP.fx.floatText("弾の時間が滞る…", PP.cannon.x, PP.cannon.y - 96, "#c46ffb", 20);
    } else if (b.type === "randomize") {
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
      pool.push(k);
    }
    if (pool.length === 0) pool = ATTACK_KEYS.slice();
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function startTelegraph(key) {
    curAttack = key;
    state = "telegraph";
    stateT = PP.BOSS[key].telegraph;
    var a = ATTACKS[key];
    // 宣言(見やすい位置=ボスの下)+ 低い唸りの警告音。
    // このリングが出ている間にダメージを与えれば攻撃はキャンセルできる
    PP.fx.floatText(a.name, body.x, body.y + 96, a.color, 26);
    PP.audio.beep(140, 0.3, "sawtooth", 0.1);
    PP.audio.beep(110, 0.45, "sine", 0.09);
  }

  // 妖弾の発射。すべて口(あご下)から、狙いは発射時点の大砲の位置。
  // 発射後の軌道は固定なので、見てから移動すれば必ずかわせる
  function fireAttack(key) {
    var B = PP.BOSS;
    lastAttack = key;
    var sx = body.x, sy = body.y + 34;
    var tx = PP.cannon.x, ty = PP.cannon.y - 20;
    PP.audio.beep(200, 0.15, "square", 0.1);
    PP.fx.flash(sx, sy, "rgba(180,120,220,0.7)", 40);
    if (key === "ink") {
      // 山なりの墨玉×3: 大砲狙い1発+左右にばら撒き2発
      var K = B.ink;
      var targets = [tx, tx - 240 - Math.random() * 120, tx + 240 + Math.random() * 120];
      for (var i = 0; i < K.lobs; i++) {
        // 放物線: vy0 で軽く浮かせ、grav で落とす。到達時間から vx を逆算
        var fallT = (Math.sqrt(K.vy0 * K.vy0 + 2 * K.grav * (ty - sy)) - K.vy0) / K.grav;
        spawnBullet("ink", sx, sy, (targets[i] - sx) / fallT, K.vy0, K.grav, 18);
      }
    } else if (key === "freeze") {
      // 3方向の扇: 中央は大砲狙い、左右は spread ぶんずらす
      var F = B.freeze;
      for (var f = 0; f < F.fan; f++) {
        var off = (f - (F.fan - 1) / 2) * F.spread;
        var dx = (tx + off) - sx, dy = ty - sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        spawnBullet("freeze", sx, sy, dx / len * F.speed, dy / len * F.speed, 0, B.orb.r);
      }
    } else {
      // 単発の狙い撃ち(addle=速い / shotSlow=大きく遅い / randomize=中速)
      var spec = B[key];
      var r = (key === "shotSlow") ? B.shotSlow.r : B.orb.r;
      var ddx = tx - sx, ddy = ty - sy;
      var dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      spawnBullet(key, sx, sy, ddx / dlen * spec.speed, ddy / dlen * spec.speed, 0, r);
    }
  }

  // ランダマイズの進行(被弾したときだけ回り始める)。装填色を高速で切り替え、
  // 最後に「元と別の・盤面に実在する色」へ確定する。飛行中の弾は発射時に
  // 色を持って出ているので影響しない。
  function updateRandomize(dt) {
    if (rndSpinT <= 0) return;
    var g = PP.game;
    rndSpinT -= dt;
    rndStepT -= dt;
    if (rndSpinT <= 0) {
      // 確定: 盤面に実在する色から、元の色を避けて引く(最大8回で妥協)
      var c = PP.ball.pickColor(rndOrig);
      for (var tries = 0; tries < 8 && c === rndOrig; tries++) c = PP.ball.pickColor(rndOrig);
      g.currentColor = c;
      PP.cannon.refreshBalls();
      PP.fx.floatText("色が変わった!", PP.cannon.x, PP.cannon.y - 96, "#8ef0d0", 20);
      PP.audio.beep(1175, 0.16, "triangle", 0.1);
      return;
    }
    if (rndStepT <= 0) {
      rndStepT = PP.BOSS.randomize.step;
      g.currentColor = Math.floor(Math.random() * g.nColors);
      PP.cannon.refreshBalls();
      PP.audio.beep(600 + Math.random() * 600, 0.03, "square", 0.03);
    }
  }

  // 予兆のチャージリング(telegraph 中だけ、本体の後ろで脈打つ)
  function drawCharge() {
    var g = charge.graphics;
    g.clear();
    if (state !== "telegraph" || !curAttack) return;
    var a = ATTACKS[curAttack];
    var total = PP.BOSS[curAttack].telegraph;
    var k = 1 - stateT / total;                       // 0→1 で収束
    var r = 130 - 60 * k + Math.sin(t * 18) * 6;
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
    PP.fx.burst(x, y, "#c46ffb", 10, 1.2);
    PP.fx.flash(x, y, "rgba(255,220,255,0.9)", 40);
    PP.fx.floatText("-" + dmg, x, y - 30, "#ff9a8a", 22);
    PP.fx.shake(6, 0.18);
    PP.audio.hit();
    PP.audio.beep(160, 0.15, "sawtooth", 0.1);
    if (state === "telegraph") {
      // 攻撃の阻止! チャージ中に撃ち込めた読みへのご褒美
      state = "recover";
      stateT = PP.BOSS.recover + 0.6;   // 怯みで隙も少し伸びる
      curAttack = null;
      charge.graphics.clear();
      PP.fx.floatText("攻撃を阻止した!!", body.x, body.y + 96, "#8ef0d0", 24);
      PP.audio.beep(880, 0.12, "triangle", 0.1);
      PP.audio.beep(1175, 0.18, "triangle", 0.1);
    }
    if (hp <= 0) startDying();
    return true;
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
                  body.y + (Math.random() - 0.5) * 120, "#c46ffb", 8, 1.4);
    }
    if (stateT <= 0) {
      state = "dead";
      cont.visible = false;
      hpCont.visible = false;
      victoryPending = true;
    }
  }

  // 全状態異常・妖弾・墨を確実に片付ける(撃破時・リセット時)
  function clearStatusFx() {
    var fx = PP.game.bossFx;
    fx.ink = 0; fx.addle = 0; fx.freeze = 0; fx.shotSlow = 0;
    rndSpinT = 0;
    removeInk();
    clearBullets();
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

    // 状態異常タイマーの減算はここ1か所だけ。0 で確実に平常へ戻る
    var fx = g.bossFx;
    if (fx.ink > 0) fx.ink = Math.max(0, fx.ink - dt);
    if (fx.addle > 0) {
      fx.addle = Math.max(0, fx.addle - dt);
      if (fx.addle === 0) PP.fx.floatText("操作が戻った!", PP.cannon.x, PP.cannon.y - 96, "#8ef0d0", 18);
    }
    if (fx.freeze > 0) {
      fx.freeze = Math.max(0, fx.freeze - dt);
      if (fx.freeze === 0) PP.fx.floatText("動ける!", PP.cannon.x, PP.cannon.y - 96, "#8ef0d0", 18);
    }
    if (fx.shotSlow > 0) fx.shotSlow = Math.max(0, fx.shotSlow - dt);
    if (iFrames > 0) iFrames -= dt;

    updateInk(dt);
    updateBullets(dt);
    updateRandomize(dt);
    updateChips();

    if (state === "dead") return;
    if (state === "dying") { updateDying(dt); drawTentacles(1); return; }

    // 移動: 画面上部をゆったり往復+上下の浮遊
    body.x = PP.W / 2 + Math.sin(moveT * B.moveSpeed) * B.moveAmp;
    body.y = B.y + Math.sin(moveT * 0.9) * 8;

    // 瞳が大砲を追う(狙われている感)
    var look = Math.max(-6, Math.min(6, (PP.cannon.x - body.x) * 0.02));
    pupilL.x = -36 + look; pupilR.x = 36 + look;

    // 被弾フラッシュ
    if (hurtT > 0) { hurtT -= dt; hurt.alpha = Math.max(0, hurtT / 0.16) * 0.7; }
    else if (hurt.alpha !== 0) hurt.alpha = 0;

    drawTentacles(0);
    drawCharge();

    // 攻撃のステートマシン: idle(クールダウン)→ telegraph(予兆)→ 発射 → recover
    stateT -= dt;
    if (state === "idle") {
      if (stateT <= 0) startTelegraph(pickAttack());
    } else if (state === "telegraph") {
      if (stateT <= 0) {
        fireAttack(curAttack);
        curAttack = null;
        charge.graphics.clear();
        state = "recover";
        stateT = B.recover;
      }
    } else if (state === "recover") {
      if (stateT <= 0) {
        state = "idle";
        stateT = B.cooldownMin + Math.random() * (B.cooldownMax - B.cooldownMin);
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
    clearStatusFx();
    if (built) {
      body.alpha = 1;
      body.x = PP.W / 2; body.y = PP.BOSS.y;
      hurt.alpha = 0;
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
