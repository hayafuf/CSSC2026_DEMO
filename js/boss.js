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
 *   ink      漆黒の墨獄       … 弧を描いて降り注ぐ墨玉のカーテン。着弾した墨玉は割れて
 *                               飛沫になり、跳ねてまた降る(怒り時は飛沫の着弾でさらに
 *                               もう一段割れる二段分裂)。着弾点に墨だまり
 *   addle    惑乱の逆潮       … 大珠が盤面中央でホバリングし、二段のリングを展開。
 *                               被弾で操作反転(input.js: マウスの動きを反転する相対移動)
 *   freeze   深淵の錨鎖       … ボスを中心に広がる同心二重のリング。
 *                               被弾で大砲の移動・発射不能(cannon.js)
 *   shotSlow 時凪の呪縛       … 遅い大弾の二重カーテン(隙間が互い違い)。
 *                               被弾で発射玉が極端に遅くなる(stepShots)
 *   randomize 運命のルーレット … 左右から交差する回転スイープ弾。被弾でチェーンが
 *                               ルーレット回転 → 補給と同じ塊生成ルールで色が並び直る
 *   tentacle 海淵の大触腕     … 大砲の高さに⚠予告(鼓動が速まり影が浮上)→ 画面下から
 *                               触手が突き上げ、範囲内ならランダムなデバフ。
 *                               「3本=自機狙い(動け)」と「4本=左右の挟み撃ち(動くな)」を
 *                               交互に繰り返し、波ごとに予告と間が縮む。突き上げ後も
 *                               居座る触手に自弾を当てれば「斬り返し」でダメージを返せる
 *   tsunami  終焉の大海嘯     … 光の安全柱以外の低空を水壁が横断。柱の外だと
 *                               画面の端まで一気に押し流される(樽防衛から引き剥がされる)
 *   barrage  妖星の豪雨       … 下向きの扇弾幕を複数ボレー。隙間を縫うか撃ち落とす
 *   thunder  裁きの雷霆       … 画面の片端から反対側へ、大砲の高さを隙間なく順番に落雷
 *                               (各⚠予告あり。右から/左からはバナーと端の ⚡▶ で分かる。
 *                               怒り時は反対側からもう1往路)。被弾で「暗闇」: 装填中の
 *                               今の玉が真っ黒(色不明)になり交換も不能(cannon.js)。
 *                               次の玉は見える。発射はできる。弾体が無いのでパリィ不可
 * 同種の重ね掛けは抽選時に「効果中の技」を候補から外して防ぐ。HP が半分を切ると
 * 怒りフェーズ: 攻撃間隔短縮・弾速アップ・発射後のコンボ追撃(短予兆の ink/freeze)。
 * 通知は「技名バナー(画面上部の帯)+HUD の状態異常チップ」の2系統に整理し、
 * 発生・解除のたびに文字を飛ばすことはしない。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var battle = {
    lastAttack: null,
    attackCount: 0,
    curtainTotal: 0,
    curtainLeft: 0,
    curtainT: 0,
    curtainDropT: 0,
    sweepTotal: 0,
    sweepLeft: 0,
    sweepT: 0,
    tentWaveIdx: 0,
    pendingZones: [],
    tentWavesLeft: 0,
    tentPhase: "",
    tentTimer: 0,
    barrageLeft: 0,
    barrageT: 0,
    crossActive: false,
    crossT: 0,
    crossEmitAcc: 0,
    crossSafe: null,
    thunderTimer: 0,
    body: null,
    tentShape: null,
    pupilL: null,
    pupilR: null,
    hurt: null,
    eyeGlows: [],
    biolumA: null,
    biolumB: null,
    rageRim: null,
    shield: null,
    bulletCont: null,
    inkBlobs: [],
    bullets: [],
    state: "idle",
    phase2: false,
    crossHitCd: 0,
    meteorKnock: null,
    orbHitCd: 0,
    parryCd: 0,
    parryBeepCd: 0,
    rndSpinT: 0,
    rndStepT: 0,
    rndOrig: 0
  };

  var built = false;      // 表示物を組み立て済みか(初回の setActive(true) で組む)
  var active = false;     // ボス戦中か

  // ---- 表示物 ----
  var cont = null;        // fx レイヤー内の入れ物(本体+妖弾+墨)。玉より上・大砲/HUDより下
  var charge = null;      // 予兆のチャージリング(telegraph 中だけ描く)
  var inkCont = null;     // 墨だまりの入れ物
  var hpCont = null;      // HUD レイヤー内の HP バー(枠・バー・ラベル・状態チップ)
  var hpBarSh = null, hpLabel = null, fxChips = null;

  // ---- Shadow 付き Text / Shape の cache 化(hud.js cacheHudText と同じ規約)----
  // 【なぜ必須か】StageGL(携帯)は cache されていない Shape/Text を描けない
  // (gl-patch.js 参照)。このファイルの HP バー・技名バナー・各ヒント文は長らく
  // 非 cache だったため、タッチ端末ではそもそも表示されていなかった。
  // Canvas 2D でも Shadow 付き Text は毎フレーム shadowBlur 付きラスタライズが
  // 走るので、固定領域で一度だけ焼いて text 変更時だけ updateCache する
  function cacheText(t, maxW, maxH, pad) {
    pad = pad || 10;
    var x0 = t.textAlign === "center" ? -maxW / 2 : t.textAlign === "right" ? -maxW : 0;
    var y0 = t.textBaseline === "middle" ? -maxH / 2 : 0;
    t.cache(x0 - pad, y0 - pad, maxW + pad * 2, maxH + pad * 2);
    if (PP.regFontCache) PP.regFontCache(t);
  }
  // 一度きりの注記文(作って 12 秒ほどで捨てる)は実寸で焼く
  function cacheTextFit(t, size) {
    var w = t.getMeasuredWidth() + 8;
    cacheText(t, w, size * 1.4, 10);
  }
  var lastHpDrawn = -1, lastChipText = null;
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
  var hitStreak = 0;      // シールドが張られるまでの被弾カウント(3発で発動)
  var guardT = 0;         // シールド(無敵)の残り秒
  var guardFxCd = 0;      // シールドに弾かれた演出の連打防止
  var hurtT = 0;          // 被弾フラッシュの残り
  var stateT = 0;         // いまの状態の残り秒
  var curAttack = null;   // telegraph 中の攻撃キー
  var victoryPending = false, victoryConsumed = false;
  var queuedAttack = null;               // 怒りフェーズのコンボ追撃(recover 後に短予兆で撃つ)
  var curTeleTotal = 1;   // いまの予兆の全長(drawCharge の進行度用)
  var tsuSafeX = 0, tsuDir = 1;          // 津波の安全地帯と進行方向
  // 触手の追撃波(第1波の後に「間→⚠→突き上げ」を繰り返す波状攻撃)
  var tentPending = [];    // 追撃波の突き上げ予定X座標
  // 両舷斉射(cross): 左右両舷からの超高密度ドット線の振り子掃引
  var crossCenterK = 0;     // 0→1: 両舷斉射のためにボスが中央へ寄っている度合い
  // 【強化】パリィ成功後の短い無敵。orbHitCd と分けるのは、あちらが触手・津波
  // (パリィ不可の大技)の無敵判定にも共用されていて、パリィの無敵で大技まで
  // 防げてしまう抜け穴になるため。こちらは妖弾の被弾判定だけが読む
  var crossTele = [];       // 予兆の交差線(telegraph 中だけ表示)
  var rageVin = null;       // 怒りフェーズの全画面赤ビネット(alpha だけ動かす)

  // ランダマイズ(色ルーレット)は攻撃状態と独立に回す
  // 裁きの雷霆(thunder): 右→左へ順番に落ちる落雷
  var thunderXs = [];       // まだ⚠を置いていない落雷X(始点側から順に shift する)
  var thunderBolts = [];    // ⚠済み・落下待ち {x, t}
  var boltFx = [];          // 表示中の雷の線 {sh, t}
  var thunderDir = 1;       // 1=右から左へ / -1=左から右へ(予兆で決める)
  var thunderPasses = 0;    // 残りの往路数(怒り時は1往路の後、反対側からもう1往路)
  var thunderArrow = null;  // 始点側の端に出す ⚡▶ の矢印(予兆中・往路の切り替え時)
  var blackoutWas = false;  // 前フレームに暗闇中だったか(解除の瞬間に手札を描き直す)

  // 攻撃の定義(色は予兆リング・妖弾・宣言バナーに使う)
  // 攻撃名は i18n 辞書のキーで持つ(バナーに出す瞬間に t() で引く。
  // 直に文字列を持つと、タイトルで言語を切り替えても古い言語のまま残る)
  var ATTACKS = {
    ink:       { nameKey: "boss.atk.ink",       color: "#8a97a8" },
    addle:     { nameKey: "boss.atk.addle",     color: "#ff5d8f" },
    freeze:    { nameKey: "boss.atk.freeze",    color: "#ffd24a" },
    shotSlow:  { nameKey: "boss.atk.shotSlow",  color: "#c46ffb" },
    randomize: { nameKey: "boss.atk.randomize", color: "#8ef0d0" },
    tentacle:  { nameKey: "boss.atk.tentacle",  color: "#ff5030" },
    tsunami:   { nameKey: "boss.atk.tsunami",   color: "#4ac8e8" },
    barrage:   { nameKey: "boss.atk.barrage",   color: "#ffa040" },
    cross:     { nameKey: "boss.atk.cross",     color: "#9fd8ff" },
    thunder:   { nameKey: "boss.atk.thunder",   color: "#fff27a" }
  };
  var ATTACK_KEYS = ["ink", "addle", "freeze", "shotSlow", "randomize",
                     "tentacle", "tsunami", "barrage", "cross", "thunder"];
  // 【強化】パリィが効かない大技。tentacle/tsunami は bullets を使わない別系統
  // なので構造的にも対象外だが、予兆の「パリィ不可」表示と将来の変更保険のため
  // 3技とも明示しておく(cross だけは弾システム内なのでこの集合が効いている)
  var NO_PARRY = { tentacle: true, tsunami: true, cross: true, thunder: true };

  // ---------- クラーケンの作画 ----------
  // 既存の砲台・玉と同じ「ベクター+グラデーション」の文法で描く。
  // 深海の闇に溶ける青黒い外套膜、歴戦の傷跡、血赤にギラつくスリット瞳、
  // 骨白の牙。下から8本の太い触手がうねる(毎フレーム tentShape に描き直す)。
  // HP半分の怒りフェーズでは生体発光が血赤に変わり、輪郭が赤く燃える。
  var bodyView = PP.createBossView(battle, function () { return t; });
  var buildBody = bodyView.buildBody, drawTentacles = bodyView.drawTentacles,
      drawTentaclesThrottled = bodyView.drawTentaclesThrottled;
  var projectiles = PP.createBossProjectiles(battle, {
    attacks: ATTACKS, noParry: NO_PARRY,
    Kb2Scale: Kb2Scale,
    splatInk: splatInk,
    spdMul: spdMul,
    onHit: onHit,
    hitTest: hitTest
  });
  var spawnBullet = projectiles.spawnBullet;
  var clearBullets = projectiles.clearBullets;
  var updateBullets = projectiles.updateBullets;
  var applyDebuff = projectiles.applyDebuff;
  var applyOrbHit = projectiles.applyOrbHit;

  var attacks = PP.createBossAttacks(battle, {
    attacks: ATTACKS,
    spdMul: spdMul,
    spawnBullet: spawnBullet,
    spawnStrike: spawnStrike,
    tentGapTime: tentGapTime,
    startWave: startWave,
    clearCrossTele: clearCrossTele,
    fillThunderPass: fillThunderPass
  });
  var fireAttack = attacks.fireAttack;
  var updateBarrage = attacks.updateBarrage;
  var updateCross = attacks.updateCross;
  var updateCurtain = attacks.updateCurtain;
  var updateSweep = attacks.updateSweep;

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

    // 両舷斉射の安置柱: 掃引点(2本の線の間の安全地帯)を照らす光の柱。
    // 津波の安全柱と同じ「光=安全」の文法。一度だけ焼いて x を動かすだけ
    battle.crossSafe = new createjs.Shape();
    // 幅は実際の安全地帯(2×aimCrossGap)から線の太さぶんを引いた値に合わせる
    var csW = PP.BOSS.cross.aimCrossGap * 2 - 40, csTop = PP.CANNON_Y - 170, csH = 220;
    battle.crossSafe.graphics.beginLinearGradientFill(
        ["rgba(214,255,246,0)", "rgba(214,255,246,0.30)", "rgba(214,255,246,0.30)", "rgba(214,255,246,0)"],
        [0, 0.3, 0.7, 1], -csW / 2, 0, csW / 2, 0)
      .drawRect(-csW / 2, csTop, csW, csH);
    battle.crossSafe.graphics.setStrokeStyle(2).beginStroke("rgba(180,255,235,0.7)")
      .moveTo(-csW / 2, csTop).lineTo(-csW / 2, csTop + csH)
      .moveTo(csW / 2, csTop).lineTo(csW / 2, csTop + csH);
    battle.crossSafe.cache(-csW / 2 - 3, csTop - 3, csW + 6, csH + 6);
    battle.crossSafe.alpha = 0;
    cont.addChild(battle.crossSafe);

    battle.bulletCont = new createjs.Container();  // 妖弾は本体より手前
    cont.addChild(battle.bulletCont);

    // 技名の宣言バナー(画面上部を横切る半透明の帯。fx レイヤー最上段)
    banner = new createjs.Container();
    banner.mouseEnabled = false;
    var bband = new createjs.Shape();
    bband.graphics.beginLinearGradientFill(
        ["rgba(0,0,0,0)", "rgba(0,0,0,0.6)", "rgba(0,0,0,0.6)", "rgba(0,0,0,0)"],
        [0, 0.18, 0.82, 1], 0, 0, PP.W, 0)
      .drawRect(0, -26, PP.W, 52);
    bband.cache(0, -26, PP.W, 52);   // 画面幅のグラデ帯は一度だけ焼く
    bannerText = new createjs.Text("", '700 30px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffffff");
    bannerText.textAlign = "center"; bannerText.textBaseline = "middle";
    bannerText.x = PP.W / 2;
    bannerText.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    cacheText(bannerText, 700, 40, 12);   // 英語の技名(30px)まで収まる幅
    banner.addChild(bband, bannerText);
    banner.y = 160;
    banner.visible = false;
    cont.addChild(banner);

    // 怒りフェーズの赤ビネット: gameover の血の帳と同レシピの放射グラデを
    // 一度だけ焼き、phase2 中だけ alpha を脈動させる(毎フレームのコストは
    // キャッシュ済み1枚のブリットだけ。墨の cache と同じ思想)
    rageVin = new createjs.Shape();
    rageVin.graphics.beginRadialGradientFill(
      ["rgba(120,0,0,0)", "rgba(90,0,0,0.35)", "rgba(40,0,0,0.8)"], [0, 0.55, 1],
      PP.W / 2, PP.H / 2, 120, PP.W / 2, PP.H / 2, 700)
      .drawRect(0, 0, PP.W, PP.H);
    rageVin.cache(0, 0, PP.W, PP.H);
    rageVin.alpha = 0;
    cont.addChild(rageVin);

    // fx レイヤーの最背面へ: 粒子・リング等の演出はボスより手前に出る。
    // fx は玉より上・大砲/危機/HUD より下なので、墨・妖弾は盤面の上を通るが
    // 操作系(大砲・HUD)は隠さない
    PP.layers.fx.addChildAt(cont, 0);

    // ---- HP バー(HUD レイヤー。HUD バーのすぐ下に真鍮枠で置く)----
    hpCont = new createjs.Container();
    hpCont.mouseEnabled = false;
    hpLabel = new createjs.Text(PP.i18n.t("boss.hpLabel"), '700 15px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ff9a8a");
    hpLabel.textAlign = "right"; hpLabel.textBaseline = "middle";
    hpLabel.x = 430; hpLabel.y = 80;
    hpLabel.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 2, 4);
    cacheText(hpLabel, 160, 22, 8);
    hpBarSh = new createjs.Shape();
    fxChips = new createjs.Text("", '600 14px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#ffd8a8");
    fxChips.textAlign = "left"; fxChips.textBaseline = "middle";
    fxChips.x = 880; fxChips.y = 80;
    fxChips.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 2, 4);
    cacheText(fxChips, 400, 22, 8);
    hpCont.addChild(hpBarSh, hpLabel, fxChips);
    PP.layers.hud.addChild(hpCont);
  }

  var HP_X = 440, HP_Y = 72, HP_W = 420, HP_H = 16;
  // ボスの最大HP = 基準値(PP.BOSS.hp)× 難易度の bossHpMult(config.js)。
  // ボス戦の難易度スケールはこの1点のみ(攻撃パターンは全難易度共通)
  function maxHp() {
    return Math.round(PP.BOSS.hp * (PP.diff().bossHpMult || 1));
  }

  function drawHpBar() {
    if (hp === lastHpDrawn) return;
    lastHpDrawn = hp;
    var g = hpBarSh.graphics;
    g.clear();
    g.beginFill("rgba(4,8,12,0.7)").drawRoundRect(HP_X, HP_Y, HP_W, HP_H, 8);
    var ratio = Math.max(0, hp / maxHp());
    if (ratio > 0) {
      g.beginLinearGradientFill(["#ff9a8a", "#e03838", "#7a1420"], [0, 0.5, 1],
          0, HP_Y, 0, HP_Y + HP_H)
        .drawRoundRect(HP_X + 1.5, HP_Y + 1.5, Math.max(6, (HP_W - 3) * ratio), HP_H - 3, 6);
      g.beginFill("rgba(255,255,255,0.25)")
        .drawRoundRect(HP_X + 2.5, HP_Y + 2.5, Math.max(4, (HP_W - 5) * ratio), 3, 2);
    }
    g.setStrokeStyle(1.5).beginStroke("#c9a86a").drawRoundRect(HP_X, HP_Y, HP_W, HP_H, 8);
    // HP が変わったときだけ焼き直す(Shape は cache が無いと GL で描かれない)
    if (hpBarSh.cacheCanvas) hpBarSh.updateCache();
    else hpBarSh.cache(HP_X - 2, HP_Y - 2, HP_W + 4, HP_H + 4);
  }

  // 状態異常チップ(アイコン+残り秒)。文字列が変わったときだけ差し替える。
  // 表示値は Math.ceil の秒なので、配列構築+join 自体も 0.25 秒に1回で十分
  var chipAcc = 1;
  function updateChips(dt) {
    chipAcc += dt;
    if (chipAcc < 0.25) return;
    chipAcc = 0;
    var fx = PP.game.bossFx;
    var parts = [];
    if (fx.ink > 0) parts.push("🦑" + Math.ceil(fx.ink));
    if (fx.addle > 0) parts.push("🌀" + Math.ceil(fx.addle));
    if (fx.freeze > 0) parts.push("⚓" + Math.ceil(fx.freeze));
    if (fx.shotSlow > 0) parts.push("⏳" + Math.ceil(fx.shotSlow));
    if (fx.blackout > 0) parts.push("🌑" + Math.ceil(fx.blackout));
    if (battle.rndSpinT > 0) parts.push("🎲");
    if (guardT > 0) parts.push("🛡" + Math.ceil(guardT));   // ボスのシールド残り秒
    var s = parts.join(" ");
    if (s !== lastChipText) { lastChipText = s; fxChips.text = s; fxChips.updateCache(); }
  }

  // ---------- 妖弾(ボスの弾幕) ----------
  // type: "ink"(山なりの墨玉) / "addle" / "freeze" / "shotSlow" / "randomize"(直進オーブ)
  // グラデーション円をそのまま Shape で持つと弾ごとに毎フレーム再ラスタライズ
  // されて重い(弾幕中は100発近く生きる)ので、type ごとに一度だけ 1.25 倍解像度で
  // canvas に焼き、共有 Bitmap を返す(ball.js の焼き込みと同じ発想)。
  // 呼び出し側のパルス(最大1.12倍)でも native 解像度を超えない
  var INK_UR = 256, inkCanvas = null, inkAcc = 0;
  function bakeInk() {
    var sh = new createjs.Shape();
    sh.graphics.beginRadialGradientFill(
      ["rgba(10,8,14,0.88)", "rgba(10,8,14,0.83)", "rgba(10,8,14,0.7)", "rgba(10,8,14,0)"],
      [0, 0.55, 0.82, 1],
      0, 0, 0, 0, 0, INK_UR).drawCircle(0, 0, INK_UR);
    sh.cache(-INK_UR, -INK_UR, INK_UR * 2, INK_UR * 2);
    return sh.cacheCanvas;
  }

  // 飛沫の墨だまりの縮小率(config の bounce.puddleMul)。着弾処理と被弾処理の両方から使う
  function Kb2Scale() { return PP.BOSS.ink.bounce.puddleMul; }

  // scale: 墨だまり半径の倍率(省略=1)。飛沫の着弾は小さな墨だまりになる。
  // count: direct 時の墨だまり枚数(省略=6。飛沫の直撃は少なめ)
  function splatInk(x, y, direct, scale, count) {
    var B = PP.BOSS.ink;
    var n = direct ? (count || 6) : 1;
    if (!inkCanvas) inkCanvas = bakeInk();
    for (var i = 0; i < n; i++) {
      var r = (B.rMin + Math.random() * (B.rMax - B.rMin)) * (scale || 1);
      var bx = x, by = y;
      if (direct && i > 0) {        // 直撃は追加の墨が画面全域へ飛び散る
        bx = 120 + Math.random() * (PP.W - 240);
        by = 140 + Math.random() * (PP.H - 260);
        r *= 1.3;
      }
      // 中心は濃い墨だがわずかに透ける(完全な闇だと理不尽なので、
      // 目を凝らせば玉列がかろうじて読める程度に留める)
      // 同時数の上限(WebGL は config の glMax、Canvas2D は maxBlobs)。超えたら
      // 一番古い墨を晴らす。Canvas2D も全画面再合成のたびに全枚数を描くので、
      // 飛沫で枚数が伸びる今は無制限にしない
      var blobCap = PP.glActive ? B.glMax : B.maxBlobs;
      if (blobCap > 0) {
        while (battle.inkBlobs.length >= blobCap) {
          var old = battle.inkBlobs.shift();
          createjs.Tween.removeTweens(old.sh);
          if (old.sh.parent) old.sh.parent.removeChild(old.sh);
        }
      }
      var sh = new createjs.Bitmap(inkCanvas);
      sh.regX = sh.regY = INK_UR;
      sh.scaleX = sh.scaleY = r / INK_UR;
      sh.x = bx; sh.y = by;
      sh.alpha = 0;
      createjs.Tween.get(sh).to({ alpha: 1 }, 220);
      inkCont.addChild(sh);
      battle.inkBlobs.push({ sh: sh, bx: bx, by: by, ph: Math.random() * 6.28, life: B.dur });
    }
    PP.fx.burst(x, y, "rgba(20,14,26,0.9)", 14, 1.5);
    PP.fx.shake(direct ? 10 : 4, direct ? 0.3 : 0.15);   // 墨のベチャッという着弾を体でも感じる
    PP.audio.inkSplat();
    if (direct) PP.audio.beep(55, 0.4, "sawtooth", 0.16);   // 直撃は腹に来る重さを足す
    // WebGL 時は全画面 cache を使わない: 12Hz の updateCache は 1300×700 の
    // テクスチャ再アップロード(約44MB/s)になってしまう。GPU なら十数枚の
    // 共有 canvas ブロブを直接描くほうが遥かに安い。Canvas 2D は従来どおり
    // 「1枚に焼いて全画面ブリット」がフィルレート的に得
    if (!PP.glActive && !inkCont.cacheCanvas) inkCont.cache(0, 0, PP.W, PP.H);
    inkAcc = 1;   // 次の updateInk で即再合成(フェードイン開始を1フレームで反映)
  }

  function removeInk() {
    for (var i = 0; i < battle.inkBlobs.length; i++) {
      createjs.Tween.removeTweens(battle.inkBlobs[i].sh);
      if (battle.inkBlobs[i].sh.parent) battle.inkBlobs[i].sh.parent.removeChild(battle.inkBlobs[i].sh);
    }
    battle.inkBlobs.length = 0;
    if (inkCont && inkCont.cacheCanvas) inkCont.uncache();
  }

  function updateInk(dt) {
    if (battle.inkBlobs.length === 0) {
      if (inkCont.cacheCanvas) inkCont.uncache();   // 墨ゼロなら全画面ブリットもやめる
      return;
    }
    for (var i = battle.inkBlobs.length - 1; i >= 0; i--) {
      var b = battle.inkBlobs[i];
      b.life -= dt;
      if (b.life <= 0) {
        createjs.Tween.removeTweens(b.sh);
        if (b.sh.parent) b.sh.parent.removeChild(b.sh);
        battle.inkBlobs.splice(i, 1);
        continue;
      }
      b.sh.x = b.bx + Math.sin(t * 0.7 + b.ph) * 10;
      b.sh.y = b.by + Math.cos(t * 0.5 + b.ph) * 6;
      // 残り 0.8 秒からゆっくり薄れて消える(突然消えるより「晴れていく」)
      if (b.life < 0.8) b.sh.alpha = b.life / 0.8;
    }
    if (battle.inkBlobs.length === 0) {
      if (inkCont.cacheCanvas) inkCont.uncache();
      return;
    }
    inkAcc += dt;
    if (inkAcc >= 1 / 12) {
      inkAcc = 0;
      if (inkCont.cacheCanvas) inkCont.updateCache();
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
      if (k === battle.lastAttack) continue;
      if ((k === "addle" || k === "freeze" || k === "shotSlow") && fx[k] > 0) continue;
      if (k === "ink" && fx.ink > 0) continue;
      // ⚠系の大技は開幕からは撃たない(初見殺し防止)。進行中の同系統も避ける
      if ((k === "tentacle" || k === "tsunami" || k === "barrage") && battle.attackCount < 1) continue;
      // 両舷斉射は最重量級なので2手目以降・進行中は重ねない
      if (k === "cross" && (battle.attackCount < 2 || battle.crossActive)) continue;
      if (k === "tsunami" && wave) continue;
      if (k === "barrage" && battle.barrageLeft > 0) continue;
      if (k === "tentacle" && battle.tentWavesLeft > 0) continue;   // 追撃波の進行中は重ねない
      // 裁きの雷霆: 開幕は撃たない。落雷の進行中・暗闇中は重ねない
      if (k === "thunder" && (battle.attackCount < 1 || thunderXs.length > 0 ||
                              thunderBolts.length > 0 || fx.blackout > 0)) continue;
      if (k === "randomize" && (battle.rndSpinT > 0 || battle.sweepLeft > 0)) continue;
      if (k === "shotSlow" && battle.curtainLeft > 0) continue;
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
    bannerText.updateCache();
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
    removeNoParryNote();   // バナーが消える経路(攻撃阻止・後片付け)では注記も道連れ
  }

  // 【強化】パリィ不可の大技の予兆に添える注記(パリィ持ちにだけ意味がある情報)。
  // 技名バナーの帯(下端≈186)のすぐ下に出し、バナーと同じ寿命で消える
  var noParryTxt = null;
  function removeNoParryNote() {
    if (!noParryTxt) return;
    createjs.Tween.removeTweens(noParryTxt);
    if (noParryTxt.parent) noParryTxt.parent.removeChild(noParryTxt);
    noParryTxt = null;
  }
  function showNoParryNote(dur) {
    removeNoParryNote();
    noParryTxt = new createjs.Text(PP.i18n.t("boss.noParry"),
      'bold 15px "Meiryo", sans-serif', "#ff9a8a");
    noParryTxt.textAlign = "center";
    noParryTxt.x = PP.W / 2;
    noParryTxt.y = 200;
    noParryTxt.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    cacheTextFit(noParryTxt, 15);
    PP.layers.hud.addChild(noParryTxt);
    createjs.Tween.get(noParryTxt)
      .wait(Math.max(200, dur * 1000 - 300))
      .to({ alpha: 0 }, 300)
      .call(removeNoParryNote);
  }

  // ⚠予告マーカーを置く(赤い予告サークル+明滅する⚠)。timer 経過で消える。
  // 解決(触手の突き上げ)は fireAttack 側が pendingZones を読んで行う
  // ⚠マーカーの部品は「基準サイズで一度だけ焼いた共有 canvas」を
  // Bitmap + scale で使い回す。攻撃のたびに半径違いの cache を焼き直す方式は、
  // Canvas2D では焼きコストが、WebGL では新規テクスチャの生成・破棄が毎回
  // 走ってしまう。線幅も scale と一緒に伸縮するが、2〜3px 級の差は判別できない
  var WARN_R0 = 64;   // 焼き込みの基準半径(⚠文字の等倍基準)
  var warnTxtC = null;
  function bakeWarn() {
    if (warnTxtC) return;
    // 赤フィルは濃いめ(0.5)で描き、表示側の alpha(0.28→充血で上げる)で薄める。
    // globalAlpha は 1 で頭打ちなので「薄く描いて alpha>1」では濃くできない
    // (帯本体は addWarning が幅ごとに描く。ここで焼くのは ⚠ の文字だけ)
    var t = new createjs.Text("⚠", "700 34px sans-serif", "#ffd24a");
    t.textAlign = "center"; t.textBaseline = "middle";
    t.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    t.cache(-28, -28, 56, 60);   // 字形+影(下2px/ぼかし6px)ぶんの余白
    warnTxtC = t.cacheCanvas;
  }
  function warnBitmap(canvas, x, y, scale) {
    var b = new createjs.Bitmap(canvas);
    b.regX = canvas.width / 2;   // 共有 canvas の中心=マーカーの中心
    b.regY = canvas.height / 2;
    b.x = x; b.y = y;
    if (scale) b.scaleX = b.scaleY = scale;
    return b;
  }
  // 危険エリアは「縦長の四角い帯」で示す。帯の半幅は r(判定は r+25 だが、
  // +25 は大砲自身の半幅ぶん。帯を r にしておくと「大砲の体が帯に触れたら当たり」
  // という見え方になり、当たり幅そのものを塗るより小さく正直に見える)。
  // 高さは大砲の頭上から画面下端まで(大砲の段が対象)。
  // 同時に出るのは多くて 8 本なので、帯は毎回 cache して描く(共有 canvas を
  // 非等方 scale すると枠線の太さが縦横で崩れる)
  function addWarning(x, y, r, timer) {
    bakeWarn();
    var hw = r;
    var top = PP.CANNON_Y - 80, h = PP.H - 4 - top;
    var fillSh = new createjs.Shape();
    fillSh.graphics.beginFill("rgba(255,48,32,0.5)").drawRect(-hw, 0, hw * 2, h);
    fillSh.cache(-hw - 2, -2, hw * 2 + 4, h + 4);
    fillSh.x = x; fillSh.y = top; fillSh.alpha = 0.28;
    var ringSh = new createjs.Shape();
    ringSh.graphics.setStrokeStyle(3).beginStroke("#ff3020").drawRect(-hw, 0, hw * 2, h);
    ringSh.cache(-hw - 4, -4, hw * 2 + 8, h + 8);
    ringSh.x = x; ringSh.y = top;
    // 収束枠: 帯の内側の枠が左右から中心へ縮む(残り時間の目安。scaleX だけ動かす)
    var sh = new createjs.Shape();
    sh.graphics.setStrokeStyle(2).beginStroke("rgba(255,120,90,0.8)").drawRect(-hw, 0, hw * 2, h);
    sh.cache(-hw - 3, -3, hw * 2 + 6, h + 6);
    sh.x = x; sh.y = top;
    var txt = warnBitmap(warnTxtC, x, y);      // ⚠は幅によらず等倍
    warnCont.addChild(fillSh, ringSh, sh, txt);
    warnings.push({ x: x, y: y, r: r, timer: timer, total: timer,
                    sh: sh, fill: fillSh, ring: ringSh, txt: txt, shade: null });
  }

  function removeWarningViews(w) {
    if (w.shade && w.shade.parent) warnCont.removeChild(w.shade);
    if (w.sh.parent) warnCont.removeChild(w.sh);
    if (w.fill.parent) warnCont.removeChild(w.fill);
    if (w.ring.parent) warnCont.removeChild(w.ring);
    if (w.txt.parent) warnCont.removeChild(w.txt);
  }

  function clearWarnings() {
    for (var i = 0; i < warnings.length; i++) removeWarningViews(warnings[i]);
    warnings.length = 0;
    battle.pendingZones.length = 0;
    // ⚠が消えるとき(攻撃キャンセル・ボス撃破・後片付け)は警報SEも道連れに
    PP.audio.bossDangerStop();
  }

  // ⚠マーカーの毎フレーム描画。残り時間 k(0→1)で恐怖感を積み上げる:
  //   鼓動の加速(リングと⚠の明滅が速くなる)/ ⚠が膨らむ / 赤フィルが充血し
  //   最後の 0.25 秒は高速点滅 / 水面下から影がせり上がる / 水面に気泡 /
  //   地鳴り(shake。強い要求が勝つ実装なので他の揺れを邪魔しない)。
  //   全部が焼き済み Bitmap の scale/alpha 操作なので毎フレームでも軽い
  function updateWarnings(dt) {
    var kMax = -1;
    for (var i = warnings.length - 1; i >= 0; i--) {
      var w = warnings[i];
      w.timer -= dt;
      if (w.timer <= 0) {
        removeWarningViews(w);
        warnings.splice(i, 1);
        continue;
      }
      var k = 1 - w.timer / w.total;                 // 0→1 で収束
      if (k > kMax) kMax = k;
      w.ring.alpha = 0.5 + 0.3 * Math.sin(t * (12 + k * 28));
      // 内側へ収束するリング=残り時間。焼き済みリングを scale で縮めるだけ。
      // 旧実装の「毎フレーム clear→パス再構築」はここでは丸ごと消えている
      w.sh.scaleX = 1 - k * 0.85;   // 内枠が左右から中心へ縮む
      w.txt.alpha = 0.6 + 0.4 * Math.sin(t * (10 + k * 30));
      w.txt.scaleX = w.txt.scaleY = 1 + k * 0.35;
      // 赤フィルの充血(0.14 相当 → 0.4 相当)。最後の 0.25 秒は高速点滅
      w.fill.alpha = (w.timer < 0.25) ? 0.7 + 0.3 * Math.sin(t * 60) : 0.28 + k * 0.5;
      // 影の浮上: 画面下端の外から⚠の位置へ。近づくほど縦に膨らむ
      if (w.shade) {
        w.shade.y = PP.H + 40 - (PP.H + 40 - w.y) * k;
        w.shade.scaleY = (w.r / WARN_R0) * (0.35 + k * 0.4);
      }
      // 水面の気泡: 何かが上がってくる(k が進むほど頻繁に)
      if (Math.random() < dt * (4 + k * 16)) {
        PP.fx.burst(w.x + (Math.random() - 0.5) * w.r * 1.2, PP.H - 6,
                    "rgba(200,230,246,0.8)", 1, 0.9);
      }
    }
    if (kMax >= 0) PP.fx.shake(1 + kMax * 5, 0.1);   // 地鳴り
  }

  function startTelegraph(key, teleOverride) {
    curAttack = key;
    battle.state = "telegraph";
    stateT = teleOverride || PP.BOSS[key].telegraph;
    curTeleTotal = stateT;
    var a = ATTACKS[key];
    if (key === "thunder") {
      // 裁きの雷霆: 右から/左からをここで決め、大砲の段を流れる矢羽で知らせる
      // (文字では言わない。矢羽の流れる向き=掃引の向き)
      thunderDir = Math.random() < 0.5 ? 1 : -1;
      thunderPasses = battle.phase2 ? 2 : 1;
      showThunderArrow(stateT + 0.3);
    }
    // 宣言バナー + 低い唸りの警告音。
    // チャージリングが出ている間にダメージを与えれば攻撃はキャンセルできる
    showBanner(PP.i18n.t(a.nameKey), a.color, stateT + 0.4);
    // 大技はパリィ適用外: パリィ持ちにだけ、バナーの下へ注記を添える
    if (NO_PARRY[key] && PP.upgrades && PP.upgrades.level("parry") > 0) {
      showNoParryNote(stateT + 0.4);
    }
    PP.audio.beep(140, 0.3, "sawtooth", 0.1);
    PP.audio.beep(110, 0.45, "sine", 0.09);
    // 予兆の間、画面全体に薄い血の色を差す(「来るぞ」の圧)
    PP.fx.screenFlash("rgba(140,0,0,0.10)", 0.10, stateT * 1000);
    // 重量級の攻撃はボスが咆哮する
    if (key === "tentacle" || key === "tsunami" || key === "barrage" || key === "cross" ||
        key === "thunder") {
      PP.audio.bossRoar();
    }

    if (key === "tentacle") {
      // 第1波の⚠は「ここ」ではなく、突き上げの tentWarnTime(0) 秒前に置く
      // (update の telegraph 分岐 → placeFirstTentacleWarnings)。予兆開始時に
      // 置くと 1.6 秒前の自機位置を狙うことになり、その間に動かれると見当違いの
      // 場所へ突き上がる。追撃波と同じ「置いてから突き上げまで」の長さに揃える
      battle.pendingZones.length = 0;
    } else if (key === "tsunami") {
      // 安全地帯(光の柱)を先に見せる。波は fireAttack で走り出す
      var S = PP.BOSS.tsunami;
      tsuSafeX = 200 + Math.random() * (PP.W - 400);
      tsuDir = Math.random() < 0.5 ? 1 : -1;
      showSafePillar(tsuSafeX, S.gapW);
      PP.audio.tsunamiCharge();   // 引き波の溜め(予兆の間ずっと不穏に響く)
    } else if (key === "cross") {
      // 両舷斉射の予兆: 両舷から初期掃引点(画面中央)への2本の線を点滅表示。
      // 左舷は掃引点の右側・右舷は左側を狙うので、線は途中で X 字に交差する。
      // 掃引点そのもの(2本の線の間)は安全地帯なので、⚠ではなく
      // 光の柱(crossSafe)で「ここに立て」を示す。柱は掃引に追従して動く
      var C = PP.BOSS.cross;
      var aimX0 = PP.W / 2, iy0 = PP.CANNON_Y - 20;
      // 予兆線はボスが寄っていく先=画面中央の発射口から描く
      // (予兆の間にボス本体が中央へ滑り込んで、この線に重なる)
      var emitters = [
        { x: PP.W / 2 - C.emitDX, y: PP.BOSS.y + C.emitDY, tx: aimX0 + C.aimCrossGap },
        { x: PP.W / 2 + C.emitDX, y: PP.BOSS.y + C.emitDY, tx: aimX0 - C.aimCrossGap }
      ];
      for (var ci = 0; ci < emitters.length; ci++) {
        var e = emitters[ci];
        var lnSh = new createjs.Shape();
        lnSh.graphics.setStrokeStyle(3).beginStroke("rgba(159,216,255,0.55)")
          .moveTo(e.x, e.y).lineTo(e.tx, iy0);
        // 線の外接矩形で cache(非 cache の Shape は GL で描かれない。明滅は alpha)
        var lx0 = Math.min(e.x, e.tx) - 3, ly0 = Math.min(e.y, iy0) - 3;
        lnSh.cache(lx0, ly0, Math.abs(e.x - e.tx) + 6, Math.abs(e.y - iy0) + 6);
        warnCont.addChild(lnSh);
        crossTele.push(lnSh);
      }
      if (battle.crossSafe) battle.crossSafe.x = aimX0;   // 安置柱は中央から(明滅は update 側)
    }
  }

  // 両舷斉射の予兆線を跡形なく片付ける(発射・阻止・リセットの全経路から呼ぶ)
  function clearCrossTele() {
    for (var i = 0; i < crossTele.length; i++) {
      if (crossTele[i].parent) crossTele[i].parent.removeChild(crossTele[i]);
    }
    crossTele.length = 0;
  }

  // 怒りフェーズは全弾速がこの倍率で上がる
  function spdMul() { return battle.phase2 ? PP.BOSS.phase2.speedMul : 1; }

  // ---------- 触手突き上げ(⚠地点に画面下から生える) ----------
  function spawnStrike(x, waveIdx) {
    var K = PP.BOSS.tentacle;
    var sh = new createjs.Shape();
    strikeCont.addChild(sh);
    strikes.push({ sh: sh, x: x, timer: K.riseTime + K.holdTime, rise: K.riseTime,
                   hold: K.holdTime, hitDone: false, seed: Math.random() * 6.28,
                   wave: waveIdx || 0 });
  }

  // ⚠地点を選んで out へ push する(第1波と追撃波で共用)。波番号 waveIdx の
  // 偶奇で 2 種類の型を交互に出す:
  //   偶数波 = 「プレイヤー狙い」3本: 大砲の現在X + その左右 minGap px。
  //            自機の真下が当たり範囲の中心=「動け」の圧。左右の触手との間
  //            (60px の安全帯)へ逃げるか、外側へ大きく走るかの二択
  //   奇数波 = 「左右の挟み撃ち」4本: 大砲の左右 pincerInner px に内側の2本、
  //            さらに minGap 外に外側の2本。自機の真下だけが安全(幅 ≈ 2×
  //            (pincerInner-(r+25)) px)=「動くな」の圧。動け→動くな→動け…の
  //            交互で、リズムを読み違えた側が刺さる
  //   minGap は被弾判定 (r+25)×2 + 60 なので、隣り合う⚠の間に必ず 60px 以上の
  //   安全帯が残る。画面外にはみ出す本は置かない(端では本数が減る。それで良い)
  function pickTentacleZones(waveIdx, out) {
    var K = PP.BOSS.tentacle;
    var lo = 90, hi = PP.W - 90;
    var cx = Math.max(lo, Math.min(hi, PP.cannon.x));
    if (!(waveIdx & 1)) {
      // 自機狙い 3 本。左右の本が画面外なら、自機の当たり範囲 +30px より外で
      // 画面端に寄せる(端でも 3 本を保つ。それも無理なら 2 本)
      out.push(cx);
      for (var sd = -1; sd <= 1; sd += 2) {
        var zx = cx + sd * K.minGap;
        if (zx >= lo && zx <= hi) { out.push(zx); continue; }
        var eg = sd < 0 ? lo : hi;
        if (Math.abs(eg - cx) >= K.r + 25 + 30) out.push(eg);
      }
      return;
    }
    // 挟み撃ち 4 本。自機が中央から離れていると外側(±(pincerInner+minGap))が
    // 画面外に出るので、そのままだと 2〜3 本しか出ない。外側が置けない側は
    //   a) 画面端に寄せる(内側の本と重なって見えない程度に離れていれば可。
    //      当たり範囲が重なっても「端へ逃げる道が塞がる」だけで挟み撃ちの
    //      趣旨どおり。自機の安全帯は内側 2 本で決まるので損なわれない)
    //   b) それも無理なら反対側のさらに外(outer + minGap)へ回す
    // で本数を保つ。自機の真下(±pincerInner 内)には決して置かない
    var hitW = 60;   // 端に寄せた本と内側の本の最小距離(⚠が重なって見えない程度)
    var inner = [cx - K.pincerInner, cx + K.pincerInner];
    var outer = [cx - K.pincerInner - K.minGap, cx + K.pincerInner + K.minGap];
    var overflow = 0;   // 置けなかった外側の本数(反対側へ回す)
    for (var s = 0; s < 2; s++) if (inner[s] >= lo && inner[s] <= hi) out.push(inner[s]);
    for (var s2 = 0; s2 < 2; s2++) {
      var ox = outer[s2];
      if (ox >= lo && ox <= hi) { out.push(ox); continue; }
      var edge = s2 === 0 ? lo : hi;   // a) 端へ寄せる
      var innerOk = inner[s2] < lo || inner[s2] > hi || Math.abs(edge - inner[s2]) >= hitW;
      // 端に寄せた本は自機の当たり範囲(r+25)+30px の外にあればよい(その側の
      // 安全帯は 30px に狭まるが、動かなければ当たらない)
      if (Math.abs(edge - cx) >= K.r + 25 + 30 && innerOk) { out.push(edge); continue; }
      overflow++;
    }
    // b) 反対側へ回す: 置けた側の外側のさらに minGap 外
    for (var k = 0; k < overflow; k++) {
      var far = out[out.length - 1];
      var side = far >= cx ? 1 : -1;
      var fx = far + side * K.minGap;
      if (fx >= lo && fx <= hi) out.push(fx);
    }
  }

  // 第1波の⚠(予兆の残り warnT 秒で呼ばれる)。「プレイヤー狙い」3本を
  // 呼ばれた瞬間の自機位置で置き、警報SE+ライザーを鳴らす
  function placeFirstTentacleWarnings(warnT) {
    var K = PP.BOSS.tentacle;
    battle.pendingZones.length = 0;
    pickTentacleZones(0, battle.pendingZones);
    for (var i = 0; i < battle.pendingZones.length; i++) {
      addWarning(battle.pendingZones[i], PP.CANNON_Y - 20, K.r, warnT);
    }
    PP.audio.bossDanger();   // ⚠群の出現音(マーカー数に関係なく1回)
    PP.audio.gliss(160, 320, warnT, "sine", 0.05);   // 突き上げまでのライザー(追撃波と同じ)
  }

  // 波番号 idx(0=第1波)の予告秒数と間(gap)秒数。波が進むほど decay 倍で縮み、
  // 下限(warnMin/gapMin)で止まる=ドラムがどんどん速くなる
  function tentWarnTime(idx) {
    var K = PP.BOSS.tentacle;
    if (idx === 0) return battle.phase2 ? K.firstWarnP2 : K.firstWarn;   // 第1波は長めの予告
    var base = battle.phase2 ? K.waveWarnP2 : K.waveWarn;
    return Math.max(K.warnMin, base * Math.pow(K.warnDecay, idx - 1));
  }
  function tentGapTime(idx) {
    var K = PP.BOSS.tentacle;
    return Math.max(K.gapMin, K.waveGap * Math.pow(K.gapDecay, idx));
  }

  // 締めの 1 本: 3本→4本→3本→4本 のドラムの後に、自機の真下へ 1 本だけ。
  // 挟み撃ち(動くな)で足を止めた直後に真下へ来るので、最後にもう一歩動いて
  // 避け切る手応えが残る
  function pickFinalZones(out) {
    var lo = 90, hi = PP.W - 90;
    out.push(Math.max(lo, Math.min(hi, PP.cannon.x)));
  }

  // 最終波の「壁」: 画面幅いっぱいの等間隔列(間隔 2r+10)を並べ、大砲から
  // ±wallReach px 以内にある1列を抜いて隙間にする。隙間は 1 列ぶん(≈230px)
  // なので、⚠の予告時間(waveWarn)のうちに横へ走れば必ず入れる。
  // 「どこへ逃げてもいい」追撃波の後に「ここへしか逃げられない」壁が来る=
  // 波状のドラムの締めとして一番圧が高い形
  function pickWallZones(out) {
    var K = PP.BOSS.tentacle;
    var step = K.r * 2 + 10;
    var cols = [];
    for (var x = 90; x <= PP.W - 90; x += step) cols.push(x);
    // 隙間の候補: 大砲から wallReach 以内の列。無ければ一番近い列
    var cand = [], nearest = 0;
    for (var i = 0; i < cols.length; i++) {
      var dx = Math.abs(cols[i] - PP.cannon.x);
      if (dx <= K.wallReach) cand.push(i);
      if (dx < Math.abs(cols[nearest] - PP.cannon.x)) nearest = i;
    }
    var gap = cand.length ? cand[Math.floor(Math.random() * cand.length)] : nearest;
    for (var c = 0; c < cols.length; c++) if (c !== gap) out.push(cols[c]);
  }

  // 触手の追撃波: fireAttack の第1波の後、「間(gap)→⚠(warn)→突き上げ」を
  // tentWavesLeft 回繰り返す。⚠は pickTentacleZones で「3本(自機狙い)→4本
  // (挟み撃ち)」を交互に。予告と間は波ごとに縮む(tentWarnTime/tentGapTime)。
  // wallWave を立てると最終波だけ横一列の「壁」(pickWallZones)に差し替わる。
  // 全打撃に warnMin 秒以上の予告がある
  function updateTentacleWaves(dt) {
    if (battle.tentWavesLeft <= 0) return;
    var K = PP.BOSS.tentacle;
    battle.tentTimer -= dt;
    if (battle.tentTimer > 0) return;
    if (battle.tentPhase === "gap") {
      var nextIdx = battle.tentWaveIdx + 1;           // これから予告する波の番号(0=第1波)
      var warnT = tentWarnTime(nextIdx);
      tentPending.length = 0;
      var isWall = K.wallWave && battle.tentWavesLeft === 1;
      if (isWall) pickWallZones(tentPending);
      else if (battle.tentWavesLeft === 1) pickFinalZones(tentPending);   // 締めは真下へ 1 本
      else pickTentacleZones(nextIdx, tentPending);
      // 前の波の触手はここで引っ込める。後半の波は 0.4 秒間隔まで詰まるので、
      // holdTime(0.9s)ぶん居座らせると前の波の柱が残ったまま次の波が生え、
      // 画面上の本数が混ざって 3本/4本の交互が読めなくなる(斬り返しの窓は
      // 次の⚠が出るまで=波の間隔ぶん)
      retractStrikes();
      for (var i = 0; i < tentPending.length; i++) {
        addWarning(tentPending[i], PP.CANNON_Y - 20, K.r, warnT);
      }
      PP.audio.bossDanger();   // ⚠群の出現音(旧: マーカーごとの beep は重複するので廃止)
      PP.audio.gliss(160, 320, warnT, "sine", 0.05);   // 次撃までのライザー(緊張感)
      // 壁波は画面全体が赤く染まる(「全部来る」を予告の色でも言う)
      PP.fx.screenFlash(isWall ? "rgba(140,0,0,0.16)" : "rgba(140,0,0,0.08)", isWall ? 0.16 : 0.08, warnT * 1000);
      battle.tentPhase = "warn";
      battle.tentTimer = warnT;
    } else {
      // ⚠満了 → 突き上げ。振り下ろしのフォール音+シェイク
      battle.tentWaveIdx++;
      PP.audio.bossDangerStop();   // 触手が出たら警報(⚠のSE)は断ち切る
      for (var j = 0; j < tentPending.length; j++) spawnStrike(tentPending[j], battle.tentWaveIdx);
      tentPending.length = 0;
      battle.tentWavesLeft--;
      PP.audio.gliss(300, 55, 0.22, "sawtooth", 0.14);
      if (battle.tentWavesLeft <= 0) {
        // 最終波: 締めの重低音+大きめのシェイク+赤閃で「海が割れた」を
        // 体で分からせる(本数ぶんの個別シェイクは shake が最大値で束ねる)
        PP.audio.beep(48, 0.6, "sawtooth", 0.22);
        PP.fx.shake(18, 0.35);
        PP.fx.screenFlash("rgba(140,0,0,0.14)", 0.14, 240);
      } else {
        PP.fx.shake(10, 0.2);
      }
      battle.tentPhase = "gap";
      battle.tentTimer = tentGapTime(battle.tentWaveIdx);
    }
  }

  // 立っている触手に「引っ込め」を予約する。実際に縮み始めるのは伸び切って
  // 命中判定を終えた後(updateStrikes)。まだ伸びている途中の柱を途中で
  // 戻すと、その柱の命中判定が一度も走らない(=当たらない触手)になるため
  function retractStrikes() {
    for (var i = 0; i < strikes.length; i++) strikes[i].retract = true;
  }

  function clearStrikes() {
    for (var i = 0; i < strikes.length; i++) {
      if (strikes[i].sh.parent) strikeCont.removeChild(strikes[i].sh);
    }
    strikes.length = 0;
  }

  // 柱1本の作画(30Hz のスロットル時だけ呼ぶ)。太い round ストロークの
  // 再ラスタライズが重いので、描いたら cache して次の再描画まで blit
  function redrawStrike(s, topY) {
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
    if (s.sh.cacheCanvas) s.sh.updateCache();
    else s.sh.cache(s.x - 50, PP.CANNON_Y - 110, 100, PP.H + 40 - (PP.CANNON_Y - 110));
  }

  var strikeAcc = 1;
  function updateStrikes(dt) {
    var K = PP.BOSS.tentacle;
    var g2 = PP.game;
    strikeAcc += dt;
    var redraw = strikeAcc >= 1 / 20;
    if (redraw && strikes.length > 0) strikeAcc = 0;
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
      // 作画だけ 30Hz に間引く。当たり判定・パリィ窓は毎フレーム full-dt のまま
      if (redraw || !s.sh.cacheCanvas) redrawStrike(s, topY);
      // 命中判定は伸び切った瞬間に1回だけ。水柱+衝撃波で「海を割った」感を出す
      if (!s.hitDone && k >= 1) {
        s.hitDone = true;
        PP.fx.burst(s.x, PP.CANNON_Y - 60, "#ff5030", 14, 1.6);
        PP.fx.burst(s.x, PP.H - 20, "rgba(200,230,246,0.9)", 26, 2.0);   // 突き破った水しぶき
        PP.fx.flash(s.x, PP.H - 40, "rgba(200,230,246,0.5)", 70);          // 水面が白く裂ける
        PP.fx.ring(s.x, PP.CANNON_Y - 40, "#ff5030", 20, 120, 400);
        PP.fx.ring(s.x, PP.H - 30, "rgba(190,230,246,0.8)", 10, 90, 450);
        PP.fx.shake(14, 0.3);
        // 打撃のビープは波が進むほど低く・大きく(78→71→64→57Hz)。
        // ドラムを追うだけで「まだ続く/終わりが近い」が耳で分かる
        PP.audio.beep(Math.max(50, 78 - s.wave * 7), 0.42, "sawtooth", 0.2);
        if (Math.abs(PP.cannon.x - s.x) < K.r + 25) {
          if (battle.orbHitCd <= 0) {
            var pool = ["freeze", "addle", "shotSlow"];
            // フル時間のデバフ(0.7 倍では軽すぎて触手が怖くなかった)
            applyDebuff(pool[Math.floor(Math.random() * pool.length)], 1.0);
            // 触手専用の短い無敵(K.hitIFrames)。orb.hitIFrames だと追撃波が
            // 全部無効化されて波状のドラムが死ぬ。「連続ハメだけ防ぐ」長さ
            battle.orbHitCd = K.hitIFrames;
            PP.cannon.setHurt(K.hitIFrames);
            PP.fx.shake(10, 0.3);
          } else {
            // 無敵中はバリアが掠める演出のみ(以前は無敵を無視して多段被弾していた)
            PP.fx.burst(PP.cannon.x, PP.cannon.y - 40, "#9fd8ff", 6, 1.0);
          }
        }
      }
      // 次の波の⚠が出ていれば、命中判定を終えた柱はすぐ縮んで戻る
      if (s.hitDone && s.retract && s.timer > 0.18) s.timer = 0.18;
      // リスクリターンの後段: 突き上げ後も holdTime の間は触手が居座る。
      // その間に自弾を当てれば「斬り返し」= ボス本体へダメージ+触手は即退散。
      // 避けるだけでなく、あえて近くで撃ち返す択が生まれる
      if (s.hitDone && s.timer > 0.18) {
        for (var si = g2.shots.length - 1; si >= 0; si--) {
          var sh2 = g2.shots[si];
          if (Math.abs(sh2.x - s.x) < 32 && sh2.y > topY - 10) {
            if (sh2.special !== "missile") {
              if (sh2.view.spark) createjs.Tween.removeTweens(sh2.view.spark);
              PP.layers.shot.removeChild(sh2.view);
              g2.shots.splice(si, 1);
            }
            s.timer = 0.18;                 // 斬られた触手は即退散
            PP.fx.burst(s.x, sh2.y, "#8ef0d0", 12, 1.4);
            PP.fx.floatText(PP.i18n.t("boss.tentacleCut"), s.x, sh2.y - 30, "#8ef0d0", 20);
            PP.audio.beep(660, 0.12, "square", 0.09);
            onHit(1, s.x, sh2.y);           // 本体まで痛みが走る(HP-1)
            break;
          }
        }
      }
    }
  }

  // ---------- 裁きの雷霆(右→左へ順番に落ちる落雷。被弾で暗闇) ----------
  // fireAttack が thunderXs(右から順)を用意し、ここが interval 秒おきに先頭を
  // 取り出して⚠を置き(warn 秒の予告)、時間が来たら strikeBolt で落とす。
  // 落雷は弾体を持たない(パリィ不可)。当たり判定は落ちた瞬間の1回だけ
  // 1往路ぶんの落雷X を thunderDir の始点側から順に並べる(1往路を消費)
  function fillThunderPass() {
    var K = PP.BOSS.thunder;
    var nb = battle.phase2 ? K.boltsP2 : K.bolts;
    thunderXs.length = 0;
    for (var bi = 0; bi < nb; bi++) {
      var k = bi / (nb - 1);                       // 0=始点側 → 1=終点側
      var x = K.margin + (PP.W - K.margin * 2) * (thunderDir > 0 ? 1 - k : k);
      thunderXs.push(x);
    }
    thunderPasses--;
  }

  // 掃引の向きを示す矢羽(シェブロン)の列: 大砲の段の少し上に、画面幅いっぱいの
  // 細い光の線と、掃引の向きを向いた矢羽を等間隔に並べ、光が始点側から終点側へ
  // 順に走る(updateThunder)。文字を使わず、流れる向きだけで「どちらから来るか」
  // を読ませる。矢羽は共有 canvas を 1 枚焼いて Bitmap で並べる(scaleX で左右反転)
  var chevronC = null;
  function bakeChevron() {
    if (chevronC) return;
    var s = new createjs.Shape();
    // 右向きの「›」を二重線で(外=雷の黄、内=白の芯)
    s.graphics.setStrokeStyle(5, "round", "round").beginStroke("#fff27a")
      .moveTo(-10, -14).lineTo(4, 0).lineTo(-10, 14).endStroke();
    s.graphics.setStrokeStyle(2, "round", "round").beginStroke("#ffffff")
      .moveTo(-10, -14).lineTo(4, 0).lineTo(-10, 14).endStroke();
    s.cache(-16, -20, 32, 40);
    chevronC = s.cacheCanvas;
  }
  function showThunderArrow(dur) {
    hideThunderArrow();
    bakeChevron();
    var K = PP.BOSS.thunder;
    var cont = new createjs.Container();
    var y = PP.CANNON_Y - 70;
    // 段の光の線(始点側が明るく、終点側へ薄れる)
    var line = new createjs.Shape();
    var x0 = K.margin - 40, x1 = PP.W - K.margin + 40;
    line.graphics.beginLinearGradientFill(
      thunderDir > 0 ? ["rgba(255,242,122,0)", "rgba(255,242,122,0.7)"]
                     : ["rgba(255,242,122,0.7)", "rgba(255,242,122,0)"],
      [0, 1], x0, 0, x1, 0).drawRect(x0, y - 1, x1 - x0, 2);
    line.cache(x0, y - 2, x1 - x0, 4);
    cont.addChild(line);
    var chevrons = [];
    var n = 9;
    for (var i = 0; i < n; i++) {
      var b = new createjs.Bitmap(chevronC);
      b.regX = 16; b.regY = 20;
      b.x = K.margin + (PP.W - K.margin * 2) * i / (n - 1);
      b.y = y;
      b.scaleX = -thunderDir;    // 右から来る(dir>0)なら左向き「‹」
      cont.addChild(b);
      chevrons.push(b);
    }
    warnCont.addChild(cont);
    thunderArrow = { cont: cont, chevrons: chevrons, t: dur, total: dur };
  }
  function hideThunderArrow() {
    if (thunderArrow && thunderArrow.cont.parent) warnCont.removeChild(thunderArrow.cont);
    thunderArrow = null;
  }

  function updateThunder(dt) {
    var K = PP.BOSS.thunder;
    if (thunderArrow) {
      thunderArrow.t -= dt;
      if (thunderArrow.t <= 0) hideThunderArrow();
      else {
        // 光が始点側から終点側へ順に走る(矢羽ごとに位相をずらした明滅)。
        // 消える直前 0.3 秒はフェードアウト
        var ch = thunderArrow.chevrons, n = ch.length;
        var fade = thunderArrow.t < 0.3 ? thunderArrow.t / 0.3 : 1;
        for (var ci = 0; ci < n; ci++) {
          var order = thunderDir > 0 ? (n - 1 - ci) : ci;    // 始点側が 0
          var ph = t * 9 - order * 0.9;
          var w = Math.max(0, Math.sin(ph));
          ch[ci].alpha = (0.25 + 0.75 * w * w) * fade;
          ch[ci].x = PP.BOSS.thunder.margin + (PP.W - PP.BOSS.thunder.margin * 2) * ci / (n - 1)
                     - thunderDir * 6 * w;
        }
      }
    }
    if (thunderXs.length > 0) {
      battle.thunderTimer -= dt;
      if (battle.thunderTimer <= 0) {
        var x = thunderXs.shift();
        addWarning(x, PP.CANNON_Y - 20, K.r, K.warn);
        thunderBolts.push({ x: x, t: K.warn });
        PP.audio.beep(1400 - thunderBolts.length * 60, 0.08, "square", 0.05);   // 帯電のチッ
        battle.thunderTimer = battle.phase2 ? K.intervalP2 : K.interval;
        if (thunderXs.length === 0 && thunderPasses > 0) {
          // 怒りフェーズ: 往路を撃ち終えたら反対側からもう1往路(passGap 秒の間)
          thunderDir = -thunderDir;
          fillThunderPass();
          battle.thunderTimer = K.passGap;
          showThunderArrow(K.passGap + K.warn);   // 矢羽が逆向きに流れ出す=折り返しの合図
          PP.audio.beep(180, 0.3, "sawtooth", 0.1);
        }
      }
    }
    for (var i = thunderBolts.length - 1; i >= 0; i--) {
      thunderBolts[i].t -= dt;
      if (thunderBolts[i].t <= 0) {
        strikeBolt(thunderBolts[i].x);
        thunderBolts.splice(i, 1);
      }
    }
    // 雷の線は 0.25 秒で消える(alpha を落とすだけ)
    for (var f = boltFx.length - 1; f >= 0; f--) {
      var b = boltFx[f];
      b.t -= dt;
      if (b.t <= 0) {
        if (b.sh.parent) b.sh.parent.removeChild(b.sh);
        boltFx.splice(f, 1);
      } else {
        b.sh.alpha = b.t / 0.25;
      }
    }
    // 暗闇の解除(powerups.update が 0 にする)を拾って手札の色を戻す
    var dark = PP.game.bossFx.blackout > 0;
    if (blackoutWas && !dark) PP.cannon.refreshBalls();
    blackoutWas = dark;
  }

  // 落雷: ボスの高さから大砲の高さまでギザギザの線(白い芯+黄の外光)。
  // 範囲内なら暗闇(色不明+交換不能)。触手と同じ短い専用無敵で連続ハメだけ防ぐ
  function strikeBolt(x) {
    var K = PP.BOSS.thunder;
    var y0 = PP.BOSS.y + 20, y1 = PP.CANNON_Y - 20;
    var sh = new createjs.Shape();
    var gph = sh.graphics;
    var pts = [], segs = 9;
    for (var s = 0; s <= segs; s++) {
      var yy = y0 + (y1 - y0) * s / segs;
      var xx = x + (s === 0 || s === segs ? 0 : (Math.random() - 0.5) * 70);
      pts.push([xx, yy]);
    }
    gph.setStrokeStyle(9).beginStroke("rgba(255,242,122,0.55)").moveTo(pts[0][0], pts[0][1]);
    for (var p = 1; p < pts.length; p++) gph.lineTo(pts[p][0], pts[p][1]);
    gph.endStroke();
    gph.setStrokeStyle(3).beginStroke("#ffffff").moveTo(pts[0][0], pts[0][1]);
    for (var q = 1; q < pts.length; q++) gph.lineTo(pts[q][0], pts[q][1]);
    gph.endStroke();
    sh.cache(x - 50, y0 - 6, 100, y1 - y0 + 12);   // GL 対応(非 cache の Shape は描かれない)
    strikeCont.addChild(sh);
    boltFx.push({ sh: sh, t: 0.25 });
    // 落雷の雷鳴(SE/Thunder.mp3 + 炸裂音。間引きは audio.js)と閃光。着弾点に火花+衝撃波
    PP.audio.thunder();
    PP.fx.screenFlash("rgba(255,255,220,1)", 0.18, 120);
    PP.fx.flash(x, y1, "rgba(255,250,200,0.9)", 60);
    PP.fx.burst(x, y1, "#fff27a", 16, 1.6);
    PP.fx.ring(x, y1, "#fff27a", 16, 110, 380);
    PP.fx.shake(9, 0.2);
    if (Math.abs(PP.cannon.x - x) < K.r + 25) {
      if (battle.orbHitCd <= 0) {
        applyDebuff("blackout", 1.0);
        battle.orbHitCd = K.hitIFrames;
        PP.cannon.setHurt(K.hitIFrames);
        PP.fx.shake(12, 0.3);
      } else {
        // 無敵中はバリアが掠める演出のみ
        PP.fx.burst(PP.cannon.x, PP.cannon.y - 40, "#9fd8ff", 6, 1.0);
      }
    }
  }

  // 落雷の予定と線を片付ける(撃破・リセット)。暗闇中なら手札の色も戻す
  function clearThunder() {
    thunderXs.length = 0;
    thunderBolts.length = 0;
    thunderPasses = 0;
    hideThunderArrow();
    for (var i = 0; i < boltFx.length; i++) {
      if (boltFx[i].sh.parent) boltFx[i].sh.parent.removeChild(boltFx[i].sh);
    }
    boltFx.length = 0;
    var fx = PP.game.bossFx;
    if (fx.blackout > 0) {
      fx.blackout = 0;
      if (PP.cannon && PP.cannon.refreshBalls && PP.game.state === "playing") PP.cannon.refreshBalls();
    }
    blackoutWas = false;
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
    // 表示中は形が変わらないので焼き込み(攻撃1回につき1度だけ)
    safePillar.cache(x - gapW / 2 - 2, PP.CANNON_Y - 162, gapW + 4, 206);
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
    // 生成後は形が変わらない(移動と scaleY だけ)ので一度焼いて blit にする
    sh.cache(-72, -126, 146, 134);
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
    // 水壁が走っている間は絶え間ない地鳴り(小刻みなシェイク+重低音)
    wave.rumT = (wave.rumT || 0) - dt;
    if (wave.rumT <= 0) {
      wave.rumT = 0.18;
      PP.fx.shake(4, 0.12);
      PP.audio.beep(42 + Math.random() * 16, 0.16, "sawtooth", 0.07);
    }
    // しぶき(プールが混んでいる時は省く)
    if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 20) {
      PP.fx.burst(wave.x + (Math.random() - 0.5) * 100, PP.CANNON_Y - 70,
                  "rgba(190,230,246,0.8)", 3, 0.9);
    }
    // 大砲の x を通過した瞬間に判定(安全柱の中なら無事)。
    // 柱の外にいたら波に呑まれ、進行方向の「画面の端」まで一気に押し流される
    // (中央の樽・危機レーンから最も遠い位置へ追いやられるのがペナルティの本体)
    if (!wave.hitDone &&
        ((wave.dir > 0 && wave.x >= PP.cannon.x) || (wave.dir < 0 && wave.x <= PP.cannon.x))) {
      wave.hitDone = true;
      if (Math.abs(PP.cannon.x - tsuSafeX) > S.gapW / 2 - 10 && battle.orbHitCd > 0) {
        // 被弾直後の無敵中は呑まれない(以前は無敵を無視して、仰け反り中に
        // そのまま押し流される理不尽があった)。しぶきだけ浴びてやり過ごす
        PP.fx.burst(PP.cannon.x, PP.CANNON_Y - 40, "rgba(190,230,246,0.9)", 10, 1.4);
        PP.audio.beep(300, 0.15, "triangle", 0.08);
      } else if (Math.abs(PP.cannon.x - tsuSafeX) > S.gapW / 2 - 10) {
        wave.carried = true;   // 波と一緒に端まで流されていく(updateWave が運ぶ)
        PP.game.bossFx.freeze = Math.max(PP.game.bossFx.freeze, S.stun);
        // 呑まれた時点から無敵+点滅を開始(端に捨てられた後の立て直し猶予)
        battle.orbHitCd = Math.max(battle.orbHitCd, PP.BOSS.orb.hitIFrames);
        PP.cannon.setHurt(PP.BOSS.orb.hitIFrames);
        PP.fx.shake(16, 0.35);
        PP.fx.burst(PP.cannon.x, PP.CANNON_Y - 40, "#4ac8e8", 16, 1.8);
        PP.audio.beep(120, 0.3, "sawtooth", 0.14);
      } else {
        PP.fx.ring(PP.cannon.x, PP.CANNON_Y - 60, "#fff6d6", 16, 90, 400);
        PP.audio.beep(880, 0.12, "triangle", 0.08);
      }
    }
    // 呑まれた大砲は水壁の面に張り付いたまま端へ(泡を吐きながら流されていく)
    if (wave.carried) {
      PP.cannon.forceX(wave.x - wave.dir * 40);
      PP.game.bossFx.freeze = Math.max(PP.game.bossFx.freeze, 0.3);   // 流されている間は操作不能
      if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 24) {
        PP.fx.burst(PP.cannon.x, PP.CANNON_Y - 30 - Math.random() * 40, "rgba(210,236,248,0.85)", 3, 1.0);
      }
    }
    if (wave.x < -100 || wave.x > PP.W + 100) {
      if (wave.carried) {
        PP.game.bossFx.freeze = Math.max(PP.game.bossFx.freeze, S.stun);
        // 端に捨てられて動けない間に次の攻撃で狩られないよう、無敵を張り直す
        battle.orbHitCd = Math.max(battle.orbHitCd, PP.BOSS.orb.hitIFrames);
        PP.cannon.setHurt(PP.BOSS.orb.hitIFrames);
      }
      clearWave();
    }
  }

  // 運命のルーレットの進行(被弾したときだけ回り始める)。回転中はチェーンの
  // 全玉がルーレットのように目まぐるしく色を入れ替え、確定の瞬間に「補給と同じ
  // 塊生成ルール」で並び直す(chain.js scrambleColors)。理不尽な完全ランダムに
  // ならず、シャッフル後も同色の塊を狙うゲームがそのまま成立する。装填玉は不変。
  function updateRandomize(dt) {
    if (battle.rndSpinT <= 0) return;
    battle.rndSpinT -= dt;
    battle.rndStepT -= dt;
    if (battle.rndSpinT <= 0) {
      PP.chain.scrambleColors("final");
      PP.game.rouletteSpin = false;   // 確定 → 磁石を通常に戻す
      PP.fx.screenFlash("rgba(142,240,208,0.25)", 0.25, 500);
      PP.audio.beep(1175, 0.16, "triangle", 0.1);
      PP.audio.beep(1568, 0.2, "triangle", 0.08);
      return;
    }
    if (battle.rndStepT <= 0) {
      battle.rndStepT = PP.BOSS.randomize.step;
      PP.chain.scrambleColors("spin");    // 回転中: 盤面全体が色を替え続ける
      PP.audio.beep(600 + Math.random() * 600, 0.03, "square", 0.03);
    }
  }

  // 予兆のチャージ(telegraph 中だけ、本体の後ろで渦を巻く)。
  // 互い違いに回る2重の魔法陣アーク+中心へ吸い込まれる光の粒で
  // 「力を練り上げている」感を出す。収束しきる=発射の瞬間
  // チャージリングも 20Hz 再描画+cache。非表示中は clear ではなく visible で消す
  var chargeAcc = 1;
  function drawChargeThrottled(dt) {
    if (battle.state !== "telegraph" || !curAttack) {
      if (charge.visible) charge.visible = false;
      return;
    }
    charge.visible = true;
    chargeAcc += dt;
    if (chargeAcc < 1 / 20) return;
    chargeAcc = 0;
    drawCharge();
    if (charge.cacheCanvas) charge.updateCache();
    // タッチ端末は半分の解像度で焼く(356²=約 500KB → 178²=約 127KB の
    // テクスチャ再送に)。発光するアークと粒なので拡大のにじみは目立たない
    else charge.cache(-178, -178, 356, 356, PP.TOUCH ? 0.5 : 1);
  }

  function drawCharge() {
    var g = charge.graphics;
    g.clear();
    if (battle.state !== "telegraph" || !curAttack) return;
    var a = ATTACKS[curAttack];
    var k = 1 - stateT / curTeleTotal;                // 0→1 で収束
    var r = 140 - 64 * k + Math.sin(t * 18) * 6;
    charge.x = battle.body.x; charge.y = battle.body.y - 20;
    // 外周: 3分割アークが時計回りに回転
    var a0 = t * 3.2;
    for (var i = 0; i < 3; i++) {
      var s0 = a0 + i * (Math.PI * 2 / 3);
      g.setStrokeStyle(5, "round").beginStroke(a.color)
        .arc(0, 0, r, s0, s0 + 1.5).endStroke();
    }
    // 内周: 反時計回りの細アーク(交差する魔法陣)
    var b0 = -t * 4.6;
    for (var j = 0; j < 3; j++) {
      var s1 = b0 + j * (Math.PI * 2 / 3);
      g.setStrokeStyle(2, "round").beginStroke("rgba(255,255,255,0.6)")
        .arc(0, 0, r * 0.68, s1, s1 + 1.1).endStroke();
    }
    // 中心へ吸い込まれる光の粒(収束が進むほど中心に近く・明るく)
    g.beginFill(a.color);
    for (var p = 0; p < 6; p++) {
      var ang = t * 2.4 + p * 1.05;
      var pr = r * (1.15 - 0.5 * ((t * 0.9 + p * 0.37) % 1));
      g.drawCircle(Math.cos(ang) * pr, Math.sin(ang) * pr * 0.9, 2.5 + k * 2);
    }
    // 口元に灯る収束光(発射位置の予告)
    g.beginFill("rgba(255,255,255," + (0.15 + 0.45 * k).toFixed(2) + ")")
      .drawCircle(0, 58, 6 + 10 * k);
  }

  // ---------- 被弾・撃破 ----------
  // 弾がボスに当たった(cannon.js stepShots から)。ダメージが通れば true。
  // 予兆中に通ったダメージは攻撃をキャンセルする(弾幕ボスの「怯み」)
  function onHit(dmg, x, y) {
    if (!active || battle.state === "dying" || battle.state === "dead") return false;
    if (iFrames > 0) return false;
    // シールド中はダメージ無効。弾かれた火花で「今は通らない」ことを見せる
    if (guardT > 0) {
      if (guardFxCd <= 0) {
        guardFxCd = 0.12;
        PP.fx.ring(x, y, "#78c8ff", 8, 60, 300);
        PP.fx.burst(x, y, "#a0dcff", 6, 1.0);
        PP.audio.beep(1040, 0.06, "triangle", 0.07);
      }
      return false;
    }
    iFrames = PP.BOSS.iFrames;
    hp = Math.max(0, hp - dmg);
    // 3発入るたびにシールド展開(次のチャンスまで撃ち込みは通らない)
    hitStreak += 1;
    if (hp > 0 && hitStreak >= PP.BOSS.guard.hitsPerGuard) {
      hitStreak = 0;
      guardT = PP.BOSS.guard.duration;
      PP.fx.ring(battle.body.x, battle.body.y - 20, "#78c8ff", 30, 130, 500);
      PP.audio.beep(880, 0.15, "sine", 0.09);
      PP.audio.beep(1320, 0.2, "sine", 0.07);
    }
    hurtT = 0.16;
    drawHpBar();
    // ヒットの手応え(ゲームフィール): ダメージに比例したシェイク+白閃+
    // 飛び散る肉片粒子。「効いている」ことを画面全体で感じさせる
    PP.fx.burst(x, y, "#39d8b8", 12 + dmg * 4, 1.4);
    PP.fx.flash(x, y, "rgba(255,220,255,0.9)", 40 + dmg * 14);
    PP.fx.ring(x, y, "#8ef0d0", 8, 70 + dmg * 25, 320);
    PP.fx.screenFlash("rgba(255,255,255,0.07)", 0.07, 120);
    PP.fx.floatText("-" + dmg, x, y - 30, "#ff9a8a", 22);
    PP.fx.shake(8 + dmg * 4, 0.22);
    PP.audio.hit();
    PP.audio.krakenDamage();   // クラーケンのうめき(被弾の専用SE)
    PP.audio.beep(160, 0.15, "sawtooth", 0.1);
    if (battle.state === "telegraph") {
      // 攻撃の阻止! チャージ中に撃ち込めた読みへのご褒美。
      // ⚠マーカー・安全柱・バナーも一緒に片付ける(攻撃自体が消える)
      battle.state = "recover";
      stateT = PP.BOSS.recover + 0.6;   // 怯みで隙も少し伸びる
      curAttack = null;
      queuedAttack = null;
      charge.graphics.clear();
      clearWarnings();
      clearCrossTele();
      hideSafePillar();
      hideThunderArrow();   // 雷の方向矢印も攻撃ごと消える
      thunderPasses = 0;
      hideBanner();
      PP.fx.floatText(PP.i18n.t("boss.stopped"), battle.body.x, battle.body.y + 96, "#8ef0d0", 24);
      PP.audio.beep(880, 0.12, "triangle", 0.1);
      PP.audio.beep(1175, 0.18, "triangle", 0.1);
    }
    // HP半分で怒りフェーズへ(1回だけ)
    if (!battle.phase2 && hp > 0 && hp <= Math.ceil(maxHp() * PP.BOSS.phase2.hpRatio)) enterPhase2();
    if (hp <= 0) startDying();
    return true;
  }

  // 怒りフェーズ: 攻撃間隔短縮・弾速アップ・コンボ追撃。見た目も血赤に燃える
  function enterPhase2() {
    battle.phase2 = true;
    PP.fx.shake(20, 0.5);
    PP.fx.screenFlash("rgba(200,30,20,0.25)", 0.25, 700);
    showBanner(PP.i18n.t("boss.rage"), "#ff5030", 2.0);
    PP.audio.bossRoar();
    PP.audio.beep(80, 0.5, "sawtooth", 0.16);
    PP.audio.beep(60, 0.7, "sawtooth", 0.12);
    if (battle.rageRim) createjs.Tween.get(battle.rageRim, { override: true }).to({ alpha: 1 }, 600);
    // 生体発光の色替え(青緑→血赤)は update の明滅処理が phase2 を見て行う
  }

  function startDying() {
    battle.state = "dying";
    stateT = 1.6;
    clearStatusFx();               // 撃破の瞬間に全状態異常と妖弾を消す(確実な復元)
    PP.fx.shake(40, 0.8);
    PP.fx.screenFlash("rgba(255,240,200,0.5)", 0.5, 600);
    PP.fx.floatText(PP.i18n.t("boss.slain"), PP.W / 2, PP.H / 2 - 60, "#ffdf8a", 40);
    PP.audio.explode();
    PP.audio.krakenDeath();    // 断末魔
  }

  function updateDying(dt) {
    stateT -= dt;
    battle.body.y += 46 * dt;             // 海へ沈んでいく
    battle.body.alpha = Math.max(0, stateT / 1.6);
    if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 14) { // 沈みながら弾ける
      PP.fx.burst(battle.body.x + (Math.random() - 0.5) * 160,
                  battle.body.y + (Math.random() - 0.5) * 120, "#39d8b8", 8, 1.4);
    }
    if (stateT <= 0) {
      battle.state = "dead";
      cont.visible = false;
      hpCont.visible = false;
      victoryPending = true;
      PP.audio.krakenDeath2();   // 海へ沈み切る最期の音
    }
  }

  // 全状態異常・妖弾・墨・⚠・触手・津波を確実に片付ける(撃破時・リセット時)
  function clearStatusFx() {
    var fx = PP.game.bossFx;
    fx.ink = 0; fx.addle = 0; fx.freeze = 0; fx.shotSlow = 0;
    clearThunder();   // 落雷の予定・線を片付け、暗闇なら手札の色を戻す
    battle.rndSpinT = 0;
    PP.game.rouletteSpin = false;
    battle.barrageLeft = 0;
    battle.sweepLeft = 0;
    battle.curtainLeft = 0;
    battle.curtainDropT = 0;
    battle.tentWavesLeft = 0;
    tentPending.length = 0;
    queuedAttack = null;
    battle.crossActive = false;
    battle.crossT = 0;
    battle.crossEmitAcc = 0;
    battle.crossHitCd = 0;
    crossCenterK = 0;
    battle.meteorKnock = null;
    battle.orbHitCd = 0;
    battle.parryCd = 0;
    battle.parryBeepCd = 0;
    PP.cannon.clearHurt();   // ステージリセットで点滅を残留させない
    if (battle.crossSafe) battle.crossSafe.alpha = 0;
    clearCrossTele();
    removeInk();
    clearBullets();
    clearWarnings();
    clearStrikes();
    clearWave();
    hideBanner();
    if (charge) charge.graphics.clear();
    lastChipText = null;
    if (fxChips && fxChips.text !== "") { fxChips.text = ""; fxChips.updateCache(); }
  }

  // ---------- 毎フレーム(main.js の tick、playing 中のみ) ----------
  function update(dt) {
    if (!active || !built) return;
    var g = PP.game;
    var B = PP.BOSS;
    t += dt;
    // 予兆中は移動が遅くなる(撃ち込みの狙い目を作る)
    moveT += dt * (battle.state === "telegraph" ? B.telegraphSlow : 1);

    // 状態異常タイマー(bossFx)の減算は powerups.js の update に一本化した
    // (骸骨玉・パワーダウンとの共用のため。二重に減らさないこと)。
    // 発生・解除の文字通知は出さない(HUD の状態異常チップに一本化)
    if (iFrames > 0) iFrames -= dt;
    if (guardFxCd > 0) guardFxCd -= dt;
    // シールドの残りと泡の明滅(無敵中だけ見える)
    if (guardT > 0) {
      guardT = Math.max(0, guardT - dt);
      if (battle.shield) battle.shield.alpha = 0.55 + 0.25 * Math.sin(t * 10)
        * (guardT < 0.6 ? guardT / 0.6 : 1);   // 終わり際は瞬いて消える
      if (battle.shield && guardT === 0) battle.shield.alpha = 0;
    } else if (battle.shield && battle.shield.alpha !== 0) battle.shield.alpha = 0;

    updateInk(dt);
    updateBullets(dt);
    updateRandomize(dt);
    updateWarnings(dt);
    updateStrikes(dt);
    updateTentacleWaves(dt);
    updateThunder(dt);
    updateWave(dt);
    updateBarrage(dt);
    updateCross(dt);
    updateSweep(dt);
    updateCurtain(dt);
    updateChips(dt);
    if (battle.crossHitCd > 0) battle.crossHitCd -= dt;
    if (battle.orbHitCd > 0) battle.orbHitCd -= dt;
    if (battle.parryCd > 0) battle.parryCd -= dt;
    if (battle.parryBeepCd > 0) battle.parryBeepCd -= dt;
    // 時凪のカーテン: 全段出揃って dropDelay 秒後、「全弾同時」に一斉落下。
    // 凪いでいた画面全体の弾が同じ瞬間に流れ出すのが演出の芯なので、
    // 弾ごとではなくここで一括して速度を跳ね上げる
    if (battle.curtainDropT > 0) {
      battle.curtainDropT -= dt;
      if (battle.curtainDropT <= 0) {
        var dMul = B.shotSlow.dashMul, dFx = 4;
        for (var di = 0; di < battle.bullets.length; di++) {
          var db = battle.bullets[di];
          if (!db.curtain) continue;
          db.vx *= dMul;
          db.vy *= dMul;
          if (dFx > 0) { dFx--; PP.fx.flash(db.x, db.y, "rgba(255,255,255,0.8)", 34); }
        }
        PP.fx.screenFlash("#c46ffb", 0.14, 220);
        PP.fx.shake(8, 0.25);
        PP.audio.gliss(280, 1000, 0.22, "square", 0.11);   // 一斉に走り出す風切り
        PP.audio.beep(70, 0.35, "sawtooth", 0.14);
      }
    }
    // 隕石の爆風ノックバック: 大砲を放物線イージングで吹き飛ばす。
    // 飛ばされている間は操作不能(津波の carried と同じ 0.1s 刻みの freeze)
    if (battle.meteorKnock) {
      battle.meteorKnock.t += dt;
      var kk = Math.min(1, battle.meteorKnock.t / battle.meteorKnock.dur);
      var ke = 1 - (1 - kk) * (1 - kk);   // quadOut: 勢いよく飛んで減速
      PP.cannon.forceX(battle.meteorKnock.fromX + (battle.meteorKnock.toX - battle.meteorKnock.fromX) * ke);
      g.bossFx.freeze = Math.max(g.bossFx.freeze, 0.1);
      if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 30) {
        PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, Math.random() < 0.5 ? "#ffa040" : "#8a8a8a", 2, 1.2);
      }
      if (kk >= 1) battle.meteorKnock = null;
    }
    // 両舷斉射の予兆線は⚠と同じリズムで明滅させる
    for (var cti = 0; cti < crossTele.length; cti++) {
      crossTele[cti].alpha = 0.55 + 0.35 * Math.sin(t * 12);
    }
    // 安置柱は予兆中だけ明滅表示(初期安地=中央を示す)。発射後は消して、
    // 降ってくる2本の線そのものを見て隙間を追わせる(出しっぱなしは過剰)
    if (battle.crossSafe) {
      var showSafe = battle.state === "telegraph" && curAttack === "cross";
      battle.crossSafe.alpha = showSafe ? 0.55 + 0.25 * Math.sin(t * 8) : 0;
    }
    // 怒りフェーズの赤ビネット(ゆっくり脈打つ圧迫感)
    if (rageVin) rageVin.alpha = battle.phase2 ? 0.10 + 0.05 * Math.sin(t * 4) : 0;

    if (battle.state === "dead") return;
    if (battle.state === "dying") { updateDying(dt); drawTentaclesThrottled(1, dt); return; }

    // 移動: 画面上部をゆったり往復+上下の浮遊。
    // 両舷斉射のときだけは別: 予兆の間に画面中央へ滑り寄り、撃ち終わるまで
    // 中央に留まる(端から撃つと左右非対称の避けにくい交差になるため)。
    // crossCenterK を 0⇄1 で滑らかに出し入れして、動きが跳ばないようにする
    var wantX = PP.W / 2 + Math.sin(moveT * B.moveSpeed) * B.moveAmp;
    var crossHold = battle.crossActive || (battle.state === "telegraph" && curAttack === "cross");
    crossCenterK = crossHold ? Math.min(1, crossCenterK + dt * 1.6)
                             : Math.max(0, crossCenterK - dt * 1.6);
    battle.body.x = wantX + (PP.W / 2 - wantX) * crossCenterK;
    battle.body.y = B.y + Math.sin(moveT * 0.9) * 8;

    // 瞳が大砲を追う(狙われている感)+目の奥のグローと生体発光の明滅
    var look = Math.max(-6, Math.min(6, (PP.cannon.x - battle.body.x) * 0.02));
    battle.pupilL.x = -36 + look; battle.pupilR.x = 36 + look;
    var glowA = (battle.phase2 ? 0.55 : 0.35) + 0.2 * Math.sin(t * 3);
    for (var ei = 0; ei < battle.eyeGlows.length; ei++) battle.eyeGlows[ei].alpha = glowA;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    if (battle.biolumA) battle.biolumA.alpha = battle.phase2 ? 0 : 0.35 + 0.55 * pulse;
    if (battle.biolumB) battle.biolumB.alpha = battle.phase2 ? 0.45 + 0.55 * pulse : 0;
    if (battle.rageRim && battle.phase2) battle.rageRim.alpha = 0.7 + 0.3 * Math.sin(t * 5);

    // 被弾フラッシュ
    if (hurtT > 0) { hurtT -= dt; battle.hurt.alpha = Math.max(0, hurtT / 0.16) * 0.7; }
    else if (battle.hurt.alpha !== 0) battle.hurt.alpha = 0;

    drawTentaclesThrottled(0, dt);
    drawChargeThrottled(dt);

    // 攻撃のステートマシン: idle(クールダウン)→ telegraph(予兆)→ 発射 → recover。
    // 怒りフェーズでは発射後に一定確率でコンボ追撃(短い予兆の ink/freeze)を仕込む
    stateT -= dt;
    if (battle.state === "idle") {
      if (stateT <= 0) startTelegraph(pickAttack());
    } else if (battle.state === "telegraph") {
      // 墨獄の予兆: 口元から黒い滴がぽたぽた垂れる(「墨を溜めている」圧)
      if (curAttack === "ink" && Math.random() < dt * 12) {
        PP.fx.burst(battle.body.x + (Math.random() - 0.5) * 40, battle.body.y + 40,
                    "rgba(20,14,26,0.85)", 2, 0.8);
      }
      // 大触腕の第1波: 突き上げ tentWarnTime(0) 秒前に、その瞬間の自機位置で⚠を置く
      if (curAttack === "tentacle" && battle.pendingZones.length === 0 && stateT <= tentWarnTime(0)) {
        placeFirstTentacleWarnings(stateT);
      }
      if (stateT <= 0) {
        var fired = curAttack;
        fireAttack(fired);
        curAttack = null;
        charge.graphics.clear();
        battle.state = "recover";
        var P2 = B.phase2;
        // 両舷斉射(cross)はコンボの起点にしない: 振り子の掃引そのものが
        // swings×period 秒かけて画面を薙ぎ払う長い攻撃で、撃ち終わった直後も
        // まだ弾が降っている。そこへ短予兆(comboTelegraph)の追撃を重ねると、
        // 降り注ぐ線を避けながら次の予兆を読むことになり、見てから捌けない
        if (battle.phase2 && !queuedAttack &&
            fired !== "ink" && fired !== "freeze" && fired !== "cross" &&
            Math.random() < P2.comboChance) {
          queuedAttack = Math.random() < 0.5 ? "ink" : "freeze";
          stateT = P2.comboDelay;
        } else {
          stateT = B.recover;
        }
      }
    } else if (battle.state === "recover") {
      if (stateT <= 0) {
        if (queuedAttack) {
          // コンボ追撃: 予兆は短いが、阻止・回避のルールは同じ
          var qa = queuedAttack;
          queuedAttack = null;
          startTelegraph(qa, B.phase2.comboTelegraph);
        } else {
          battle.state = "idle";
          stateT = battle.phase2
            ? B.phase2.cooldownMin + Math.random() * (B.phase2.cooldownMax - B.phase2.cooldownMin)
            : B.cooldownMin + Math.random() * (B.cooldownMax - B.cooldownMin);
        }
      }
    }
  }

  // ---------- 命中判定(頭部中心の楕円) ----------
  function hitTest(x, y) {
    if (!active || !built || battle.state === "dying" || battle.state === "dead") return false;
    var dx = (x - battle.body.x) / PP.BOSS.hitRX;
    var dy = (y - (battle.body.y - 20)) / PP.BOSS.hitRY;   // 楕円の中心は頭の中央(やや上)
    return dx * dx + dy * dy <= 1;
  }

  // ---------- 開始・終了 ----------
  function reset() {
    hp = maxHp();
    lastHpDrawn = -1;
    battle.state = "idle";
    stateT = PP.BOSS.firstDelay;
    curAttack = null; battle.lastAttack = null;
    iFrames = 0; hurtT = 0; t = 0; moveT = 0;
    hitStreak = 0; guardT = 0; guardFxCd = 0;
    victoryPending = false; victoryConsumed = false;
    battle.phase2 = false; battle.attackCount = 0;
    clearStatusFx();
    if (built) {
      battle.body.alpha = 1;
      battle.body.x = PP.W / 2; battle.body.y = PP.BOSS.y;
      battle.hurt.alpha = 0;
      if (battle.rageRim) { createjs.Tween.removeTweens(battle.rageRim); battle.rageRim.alpha = 0; }
      if (rageVin) rageVin.alpha = 0;
      if (battle.shield) battle.shield.alpha = 0;
      drawHpBar();
    }
  }

  // ボス戦の開始/終了(main.js startLevel から)。開始時は状態も仕切り直し、
  // 最終決戦の開幕を宣言する(1〜5面の静かな始まりとは別物にする)
  function setActive(on) {
    active = !!on;
    if (active && !built) build();
    if (built) {
      cont.visible = active;
      hpCont.visible = active;
    }
    reset();
    if (!active) {
      removeOpeningHint();   // 非ボス面へ戻ったらヒントも片付ける
      removeParryHint();
    }
    if (active) {
      showBanner(PP.i18n.t("boss.banner"), "#ff5030", 3.2);
      PP.fx.screenFlash("rgba(160,20,16,0.3)", 0.3, 900);
      PP.fx.shake(12, 0.5);
      PP.fx.floatText(PP.i18n.t("boss.intro"), PP.W / 2, PP.H / 2 + 10, "#e6d3b8", 22);
      PP.audio.beep(55, 0.8, "sawtooth", 0.14);
      PP.audio.beep(82, 0.6, "sawtooth", 0.1);
      PP.audio.beep(110, 0.5, "sine", 0.08);
      showOpeningHint();
      // パリィ持ちにだけ: 大技には効かないことを開幕で一度告知する
      // (「ガードできるはず」と大技へ突っ込む理不尽を消す)
      if (PP.upgrades && PP.upgrades.level("parry") > 0) showParryHint();
    }
  }

  // 開幕の戦い方ヒント。決戦前のオーバーレイでも教えているが、
  // URL 直接起動(?level=6)やリトライ直後はあれを見ないので、
  // 戦闘画面でも最初の攻撃が来る前に一度だけ目に入るようにする。
  // 最初の攻撃猶予(firstDelay 3秒)+数回の攻撃を見る間だけ出して消える
  var hintTxt = null;
  function removeOpeningHint() {
    if (!hintTxt) return;
    createjs.Tween.removeTweens(hintTxt);
    if (hintTxt.parent) hintTxt.parent.removeChild(hintTxt);
    hintTxt = null;
  }
  function showOpeningHint() {
    removeOpeningHint();                  // リトライ時: 前のヒントを片付けてから
    hintTxt = new createjs.Text(PP.i18n.t("boss.hint"),
      'bold 15px "Meiryo", sans-serif', "#f5e8c8");
    hintTxt.textAlign = "center";
    hintTxt.x = PP.W / 2;
    hintTxt.y = 168;                      // HP バーの下・最上段レーンより上
    hintTxt.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    cacheTextFit(hintTxt, 15);
    PP.layers.hud.addChild(hintTxt);
    createjs.Tween.get(hintTxt)
      .wait(12000)
      .to({ alpha: 0 }, 900)
      .call(function () {
        if (hintTxt && hintTxt.parent) hintTxt.parent.removeChild(hintTxt);
        hintTxt = null;
      });
  }

  // 【強化】パリィ持ち向けの開幕告知(開幕ヒントのすぐ下・同じ寿命)。
  // 大技(触手・津波・両舷斉射)にはパリィが効かないことを戦闘前に知らせる
  var parryHintTxt = null;
  function removeParryHint() {
    if (!parryHintTxt) return;
    createjs.Tween.removeTweens(parryHintTxt);
    if (parryHintTxt.parent) parryHintTxt.parent.removeChild(parryHintTxt);
    parryHintTxt = null;
  }
  function showParryHint() {
    removeParryHint();
    parryHintTxt = new createjs.Text(PP.i18n.t("boss.parryHint"),
      'bold 15px "Meiryo", sans-serif', "#9fd8ff");
    parryHintTxt.textAlign = "center";
    parryHintTxt.x = PP.W / 2;
    parryHintTxt.y = 190;
    parryHintTxt.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    cacheTextFit(parryHintTxt, 15);
    PP.layers.hud.addChild(parryHintTxt);
    createjs.Tween.get(parryHintTxt)
      .wait(12000)
      .to({ alpha: 0 }, 900)
      .call(removeParryHint);
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
    getState: function () { return battle.state; },
    getBulletCount: function () { return battle.bullets.length; },
    // 全弾の座標を渡す(night.js が妖弾の光を闇に開けるのに使う。配列は外に出さない)
    eachBullet: function (cb) { for (var i = 0; i < battle.bullets.length; i++) cb(battle.bullets[i].x, battle.bullets[i].y); },
    // 頭の中心座標を渡す(night.js がボスに当たる月明かりの穴を開けるのに使う。
    // hitTest と同じ「頭の中央やや上」。倒れた後は光を当てない)
    eachLight: function (cb) { if (active && built && battle.state !== "dead") cb(battle.body.x, battle.body.y - 20); },
    // ⚠のX座標一覧と触手柱の本数(触手の配置ルールの検証用)
    getWarningXs: function () { return warnings.map(function (w) { return w.x; }); },
    getStrikeCount: function () { return strikes.length; },
    getInkBlobCount: function () { return battle.inkBlobs.length; },
    // 裁きの雷霆の残り落雷数(未予告+落下待ち)
    getThunderCount: function () { return thunderXs.length + thunderBolts.length; },
    // 指定した技を即座に予兆から始める(バランス調整・動作確認用)
    forceAttack: function (key) {
      if (!active || !built || !ATTACKS[key]) return false;
      if (battle.state !== "idle" && battle.state !== "recover") return false;
      startTelegraph(key);
      return true;
    }
  };
})();
