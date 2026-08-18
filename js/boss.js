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
 *   ink      漆黒の墨獄       … 弧を描いて降り注ぐ墨玉のカーテン。着弾点に墨だまり
 *   addle    惑乱の逆潮       … 大珠が盤面中央でホバリングし、二段のリングを展開。
 *                               被弾で操作反転(input.js: マウスの動きを反転する相対移動)
 *   freeze   深淵の錨鎖       … ボスを中心に広がる同心二重のリング。
 *                               被弾で大砲の移動・発射不能(cannon.js)
 *   shotSlow 時凪の呪縛       … 遅い大弾の二重カーテン(隙間が互い違い)。
 *                               被弾で発射玉が極端に遅くなる(stepShots)
 *   randomize 運命のルーレット … 左右から交差する回転スイープ弾。被弾でチェーンが
 *                               ルーレット回転 → 補給と同じ塊生成ルールで色が並び直る
 *   tentacle 海淵の大触腕     … 大砲の高さに⚠予告 → 画面下から触手が突き上げ、
 *                               範囲内ならランダムなデバフ。突き上げ後も居座る触手に
 *                               自弾を当てれば「斬り返し」でボスへダメージを返せる
 *   tsunami  終焉の大海嘯     … 光の安全柱以外の低空を水壁が横断。柱の外だと
 *                               画面の端まで一気に押し流される(樽防衛から引き剥がされる)
 *   barrage  妖星の豪雨       … 下向きの扇弾幕を複数ボレー。隙間を縫うか撃ち落とす
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
  var hitStreak = 0;      // シールドが張られるまでの被弾カウント(3発で発動)
  var guardT = 0;         // シールド(無敵)の残り秒
  var guardFxCd = 0;      // シールドに弾かれた演出の連打防止
  var shield = null;      // シールドの泡(body に重ねる。無敵中だけ光る)
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
  var barrageLeft = 0, barrageT = 0;     // 流星雨の残りボレー数と次弾までの秒
  // 触手の追撃波(第1波の後に「間→⚠→突き上げ」を繰り返す波状攻撃)
  var tentWavesLeft = 0;   // 残り追撃波数
  var tentWaveIdx = 0;     // いま何波目か(0=第1波。打撃ビープの音程に使う)
  var tentTimer = 0;       // gap/warn の残り秒
  var tentPhase = "";      // "gap"(間) | "warn"(⚠表示中)
  var tentPending = [];    // 追撃波の突き上げ予定X座標
  var sweepLeft = 0, sweepT = 0, sweepTotal = 0;   // 運命のルーレットの回転スイープ
  var curtainLeft = 0, curtainT = 0, curtainTotal = 0;   // 時凪のカーテンの残り枚数
  var curtainDropT = 0;   // 全段出揃ってから一斉落下までの残り秒(0以下=待機なし)
  // 両舷斉射(cross): 左右両舷からの超高密度ドット線の振り子掃引
  var crossActive = false;  // 掃引中か
  var crossT = 0;           // 掃引の経過秒
  var crossEmitAcc = 0;     // 発射レートの端数繰り越し
  var crossHitCd = 0;       // 被弾直後のクールダウン(密度線での多段スタン防止)
  var crossCenterK = 0;     // 0→1: 両舷斉射のためにボスが中央へ寄っている度合い
  var meteorKnock = null;   // 隕石の爆風ノックバック {t, dur, fromX, toX}
  var orbHitCd = 0;         // プレイヤー被弾後の無敵秒(全妖弾共通。多段ヒット防止)
  var parryBeepCd = 0;      // 無敵中の「弾いた」音の間引き(cross は毎秒30発来るため)
  var crossTele = [];       // 予兆の交差線(telegraph 中だけ表示)
  var crossSafe = null;     // 掃引点に追従する光の柱(2本の線の間=安全地帯の標示)
  var rageVin = null;       // 怒りフェーズの全画面赤ビネット(alpha だけ動かす)

  // ランダマイズ(色ルーレット)は攻撃状態と独立に回す
  var rndSpinT = 0, rndStepT = 0, rndOrig = 0;

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
    cross:     { nameKey: "boss.atk.cross",     color: "#9fd8ff" }
  };
  var ATTACK_KEYS = ["ink", "addle", "freeze", "shotSlow", "randomize",
                     "tentacle", "tsunami", "barrage", "cross"];

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

    // シールドの泡(3発被弾ごとの無敵中だけ光る。普段は透明)
    shield = new createjs.Shape();
    shield.graphics
      .beginRadialGradientFill(["rgba(120,200,255,0)", "rgba(120,200,255,0.10)", "rgba(160,220,255,0.30)"],
        [0, 0.8, 1], 0, -20, 20, 0, -20, 108)
      .drawEllipse(-108, -128, 216, 216)
      .setStrokeStyle(2.5).beginStroke("rgba(180,230,255,0.8)")
      .drawEllipse(-108, -128, 216, 216);
    shield.compositeOperation = "lighter";
    shield.alpha = 0;
    body.addChild(shield);

    // 被弾の白フラッシュ(普段は透明)
    hurt = new createjs.Shape();
    hurt.graphics.beginFill("#ffffff")
      .moveTo(-78, 26).curveTo(-96, -40, -52, -88).curveTo(0, -122, 52, -88)
      .curveTo(96, -40, 78, 26).curveTo(40, 46, 0, 46).curveTo(-40, 46, -78, 26).closePath();
    hurt.alpha = 0;
    body.addChild(hurt);

    return body;
  }

  // 触手の再描画は 30Hz に間引き、結果は cache して blit する。
  // 太い round ストローク×8本の再ラスタライズは canvas で最も高い部類の
  // コストで、揺れは sin(t*2) 程度なので 20Hz サンプルでも見分けが付かない。
  // 境界は式の最悪値(ex±sway, ey=34+148+46)+ストローク半幅から算出
  var tentAcc = 1;   // 初回は必ず描く
  function drawTentaclesThrottled(droop, dt) {
    tentAcc += dt;
    if (tentAcc < 1 / 20) return;
    tentAcc = 0;
    drawTentacles(droop);
    if (tentShape.cacheCanvas) tentShape.updateCache();
    else tentShape.cache(-195, 8, 390, 245);
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

    // 両舷斉射の安置柱: 掃引点(2本の線の間の安全地帯)を照らす光の柱。
    // 津波の安全柱と同じ「光=安全」の文法。一度だけ焼いて x を動かすだけ
    crossSafe = new createjs.Shape();
    // 幅は実際の安全地帯(2×aimCrossGap)から線の太さぶんを引いた値に合わせる
    var csW = PP.BOSS.cross.aimCrossGap * 2 - 40, csTop = PP.CANNON_Y - 170, csH = 220;
    crossSafe.graphics.beginLinearGradientFill(
        ["rgba(214,255,246,0)", "rgba(214,255,246,0.30)", "rgba(214,255,246,0.30)", "rgba(214,255,246,0)"],
        [0, 0.3, 0.7, 1], -csW / 2, 0, csW / 2, 0)
      .drawRect(-csW / 2, csTop, csW, csH);
    crossSafe.graphics.setStrokeStyle(2).beginStroke("rgba(180,255,235,0.7)")
      .moveTo(-csW / 2, csTop).lineTo(-csW / 2, csTop + csH)
      .moveTo(csW / 2, csTop).lineTo(csW / 2, csTop + csH);
    crossSafe.cache(-csW / 2 - 3, csTop - 3, csW + 6, csH + 6);
    crossSafe.alpha = 0;
    cont.addChild(crossSafe);

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
    bband.cache(0, -26, PP.W, 52);   // 画面幅のグラデ帯は一度だけ焼く
    bannerText = new createjs.Text("", '700 30px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffffff");
    bannerText.textAlign = "center"; bannerText.textBaseline = "middle";
    bannerText.x = PP.W / 2;
    bannerText.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
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
    hpBarSh = new createjs.Shape();
    fxChips = new createjs.Text("", '600 14px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#ffd8a8");
    fxChips.textAlign = "left"; fxChips.textBaseline = "middle";
    fxChips.x = 880; fxChips.y = 80;
    fxChips.shadow = new createjs.Shadow("rgba(0,0,0,0.8)", 0, 2, 4);
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
    if (rndSpinT > 0) parts.push("🎲");
    if (guardT > 0) parts.push("🛡" + Math.ceil(guardT));   // ボスのシールド残り秒
    var s = parts.join(" ");
    if (s !== lastChipText) { lastChipText = s; fxChips.text = s; }
  }

  // ---------- 妖弾(ボスの弾幕) ----------
  // type: "ink"(山なりの墨玉) / "addle" / "freeze" / "shotSlow" / "randomize"(直進オーブ)
  // グラデーション円をそのまま Shape で持つと弾ごとに毎フレーム再ラスタライズ
  // されて重い(弾幕中は100発近く生きる)ので、type ごとに一度だけ 1.25 倍解像度で
  // canvas に焼き、共有 Bitmap を返す(ball.js の焼き込みと同じ発想)。
  // 呼び出し側のパルス(最大1.12倍)でも native 解像度を超えない
  var orbCanvas = {};
  function makeOrbView(type) {
    var c = orbCanvas[type];
    if (!c) {
      var sh = new createjs.Shape();
      var pad;
      if (type === "ink") {
        sh.graphics
          .beginRadialGradientFill(["#3a2a48", "#16101e", "rgba(10,8,14,0.4)"], [0, 0.7, 1],
            -4, -4, 2, 0, 0, 20)
          .drawCircle(0, 0, 18)
          .beginFill("rgba(210,160,235,0.25)").drawCircle(-6, -7, 5);
        pad = 24;
      } else {
        var col = ATTACKS[type].color;
        var r = (type === "shotSlow") ? PP.BOSS.shotSlow.r : PP.BOSS.orb.r;
        sh.graphics
          .beginRadialGradientFill(["#ffffff", col, "rgba(0,0,0,0)"], [0, 0.45, 1],
            0, 0, 0, 0, 0, r * 1.7)
          .drawCircle(0, 0, r * 1.7)
          .setStrokeStyle(2).beginStroke(col).drawCircle(0, 0, r);
        pad = r * 1.7 + 3;
      }
      var S = 1.25;
      sh.cache(-pad, -pad, pad * 2, pad * 2, S);
      c = orbCanvas[type] = { img: sh.cacheCanvas, reg: pad * S, base: 1 / S };
    }
    var bmp = new createjs.Bitmap(c.img);
    bmp.regX = bmp.regY = c.reg;
    bmp.scaleX = bmp.scaleY = c.base;
    bmp.baseScale = c.base;
    return bmp;
  }

  // opts(省略可)で弾に「軌道の芸」を持たせる:
  //   wave:  { amp, freq, ph } … 左右に蛇行しながら進む(snake 弾)
  //   spin:  rad/s … 速度ベクトルを毎フレーム回す=弧を描いて曲がる(渦巻き弾)
  //   hover: { y, time, rings: [{ count, speed, spin }, …] }
  //          … 指定の高さまで降りたら停止してホバリングし、time 秒後に
  //            全方位リングを段階的に展開(rings を順に 0.45 秒間隔で放つ)、
  //            最後のリングと同時に自分は弾ける(ホバリング爆裂弾)
  //   hover.burst: { mids, midR, midHp, midVr, midSpin, splitBase, splitStep,
  //                  smalls, smallSpeed, smallR }
  //          … rings の代わりに「二段分裂」: 中玉がらせん状に拡散し、
  //            各中玉が時間差で小弾リングへさらに割れる
  //   split: { t, count, speed, r, idx } … t 秒後に小弾リングへ割れる時限分裂
  //   viewScale: 見た目の倍率(判定半径と見た目を揃える)
  function spawnBullet(type, x, y, vx, vy, grav, r, opts) {
    var view = makeOrbView(type);
    view.x = x; view.y = y;
    bulletCont.addChild(view);
    var hitR = r + PP.R * 0.9;   // 自弾との迎撃半径(毎フレーム再計算しない)
    var b = { type: type, x: x, y: y, vx: vx, vy: vy, grav: grav || 0,
              r: r, hitR2: hitR * hitR, view: view, t: Math.random() * 6.28 };
    if (opts) {
      if (opts.wave) b.wave = { amp: opts.wave.amp, freq: opts.wave.freq, ph: opts.wave.ph || 0 };
      if (opts.spin) {
        // 回転弾は極座標で動かす: 発射点を中心に、半径は radial 速度で単調増加、
        // 角度は spin で回る。「回転しながら必ず外へ広がる」ことを保証する
        // (速度ベクトルを回す方式だと一周して内側へ戻ってきてしまう)
        b.orbit = { cx: x, cy: y, r: 0, ang: Math.atan2(vy, vx),
                    vr: Math.sqrt(vx * vx + vy * vy), w: opts.spin };
      }
      if (opts.hover) b.hover = { y: opts.hover.y, t: opts.hover.time,
                                  rings: opts.hover.rings ? opts.hover.rings.slice() : null,
                                  burst: opts.hover.burst || null, done: false };
      if (opts.hp) b.hitsLeft = opts.hp;   // 迎撃に複数発が必要な大玉(耐久値)
      if (opts.meteor) b.meteor = true;    // 隕石: 炎トレイル+地面着弾で爆発
      if (opts.curtain) b.curtain = true;  // 時凪のカーテン弾(一斉落下の対象)
      // 急加速(ダッシュ弾): y がしきい値を越えた瞬間、速度が mul 倍に跳ね上がる
      if (opts.dash) b.dash = { y: opts.dash.y, mul: opts.dash.mul, done: false };
      // 時限分裂(多段分裂の中玉): t 秒後に count 発の同心円リングへ割れる。
      // hp=子の耐久 / spin=子のらせん回転(中玉の証) / child=子がさらに
      // 割れるときの分裂スペック(入れ子)。
      // t はここでコピーするので、config の共有オブジェクトを直接渡してよい
      if (opts.split) b.split = { t: opts.split.t, count: opts.split.count,
                                  speed: opts.split.speed, r: opts.split.r,
                                  hp: opts.split.hp || 0,
                                  spin: opts.split.spin || 0,
                                  idx: opts.split.idx || 0,
                                  child: opts.split.child || null };
      // 見た目の拡縮(焼き込みスプライトはタイプごと固定サイズなので、
      // 中玉>通常>小弾 の大きさの違いはここで付ける)
      if (opts.viewScale) {
        view.baseScale *= opts.viewScale;
        view.scaleX = view.scaleY = view.baseScale;
      }
    }
    bullets.push(b);
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
    // トレイル粒子の予算: 弾数に比例して粒子が増えると FPS が崩壊するので、
    // 全弾合計で 1 フレーム 8 個まで(60fps で約480個/秒=従来の見え方と同等)。
    // さらにプールが混んでいる時は発生自体を止める
    // 墨で画面が覆われている間はトレイルがほぼ見えないので予算を絞る
    var trailBudget = (PP.fx.particleLoad() < 0.75) ? (inkBlobs.length > 0 ? 5 : 8) : 0;
    // 一斉分裂(split)のフレーム内演出予算: 音は1回、リング演出は3個まで
    var splitFxBudget = 3, splitBeeped = false;
    for (var i = bullets.length - 1; i >= 0; i--) {
      var b = bullets[i];
      // ホバリング爆裂弾: 指定の高さで静止 → 溜め → 全方位リングを段階展開。
      // リングごとに半歩ずらして放つので、二段目は一段目の隙間を通ってくる
      if (b.hover && !b.hover.done && b.y >= b.hover.y) {
        b.vx = 0; b.vy = 0;
        b.hover.t -= dt;
        if (trailBudget > 0 && Math.random() < dt * 30) {
          trailBudget--;
          PP.fx.burst(b.x + (Math.random() - 0.5) * 30, b.y + (Math.random() - 0.5) * 30,
                      ATTACKS[b.type].color, 1, 0.6);
        }
        if (b.hover.t <= 0 && b.hover.burst) {
          // 多段分裂の一段目: 大玉が中央から割れ、中玉のリングが直線で放射状に
          // 広がる(midSpin>0 ならせん回転にもできる)。各中玉は
          // burst.split のスペックどおりに一斉に割れる(怒り時は孫の中玉を挟む三段)
          var BB = b.hover.burst;
          var baseAng = Math.random() * Math.PI * 2;
          for (var mi = 0; mi < BB.mids; mi++) {
            var mang = baseAng + (Math.PI * 2 / BB.mids) * mi;
            spawnBullet(b.type, b.x, b.y,
              Math.cos(mang) * BB.midVr, Math.sin(mang) * BB.midVr, 0, BB.midR,
              { spin: BB.midSpin,
                hp: BB.midHp,
                viewScale: BB.midR / PP.BOSS.orb.r,
                split: BB.splitStep
                  ? { t: BB.split.t + mi * BB.splitStep, count: BB.split.count,
                      speed: BB.split.speed, r: BB.split.r, hp: BB.split.hp,
                      spin: BB.split.spin, idx: mi, child: BB.split.child }
                  : BB.split });
          }
          PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 14, 120, 460);
          PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 16, 1.8);
          PP.fx.screenFlash(ATTACKS[b.type].color, 0.12, 220);   // 炸裂の閃光
          PP.fx.shake(9, 0.3);                                    // 盤面中央の爆発は体で感じる
          PP.audio.gliss(700, 180, 0.3, "square", 0.12);   // パキッと割れる音
          PP.audio.beep(60, 0.4, "sawtooth", 0.16);        // 腹に来る炸裂の低音
          PP.audio.bossAddle();
          b.hover.done = true;
          removeBullet(i);
          continue;
        }
        if (b.hover.t <= 0) {
          var bc = b.hover.rings.shift();
          var half = (b.hover.rings.length % 2) * (Math.PI / bc.count);   // 段ごとに半歩ずらす
          for (var bk = 0; bk < bc.count; bk++) {
            var bang = (Math.PI * 2 / bc.count) * bk + half;
            spawnBullet(b.type, b.x, b.y,
              Math.cos(bang) * bc.speed, Math.sin(bang) * bc.speed, 0, PP.BOSS.orb.r * 0.72,
              bc.spin ? { spin: bc.spin } : null);
          }
          PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 12, 110, 450);
          PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 14, 1.6);
          PP.audio.beep(340, 0.12, "square", 0.1);
          // 同心円リング展開の専用SE(約3秒)。0.45秒間隔の多段リングで
          // 重なりすぎないよう、最初の展開の1回だけ鳴らす
          if (!b.hover.seDone) { b.hover.seDone = true; PP.audio.bossAddle(); }
          if (b.hover.rings.length > 0) {
            b.hover.t = 0.45;          // 次のリングまでの溜め
          } else {
            b.hover.done = true;
            removeBullet(i);
            continue;
          }
        }
      }
      b.lastY = b.y;   // 移動前の高さ(cross の「線を横切った瞬間」判定に使う)
      // 渦巻き弾: 極座標スパイラル。半径は増える一方なので必ず外へ広がる
      if (b.orbit) {
        b.orbit.r += b.orbit.vr * dt;
        b.orbit.ang += b.orbit.w * dt;
        b.x = b.orbit.cx + Math.cos(b.orbit.ang) * b.orbit.r;
        b.y = b.orbit.cy + Math.sin(b.orbit.ang) * b.orbit.r;
      } else {
        b.vy += b.grav * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        // 蛇行弾: 進行に左右の揺れを重ねる(網のような弾幕を作る)
        if (b.wave) b.x += Math.sin(b.t * b.wave.freq + b.wave.ph) * b.wave.amp * dt;
      }
      // 多段分裂の後段: 中玉が時限で同心円リングへ割れる。子が hp/child を
      // 持てば、その子も撃ち落とせる中玉で、さらにもう一段割れる(怒りの三段)。
      // リングの位相は進行方向を引き継ぐ=中玉ごとに隙間の向きが変わって見える。
      // 全中玉が同一フレームで一斉に割れるので、音は1回・リング演出は数個に
      // 絞る(10個ぶん重ねると音割れ+粒子まみれになる)
      if (b.split) {
        b.split.t -= dt;
        if (b.split.t <= 0) {
          var ph0 = b.orbit ? b.orbit.ang : Math.atan2(b.vy, b.vx);
          for (var sk = 0; sk < b.split.count; sk++) {
            var sang = ph0 + (Math.PI * 2 / b.split.count) * sk;
            spawnBullet(b.type, b.x, b.y,
              Math.cos(sang) * b.split.speed, Math.sin(sang) * b.split.speed, 0, b.split.r,
              { viewScale: b.split.r / PP.BOSS.orb.r,
                hp: b.split.hp || undefined,
                spin: b.split.spin || undefined,   // 中玉の子は回転、小弾は直線
                split: b.split.child || undefined });
          }
          if (splitFxBudget > 0) {
            splitFxBudget--;
            PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 8, 70, 380);
            PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 8, 1.2);
          }
          if (!splitBeeped) {
            splitBeeped = true;
            // 時間差ポップ: 順番に音程が上がる(idx)。同一フレームで複数割れても1回だけ
            PP.audio.beep(380 + b.split.idx * 25, 0.12, "square", 0.1);
            PP.audio.beep(190 + b.split.idx * 12, 0.18, "sawtooth", 0.07);  // 下支えの低音
          }
          removeBullet(i);
          continue;
        }
      }
      // 急加速(ダッシュ弾): しきい値を越えた瞬間に1回だけ速度を跳ね上げる。
      // 白閃+風切り音で「今、加速した」ことをはっきり見せる(同フレームで
      // カーテン1段ぶんが一斉に加速するので、音は1回・閃光は数発に絞る)
      if (b.dash && !b.dash.done && b.y >= b.dash.y) {
        b.dash.done = true;
        b.vx *= b.dash.mul;
        b.vy *= b.dash.mul;
        if (splitFxBudget > 0) {
          splitFxBudget--;
          PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 30);
        }
        if (!splitBeeped) {
          splitBeeped = true;
          PP.audio.gliss(300, 900, 0.18, "square", 0.09);   // ヒュンッという風切り
        }
      }
      b.t += dt;
      b.view.x = b.x; b.view.y = b.y;
      var pulse = 1 + 0.12 * Math.sin(b.t * 10);
      b.view.scaleX = b.view.scaleY = pulse * b.view.baseScale;
      // 尾を引く残光(妖弾の軌道が線で読める=避けやすく、画面も華やぐ)。
      // 隕石は炎の尾を濃く引く(橙と黄をちらつかせる)
      if (b.meteor) {
        if (trailBudget > 0 && Math.random() < dt * 40) {
          trailBudget--;
          PP.fx.burst(b.x - b.vx * 0.02, b.y - b.vy * 0.02,
                      Math.random() < 0.5 ? "#ffa040" : "#ffd24a", 2, 1.1);
        }
      } else if (trailBudget > 0 && Math.random() < dt * 26) {
        trailBudget--;
        PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 1, 0.5);
      }

      // 迎撃: 自分の弾(通常弾・爆弾)をぶつけると相殺して消せる。
      // ミサイルは貫通なので消費せずに薙ぎ払える。
      // 耐久値(hitsLeft)を持つ大玉は削り切るまで消えない(残り数を表示)
      var blocked = false;
      if (b.hitCd > 0) b.hitCd -= dt;
      // 弾幕中は弾×ショットの総当たりになるので、縦距離だけで先に棄却する
      // (cannon.js stepShots の SKIP_R2 と同じパターン。ほとんどのペアは
      //  dy チェックだけで抜け、平方距離の計算までたどり着かない)
      for (var s = g.shots.length - 1; s >= 0; s--) {
        var sh = g.shots[s];
        var dy = sh.y - b.y;
        if (dy * dy >= b.hitR2) continue;
        var dx = sh.x - b.x;
        if (dx * dx + dy * dy < b.hitR2) {
          if (b.hitsLeft > 1) {
            // まだ耐える: 1発ぶん削って怯ませる(ミサイルは多段ヒット防止の間を置く)
            if (!(b.hitCd > 0)) {
              b.hitCd = 0.12;
              b.hitsLeft--;
              PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 6, 0.9);
              PP.fx.floatText(PP.i18n.t("boss.hitsLeft", { n: b.hitsLeft }), b.x, b.y - 30, "#a0dcff", 16);
              PP.audio.beep(500, 0.06, "square", 0.07);
            }
            if (sh.special !== "missile") {   // 通常弾は1発と交換
              if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
              PP.layers.shot.removeChild(sh.view);
              g.shots.splice(s, 1);
            }
            continue;                          // 大玉は消えない
          }
          PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 10, 1.2);
          PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 34);
          PP.fx.floatText(PP.i18n.t("fx.intercept"), b.x, b.y - 26, "#8ef0d0", 18);
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

      // 大砲への命中(powerups のキャッチ箱と同じ寸法感)。
      // cross 弾は被弾直後(crossHitCd)の間だけ当たらない: 密度線なので
      // スタン中に毎フレーム多段ヒットして抜けられなくなるのを防ぐ。
      // また cross の小ドットは「見た目どおりの細さ」で判定する: 通常オーブ用の
      // 広いキャッチ箱(±50)だと、見た目は避けているのに当たる=2本の線の
      // 間の空間が実際より 60px 以上狭くなってしまう
      // orbHitCd(被弾後の無敵)の間は素通りさせず、バリアで「弾いて」消す
      // (激しい弾幕での連続被弾=ハメを防ぎつつ、無敵が目に見える。
      //  骸骨玉の hitIFrames と同じ思想)。
      // cross の判定は縦60pxの箱ではなく「大砲の高さの線を横切った瞬間」の
      // 1回だけ: 箱判定だと、掃引が左右端で線が斜めになったとき箱の縦幅の
      // 中で線が横に~90px も動き、線が実際より太く判定されて通路が狭くなる
      // (=中央で広く端で狭い、が起きる)。線交差なら通路幅は常に 2×gap で一定
      var hitNow;
      if (b.type === "cross") {
        var crossLine = cy - 20;
        hitNow = b.lastY < crossLine && b.y >= crossLine &&
                 Math.abs(b.x - cx) <= b.r + 16;
      } else {
        hitNow = Math.abs(b.x - cx) <= O.catchW &&
                 b.y >= cy - O.catchTop && b.y <= cy + O.catchBottom;
      }
      if (hitNow) {
        var invuln = orbHitCd > 0 || (b.type === "cross" && crossHitCd > 0);
        if (!invuln) {
          applyOrbHit(b);
        } else {
          // 無敵中: 弾はバリアに弾かれて消える(小さな火花+軽い音)。
          // cross は密度線なので音だけ parryBeepCd で間引く(火花は残す)
          PP.fx.burst(b.x, b.y, "#9fd8ff", 4, 0.9);
          if (parryBeepCd <= 0) {
            PP.audio.beep(980, 0.05, "triangle", 0.05);
            parryBeepCd = 0.12;
          }
        }
        removeBullet(i);
        continue;
      }

      // 墨玉は大砲の高さまで落ちたら着弾(外れても足元に墨だまりが残る)
      if (b.type === "ink" && b.y >= cy - 30) {
        splatInk(b.x, Math.min(b.y, cy - 30), false);
        removeBullet(i);
        continue;
      }
      // 隕石は地面(大砲の高さ)で爆発する(大砲キャッチ判定が先に走るので
      // 直撃はちゃんと被弾になる)。隕石なので着弾は地面をガッツリ揺らす
      if (b.meteor && b.y >= cy - 20) {
        PP.fx.ring(b.x, cy - 20, "#ffa040", 20, 150, 460);
        PP.fx.ring(b.x, cy - 20, "#ff5030", 8, 90, 380);
        PP.fx.burst(b.x, cy - 20, "#ffd24a", 16, 2.2);
        PP.fx.shake(PP.BOSS.barrage.impactShake, 0.28);
        PP.audio.meteorBoom();
        removeBullet(i);
        continue;
      }
      // 画面外(ホバリング爆裂の上向き小弾があるので上方向too)
      if (b.y > PP.H + 40 || b.y < -60 || b.x < -60 || b.x > PP.W + 60) removeBullet(i);
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
    PP.audio.debuff();   // 状態異常がかかった合図(妖弾直撃・触手の双方から来る)
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
    // 被弾の共通リアクション: 仰け反りスタン+無敵時間+赤い被弾フラッシュ。
    // 攻撃が激しいぶん、「当たった」ことを体で分からせ、多段ヒットからは守る
    orbHitCd = B.orb.hitIFrames;
    PP.cannon.setHurt(B.orb.hitIFrames);   // 無敵の残り時間だけ大砲が点滅する
    g.bossFx.freeze = Math.max(g.bossFx.freeze, B.orb.hitStagger);
    PP.fx.screenFlash("rgba(200,20,20,0.22)", 0.22, 300);
    PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, "#ff5030", 10, 1.5);
    PP.fx.shake(10, 0.3);
    PP.audio.beep(150, 0.25, "sawtooth", 0.12);
    if (b.type === "ink") {
      splatInk(b.x, b.y, true);     // 直撃は大きな目つぶし
      g.bossFx.ink = B.ink.dur;
      PP.audio.debuff();            // ink は applyDebuff を通らないのでここで鳴らす
    } else if (b.type === "addle" || b.type === "freeze" || b.type === "shotSlow") {
      applyDebuff(b.type, 1);
    } else if (b.type === "barrage") {
      // 隕石の直撃は「爆風ノックバック+色ルーレット」の二重妨害:
      // 着弾点から遠ざかる向きへ大砲ごと吹き飛ばされ(位置が崩れる)、
      // さらにチェーン全体の色がシャッフルされる(狙いの計画も崩れる)。
      // スタン系の妨害が多すぎたので、時間を奪うのではなく体勢を奪う
      var KN = B.barrage.knock;
      var kdir = (PP.cannon.x >= b.x) ? 1 : -1;
      var toX = Math.max(PP.CANNON_MARGIN + 20,
                Math.min(PP.W - PP.CANNON_MARGIN - 20, PP.cannon.x + kdir * KN.dist));
      meteorKnock = { t: 0, dur: KN.time, fromX: PP.cannon.x, toX: toX };
      // 色ルーレット(randomize と同じ仕組み): 吹き飛ばされて戻ってきたら盤面の色が違う
      rndSpinT = B.randomize.spin;
      rndStepT = 0;
      rndOrig = g.currentColor;
      g.rouletteSpin = true;
      PP.audio.debuff();
      PP.audio.beep(60, 0.4, "sawtooth", 0.18);
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffa040", 16, 130, 480);
      PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, "#ffd24a", 14, 2.0);
      PP.fx.shake(14, 0.3);
    } else if (b.type === "cross") {
      // 両舷斉射の被弾もスタン。hitCd の間は cross 弾に当たらない(スタンロック防止)。
      // シールドはスタン(5秒)より長く張る必要があるため、点滅(見た目)も
      // 共通の hitIFrames(2秒)ではなく hitCd に合わせて延長する
      g.bossFx.freeze = Math.max(g.bossFx.freeze, B.cross.stun);
      crossHitCd = B.cross.hitCd;
      PP.cannon.setHurt(B.cross.hitCd);
      PP.audio.debuff();
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#9fd8ff", 12, 100, 500);
    } else if (b.type === "randomize") {
      rndSpinT = B.randomize.spin;
      rndStepT = 0;
      rndOrig = g.currentColor;
      g.rouletteSpin = true;   // 回転中は磁石を止める(chain.js applyMagnet)
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 10, 70, 400);
    }
  }

  // ---------- 墨だまり(タコスミの着弾跡) ----------
  // direct=true(大砲に直撃)は大量の濃い墨が画面のほぼ全域を覆う本気の目つぶし。
  // 外れた墨玉も着弾点に墨だまりを残す(避けても足元の視界は少し悪くなる)
  // 巨大な放射グラデを毎フレーム再ラスタライズすると重いので、
  // 単位サイズ(半径256)で一度だけ焼いた canvas を全ブロブで共有し、
  // scale=r/256 の Bitmap として置く(放射グラデは線形スケールで見た目が一致)
  // さらに、生きている墨ブロブ(最大10個超の巨大半透明 Bitmap)を毎フレーム
  // 60Hz でステージに直接合成するとフィルレートで FPS が崩壊するので、
  // inkCont ごと画面サイズで cache し、12Hz でだけ再合成する。
  // 毎フレームのコストは「キャッシュ済み1枚の全画面ブリット」だけになる。
  // フェードイン(220ms)・晴れフェード(0.8s)・遅いドリフトは 12Hz でも滑らかに見える
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

  function splatInk(x, y, direct) {
    var B = PP.BOSS.ink;
    var n = direct ? 6 : 1;
    if (!inkCanvas) inkCanvas = bakeInk();
    for (var i = 0; i < n; i++) {
      var r = B.rMin + Math.random() * (B.rMax - B.rMin);
      var bx = x, by = y;
      if (direct && i > 0) {        // 直撃は追加の墨が画面全域へ飛び散る
        bx = 120 + Math.random() * (PP.W - 240);
        by = 140 + Math.random() * (PP.H - 260);
        r *= 1.3;
      }
      // 中心は濃い墨だがわずかに透ける(完全な闇だと理不尽なので、
      // 目を凝らせば玉列がかろうじて読める程度に留める)
      var sh = new createjs.Bitmap(inkCanvas);
      sh.regX = sh.regY = INK_UR;
      sh.scaleX = sh.scaleY = r / INK_UR;
      sh.x = bx; sh.y = by;
      sh.alpha = 0;
      createjs.Tween.get(sh).to({ alpha: 1 }, 220);
      inkCont.addChild(sh);
      inkBlobs.push({ sh: sh, bx: bx, by: by, ph: Math.random() * 6.28, life: B.dur });
    }
    PP.fx.burst(x, y, "rgba(20,14,26,0.9)", 14, 1.5);
    PP.fx.shake(direct ? 10 : 4, direct ? 0.3 : 0.15);   // 墨のベチャッという着弾を体でも感じる
    PP.audio.inkSplat();
    if (direct) PP.audio.beep(55, 0.4, "sawtooth", 0.16);   // 直撃は腹に来る重さを足す
    if (!inkCont.cacheCanvas) inkCont.cache(0, 0, PP.W, PP.H);
    inkAcc = 1;   // 次の updateInk で即再合成(フェードイン開始を1フレームで反映)
  }

  function removeInk() {
    for (var i = 0; i < inkBlobs.length; i++) {
      createjs.Tween.removeTweens(inkBlobs[i].sh);
      if (inkBlobs[i].sh.parent) inkBlobs[i].sh.parent.removeChild(inkBlobs[i].sh);
    }
    inkBlobs.length = 0;
    if (inkCont && inkCont.cacheCanvas) inkCont.uncache();
  }

  function updateInk(dt) {
    if (inkBlobs.length === 0) {
      if (inkCont.cacheCanvas) inkCont.uncache();   // 墨ゼロなら全画面ブリットもやめる
      return;
    }
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
    if (inkBlobs.length === 0) {
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
      if (k === lastAttack) continue;
      if ((k === "addle" || k === "freeze" || k === "shotSlow") && fx[k] > 0) continue;
      if (k === "ink" && fx.ink > 0) continue;
      // ⚠系の大技は開幕からは撃たない(初見殺し防止)。進行中の同系統も避ける
      if ((k === "tentacle" || k === "tsunami" || k === "barrage") && attackCount < 1) continue;
      // 両舷斉射は最重量級なので2手目以降・進行中は重ねない
      if (k === "cross" && (attackCount < 2 || crossActive)) continue;
      if (k === "tsunami" && wave) continue;
      if (k === "barrage" && barrageLeft > 0) continue;
      if (k === "tentacle" && tentWavesLeft > 0) continue;   // 追撃波の進行中は重ねない
      if (k === "randomize" && (rndSpinT > 0 || sweepLeft > 0)) continue;
      if (k === "shotSlow" && curtainLeft > 0) continue;
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
  // ⚠マーカーは「静的な塗り(cache)」「脈動する外周リング(cache して alpha だけ
  // 動かす)」「収束する内リング(細い1本なので毎フレーム描いても軽い)」の
  // 3枚に分け、毎フレームの clear+3円+rgba文字列連結をやめる
  function addWarning(x, y, r, timer) {
    var fillSh = new createjs.Shape();
    fillSh.graphics.beginFill("rgba(255,48,32,0.14)").drawCircle(0, 0, r);
    fillSh.cache(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4);
    fillSh.x = x; fillSh.y = y;
    var ringSh = new createjs.Shape();
    ringSh.graphics.setStrokeStyle(3).beginStroke("#ff3020").drawCircle(0, 0, r);
    ringSh.cache(-r - 4, -r - 4, r * 2 + 8, r * 2 + 8);
    ringSh.x = x; ringSh.y = y;
    var sh = new createjs.Shape();     // 収束リング(毎フレーム描き直し)
    sh.x = x; sh.y = y;
    var txt = new createjs.Text("⚠", "700 34px sans-serif", "#ffd24a");
    txt.textAlign = "center"; txt.textBaseline = "middle";
    txt.x = x; txt.y = y;
    txt.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 2, 6);
    warnCont.addChild(fillSh, ringSh, sh, txt);
    warnings.push({ x: x, y: y, r: r, timer: timer, total: timer,
                    sh: sh, fill: fillSh, ring: ringSh, txt: txt });
  }

  function removeWarningViews(w) {
    if (w.sh.parent) warnCont.removeChild(w.sh);
    if (w.fill.parent) warnCont.removeChild(w.fill);
    if (w.ring.parent) warnCont.removeChild(w.ring);
    if (w.txt.parent) warnCont.removeChild(w.txt);
  }

  function clearWarnings() {
    for (var i = 0; i < warnings.length; i++) removeWarningViews(warnings[i]);
    warnings.length = 0;
    pendingZones.length = 0;
    // ⚠が消えるとき(攻撃キャンセル・ボス撃破・後片付け)は警報SEも道連れに
    PP.audio.bossDangerStop();
  }

  // ⚠マーカーの毎フレーム描画(進行で赤リングが収束+脈動、⚠が明滅)
  function updateWarnings(dt) {
    for (var i = warnings.length - 1; i >= 0; i--) {
      var w = warnings[i];
      w.timer -= dt;
      if (w.timer <= 0) {
        removeWarningViews(w);
        warnings.splice(i, 1);
        continue;
      }
      var k = 1 - w.timer / w.total;                 // 0→1 で収束
      w.ring.alpha = 0.5 + 0.3 * Math.sin(t * 12);
      var g = w.sh.graphics;
      g.clear();
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
    showBanner(PP.i18n.t(a.nameKey), a.color, stateT + 0.4);
    PP.audio.beep(140, 0.3, "sawtooth", 0.1);
    PP.audio.beep(110, 0.45, "sine", 0.09);
    // 予兆の間、画面全体に薄い血の色を差す(「来るぞ」の圧)
    PP.fx.screenFlash("rgba(140,0,0,0.10)", 0.10, stateT * 1000);
    // 重量級の攻撃はボスが咆哮する
    if (key === "tentacle" || key === "tsunami" || key === "barrage" || key === "cross") {
      PP.audio.bossRoar();
    }

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
      PP.audio.bossDanger();   // ⚠群の出現音(マーカー数に関係なく1回)
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
        warnCont.addChild(lnSh);
        crossTele.push(lnSh);
      }
      if (crossSafe) crossSafe.x = aimX0;   // 安置柱は中央から(明滅は update 側)
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
  function spdMul() { return phase2 ? PP.BOSS.phase2.speedMul : 1; }

  // 妖弾の発射。すべて口(あご下)から、狙いは発射時点の大砲の位置。
  // 発射後の軌道は固定なので、見てから移動すれば必ずかわせる
  function fireAttack(key) {
    var B = PP.BOSS;
    lastAttack = key;
    attackCount++;
    var sx = body.x, sy = body.y + 38;
    var tx = PP.cannon.x, ty = PP.cannon.y - 20;
    // 発射の共通演出: 口元の閃光+攻撃色の全画面フラッシュ+シェイク+重い発砲音
    PP.audio.beep(200, 0.15, "square", 0.12);
    PP.audio.beep(90, 0.35, "sawtooth", 0.12);
    PP.fx.flash(sx, sy, "rgba(120,220,180,0.7)", 40);
    PP.fx.ring(sx, sy, ATTACKS[key].color, 14, 120, 380);
    PP.fx.screenFlash(ATTACKS[key].color, 0.10, 280);
    PP.fx.shake(5, 0.18);   // 攻撃の発射は毎回ドンと響く
    if (key === "ink") {
      // 漆黒の墨獄: 等間隔の弧を描いて降り注ぐ墨玉のカーテン(中央は大砲狙い)
      var K = B.ink;
      var lobs = K.lobs + (phase2 ? 2 : 0);
      for (var i = 0; i < lobs; i++) {
        var lobT = tx + (i - (lobs - 1) / 2) * 190;
        // 放物線: vy0 で軽く浮かせ、grav で落とす。到達時間から vx を逆算
        var fallT = (Math.sqrt(K.vy0 * K.vy0 + 2 * K.grav * (ty - sy)) - K.vy0) / K.grav;
        spawnBullet("ink", sx, sy, (lobT - sx) / fallT * spdMul(), K.vy0, K.grav, 18);
      }
      // 重い墨壺を吐き出す音+体を震わせる反動
      PP.audio.gliss(340, 80, 0.6, "sine", 0.13);
      PP.fx.shake(8, 0.25);
    } else if (key === "freeze") {
      // 深淵の錨鎖: ボスを中心に直線で広がる同心二重の錨のリング。
      // 外環(速)と内環(遅・半歩ずれ)が時間差で押し寄せ、全弾が中玉として
      // 多段分裂する(下の burst 構築を参照)
      var F = B.freeze;
      var FB = F.burst;
      PP.audio.rings();   // 同心リング展開の専用SE
      // 錨鎖の展開は鎖が軋む重低音+二重の衝撃波リングで「重さ」を出す
      PP.audio.beep(70, 0.5, "sawtooth", 0.18);
      PP.fx.ring(sx, sy, "#ffd24a", 24, 180, 520);
      PP.fx.ring(sx, sy, "#ffd24a", 10, 110, 420);
      PP.fx.shake(9, 0.25);
      // 全リングの弾が中玉(撃ち落とし可)になり、splitDelay 秒後に一斉に
      // 小弾の同心円リングへ割れる。怒りフェーズは addle と同じ三段
      // (中玉→第二世代の中玉→小弾)なので、初段のリングは細めに絞る
      var fSmall = { t: FB.split2Delay, count: phase2 ? FB.smallsP2 : FB.smalls,
                     speed: FB.smallSpeed * spdMul(), r: FB.smallR };
      var fSplit = phase2
        ? { t: FB.splitDelay, count: FB.mid2Count, speed: FB.mid2Speed * spdMul(),
            r: FB.mid2R, hp: FB.mid2Hp, spin: FB.midSpin, child: fSmall }
        : { t: FB.splitDelay, count: FB.smalls, speed: FB.smallSpeed * spdMul(), r: FB.smallR };
      var ringDefs = phase2
        ? [{ n: 8, v: F.speed }, { n: 6, v: F.speed * 0.7 }]
        : [{ n: 12, v: F.speed }, { n: 8, v: F.speed * 0.68 }];
      var fIdx = 0;   // 全リング通しの番号(時間差ポップと音程上昇に使う)
      for (var rl = 0; rl < ringDefs.length; rl++) {
        var rd = ringDefs[rl];
        var shift = rl * (Math.PI / rd.n);         // 環ごとに半歩ずらす
        for (var f = 0; f < rd.n; f++) {
          var angF = (Math.PI * 2 / rd.n) * f + shift;
          spawnBullet("freeze", sx, sy,
            Math.cos(angF) * rd.v * spdMul(), Math.sin(angF) * rd.v * spdMul(), 0, FB.midR,
            { spin: FB.midSpin, hp: FB.midHp, viewScale: FB.midR / B.orb.r,
              split: FB.splitStep
                ? { t: fSplit.t + fIdx * FB.splitStep, count: fSplit.count,
                    speed: fSplit.speed, r: fSplit.r, hp: fSplit.hp,
                    spin: fSplit.spin, idx: fIdx, child: fSplit.child }
                : fSplit });
          fIdx++;
        }
      }
    } else if (key === "addle") {
      // 惑乱の逆潮: 惑わしの大珠が盤面中央まで降りてホバリングし、
      // 「二段分裂」する: 中央から割れて中玉がらせん状に拡散し、
      // 各中玉が時間差でさらに小弾のリングへ割れる。
      // 大玉を削り切る(hp5) / 中玉を撃ち落とす(hp2) / 避けに徹する、の三択
      var AB = B.addle.burst;
      // 中玉の分裂スペック: 通常は「中玉→小弾」の二段。
      // 怒りフェーズは「中玉→第二世代の中玉(回転)→小弾(直線)」の三段(初段の数は絞る)
      var aSmall = { t: AB.split2Delay, count: phase2 ? AB.smallsP2 : AB.smalls,
                     speed: AB.smallSpeed * spdMul(), r: AB.smallR };
      var aSplit = phase2
        ? { t: AB.splitBase, count: AB.mid2Count, speed: AB.mid2Speed * spdMul(),
            r: AB.mid2R, hp: AB.mid2Hp, spin: AB.midSpin, child: aSmall }
        : { t: AB.splitBase, count: AB.smalls, speed: AB.smallSpeed * spdMul(), r: AB.smallR };
      var ddxA = tx - sx, ddyA = ty - sy;
      var dlenA = Math.sqrt(ddxA * ddxA + ddyA * ddyA) || 1;
      spawnBullet("addle", sx, sy,
        ddxA / dlenA * 360 * spdMul(), Math.abs(ddyA) / dlenA * 360 * spdMul(), 0, B.shotSlow.r,
        { hp: 5,   // 大玉は5発当てないと消せない(分裂前に削り切るかの判断)
          hover: { y: 380, time: 0.8,
                   burst: { mids: phase2 ? AB.midsP2 : AB.mids,
                            midR: AB.midR, midHp: AB.midHp,
                            midVr: AB.midVr * spdMul(),
                            splitStep: AB.splitStep, split: aSplit } } });
      // 惑わしの大珠の射出音(不穏な上昇うねり)
      PP.audio.gliss(180, 420, 0.7, "triangle", 0.1);
    } else if (key === "shotSlow") {
      // 時凪の呪縛: 大弾のカーテンを五重(怒り時は六重)、時間差で1枚ずつ落とす。
      // 実際の発生は updateCurtain(奇数枚と偶数枚で隙間が互い違い)
      curtainTotal = phase2 ? 6 : 5;
      curtainLeft = curtainTotal;
      curtainT = 0;                                 // 1枚目はすぐ
      PP.audio.bossBallSlow();   // 時凪の呪縛(大弾カーテン)の専用SE
    } else if (key === "randomize") {
      // 運命のルーレット: 左右から交差する2本の「回転する腕」が
      // 弧を掃くように弾を置いていく(ルーレットの針の回転)
      sweepTotal = 16 + (phase2 ? 6 : 0);
      sweepLeft = sweepTotal;
      sweepT = 0;
      PP.audio.bossSweep();   // 水色の掃射の専用SE
      PP.fx.shake(6, 0.2);
    } else if (key === "tentacle") {
      // ⚠地点へ画面下から触手が突き上げる(範囲内ならランダムなデバフ)。
      // ここは第1波。以降は updateTentacleWaves が「間→⚠→突き上げ」の
      // 追撃波を刻む(波状のドラム。常に⚠2個分しか塞がない=必ず逃げ場がある)
      var KT = B.tentacle;
      tentWaveIdx = 0;
      PP.audio.bossDangerStop();   // 触手が出たら警報(⚠のSE)は断ち切る
      for (var z = 0; z < pendingZones.length; z++) spawnStrike(pendingZones[z], 0);
      pendingZones.length = 0;
      tentWavesLeft = phase2 ? KT.extraWavesP2 : KT.extraWaves;
      tentPhase = "gap";
      tentTimer = KT.waveGap;
      PP.fx.shake(10, 0.25);
      PP.audio.beep(90, 0.4, "sawtooth", 0.14);
      PP.audio.bossTentacle();   // 触手突き上げの専用SE
    } else if (key === "tsunami") {
      PP.audio.tsunami();   // 水壁が走り出す轟音
      startWave();
    } else if (key === "barrage") {
      // 隕石: ボレー発射は update 側のタイマーで刻む(1発目はすぐ)
      barrageLeft = B.barrage.volleys + (phase2 ? 1 : 0);
      barrageT = 0;
    } else if (key === "cross") {
      // 両舷斉射: 予兆線を消して振り子掃引開始(実際の発射は updateCross が刻む)
      clearCrossTele();
      crossActive = true;
      crossT = 0;
      crossEmitAcc = 0;
      PP.audio.bossWaveAttack();   // 両舷斉射の専用SE(bossSweep はルーレット専用に戻した)
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
  function spawnStrike(x, waveIdx) {
    var K = PP.BOSS.tentacle;
    var sh = new createjs.Shape();
    strikeCont.addChild(sh);
    strikes.push({ sh: sh, x: x, timer: K.riseTime + K.holdTime, rise: K.riseTime,
                   hold: K.holdTime, hitDone: false, seed: Math.random() * 6.28,
                   wave: waveIdx || 0 });
  }

  // 触手の追撃波: fireAttack の第1波の後、「間(gap)→⚠(warn)→突き上げ」を
  // tentWavesLeft 回繰り返す。⚠の1個目は警告を出す瞬間の大砲X(=「動け」の圧)、
  // 2個目はそこから±200〜340pxオフセット。全打撃に waveWarn 秒以上の予告がある
  function updateTentacleWaves(dt) {
    if (tentWavesLeft <= 0) return;
    var K = PP.BOSS.tentacle;
    tentTimer -= dt;
    if (tentTimer > 0) return;
    if (tentPhase === "gap") {
      // ⚠を置く: 大砲現在位置 + オフセット1本の2地点
      var warnT = phase2 ? K.waveWarnP2 : K.waveWarn;
      tentPending.length = 0;
      var zx = Math.max(90, Math.min(PP.W - 90, PP.cannon.x));
      var off = (200 + Math.random() * 140) * (Math.random() < 0.5 ? -1 : 1);
      var zx2 = Math.max(90, Math.min(PP.W - 90, PP.cannon.x + off));
      tentPending.push(zx, zx2);
      for (var i = 0; i < tentPending.length; i++) {
        addWarning(tentPending[i], PP.CANNON_Y - 20, K.r, warnT);
      }
      PP.audio.bossDanger();   // ⚠群の出現音(旧: マーカーごとの beep は重複するので廃止)
      PP.audio.gliss(160, 320, warnT, "sine", 0.05);   // 次撃までのライザー(緊張感)
      tentPhase = "warn";
      tentTimer = warnT;
    } else {
      // ⚠満了 → 突き上げ。振り下ろしのフォール音+シェイク
      tentWaveIdx++;
      PP.audio.bossDangerStop();   // 触手が出たら警報(⚠のSE)は断ち切る
      for (var j = 0; j < tentPending.length; j++) spawnStrike(tentPending[j], tentWaveIdx);
      tentPending.length = 0;
      tentWavesLeft--;
      PP.audio.gliss(300, 55, 0.22, "sawtooth", 0.14);
      if (tentWavesLeft <= 0) {
        // 最終波: 締めの重低音+大きめのシェイクで「終わった」ことを体で分からせる
        PP.audio.beep(48, 0.6, "sawtooth", 0.22);
        PP.fx.shake(14, 0.3);
      } else {
        PP.fx.shake(10, 0.2);
      }
      tentPhase = "gap";
      tentTimer = K.waveGap;
    }
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
        PP.fx.burst(s.x, PP.H - 20, "rgba(200,230,246,0.9)", 18, 2.0);   // 突き破った水しぶき
        PP.fx.ring(s.x, PP.CANNON_Y - 40, "#ff5030", 20, 120, 400);
        PP.fx.ring(s.x, PP.H - 30, "rgba(190,230,246,0.8)", 10, 90, 450);
        PP.fx.shake(14, 0.3);
        // 打撃のビープは波が進むほど低く・大きく(78→71→64→57Hz)。
        // ドラムを追うだけで「まだ続く/終わりが近い」が耳で分かる
        PP.audio.beep(Math.max(50, 78 - s.wave * 7), 0.42, "sawtooth", 0.2);
        if (Math.abs(PP.cannon.x - s.x) < K.r + 25) {
          if (orbHitCd <= 0) {
            var pool = ["freeze", "addle", "shotSlow"];
            // フル時間のデバフ(0.7 倍では軽すぎて触手が怖くなかった)
            applyDebuff(pool[Math.floor(Math.random() * pool.length)], 1.0);
            // 触手専用の短い無敵(K.hitIFrames)。orb.hitIFrames だと追撃波が
            // 全部無効化されて波状のドラムが死ぬ。「連続ハメだけ防ぐ」長さ
            orbHitCd = K.hitIFrames;
            PP.cannon.setHurt(K.hitIFrames);
            PP.fx.shake(10, 0.3);
          } else {
            // 無敵中はバリアが掠める演出のみ(以前は無敵を無視して多段被弾していた)
            PP.fx.burst(PP.cannon.x, PP.cannon.y - 40, "#9fd8ff", 6, 1.0);
          }
        }
      }
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
      if (Math.abs(PP.cannon.x - tsuSafeX) > S.gapW / 2 - 10 && orbHitCd > 0) {
        // 被弾直後の無敵中は呑まれない(以前は無敵を無視して、仰け反り中に
        // そのまま押し流される理不尽があった)。しぶきだけ浴びてやり過ごす
        PP.fx.burst(PP.cannon.x, PP.CANNON_Y - 40, "rgba(190,230,246,0.9)", 10, 1.4);
        PP.audio.beep(300, 0.15, "triangle", 0.08);
      } else if (Math.abs(PP.cannon.x - tsuSafeX) > S.gapW / 2 - 10) {
        wave.carried = true;   // 波と一緒に端まで流されていく(updateWave が運ぶ)
        PP.game.bossFx.freeze = Math.max(PP.game.bossFx.freeze, S.stun);
        // 呑まれた時点から無敵+点滅を開始(端に捨てられた後の立て直し猶予)
        orbHitCd = Math.max(orbHitCd, PP.BOSS.orb.hitIFrames);
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
        orbHitCd = Math.max(orbHitCd, PP.BOSS.orb.hitIFrames);
        PP.cannon.setHurt(PP.BOSS.orb.hitIFrames);
      }
      clearWave();
    }
  }

  // ---------- 妖星の豪雨(画面上端から降り注ぐ本物の隕石) ----------
  // 予告は攻撃全体のテレグラフ(宣言バナー+咆哮)だけ。個々の隕石は
  // 炎の尾を引いて落ちてくるので、軌道は目で追って避ける(着弾マークは
  // 出さない — 画面がマークだらけになるだけで蛇足だった)。
  // 地面に落ちれば爆発+シェイク、大砲に直撃すればスタン(applyOrbHit)
  function updateBarrage(dt) {
    if (barrageLeft <= 0) return;
    barrageT -= dt;
    if (barrageT > 0) return;
    var Q = PP.BOSS.barrage;
    barrageT = Q.interval;
    barrageLeft--;
    var n = Q.perVolley + (phase2 ? 1 : 0);
    for (var i = 0; i < n; i++) {
      var mx = 80 + Math.random() * (PP.W - 160);
      var my = -30 - Math.random() * 60;
      var mvx = Math.max(-120, Math.min(120, (PP.cannon.x - mx) * 0.15)) * spdMul();
      spawnBullet("barrage", mx, my, mvx, Q.vy0 * spdMul(), Q.grav, Q.meteorR,
        { viewScale: Q.viewScale, meteor: true });
    }
    PP.audio.meteorFall();   // 落下ホイッスル(ボレーごと)
  }

  // ---------- 両舷斉射(超高密度ドット線のX字・振り子掃引) ----------
  // 左右の発射口から「掃引点」へ向けて毎秒 emitHz 発ずつ小弾を撃ち続ける。
  // ドット間隔 = speed/emitHz ≈ 17px なので2本の実線に見える。
  // 左舷は掃引点の右側(+gap)・右舷は左側(-gap)を狙う=線は必ず途中で
  // 交差(X字)し、掃引点そのものは「2本の線の間の安全地帯」になる。
  // 掃引点は画面中央から右→左→右…と振り子(sin)で swings 往復。
  // 安全地帯には光の柱(crossSafe)が追従するので、柱を追い続ければ抜けられる。
  // 振り子は端で減速するので、追いつくチャンスは往復の折り返しにある
  function emitCrossDot(ex, ey, txx, tyy, C) {
    var dx = txx - ex, dy = tyy - ey;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    spawnBullet("cross", ex, ey,
      dx / len * C.speed, dy / len * C.speed, 0, C.r,
      { viewScale: C.r / PP.BOSS.orb.r });
  }

  function updateCross(dt) {
    if (!crossActive) return;
    var C = PP.BOSS.cross;
    var period = C.period * (phase2 ? C.p2PeriodMul : 1);
    var dur = C.swings * period;
    crossT += dt;
    var amp = PP.W / 2 - C.ampMargin;
    var iy = PP.CANNON_Y - 20;
    var eL = { x: body.x - C.emitDX, y: body.y + C.emitDY };
    var eR = { x: body.x + C.emitDX, y: body.y + C.emitDY };
    // 照準は「発射時点」の振り子位置。弾は地上まで約1秒かけて飛ぶので、
    // 着弾の掃引は発射より約1秒遅れて同じ振り子を描く=最初の着弾は必ず
    // 予兆どおり中央から始まり、そこから右→左…と振れていく。
    // (「着弾時刻の位置」を先読みすると、撃ち始めの弾がいきなり右端を
    //  狙ってしまい予兆とズレる。先読みはしないこと)
    var aimX = PP.W / 2 + amp * Math.sin(Math.PI * 2 * crossT / period);
    crossEmitAcc += dt * C.emitHz;
    while (crossEmitAcc >= 1) {
      crossEmitAcc--;
      emitCrossDot(eL.x, eL.y, aimX + C.aimCrossGap, iy, C);   // 左舷 → 掃引点の右側
      emitCrossDot(eR.x, eR.y, aimX - C.aimCrossGap, iy, C);   // 右舷 → 掃引点の左側
    }
    if (crossT >= dur) crossActive = false;
  }

  // ---------- 時凪の呪縛(時間差で降る互い違いのカーテン) ----------
  // 0.55秒おきに1枚ずつ、全弾同速のカーテンを落とす。7発の段と6発の段を
  // 交互に撃ち、共通のピッチ(W/8)で 6発の段は 7発の段のちょうど中間に置く。
  // 降りてくる弾幕全体が綺麗な市松格子になり、「前の隙間を抜けたら
  // 次の隙間へ半歩移動する」を繰り返させるリズム攻撃
  function updateCurtain(dt) {
    if (curtainLeft <= 0) return;
    curtainT -= dt;
    if (curtainT > 0) return;
    curtainT = 0.45;
    var row = curtainTotal - curtainLeft;
    curtainLeft--;
    var B = PP.BOSS;
    var odd = row % 2;                          // 0=7発の段 / 1=6発の段
    var nS = 7 - odd;
    // ゆっくり垂れ下がる(急加速は全段出揃ってからの一斉落下で行う)
    var vS = B.shotSlow.fallSpeed * spdMul();
    var pitchS = PP.W / 8;                      // 両方の段で共通のピッチ
    for (var c2 = 0; c2 < nS; c2++) {
      var gxS = pitchS * (c2 + 1 + odd * 0.5);  // 6発の段は 7発の段の中間に
      spawnBullet("shotSlow", gxS, body.y + 20, 0, vS, 0, B.shotSlow.r,
        { wave: { amp: 12, freq: 1.6, ph: row * 1.3 + c2 * 0.4 }, curtain: true });
    }
    // 最終段を撃ち終えたら、一斉落下までのカウントダウンを開始
    if (curtainLeft <= 0) curtainDropT = B.shotSlow.dropDelay;
    // 段ごとに「ズン」と落ちる圧(音程は段が進むほど上がる=残りが読める)
    PP.audio.beep(180 + row * 30, 0.1, "sine", 0.09);
    PP.audio.gliss(420, 160, 0.4, "sine", 0.06);
    PP.fx.shake(3, 0.12);
  }

  // ---------- 運命のルーレット(左右から交差する回転スイープ) ----------
  // 針が回るように、左右の腕が弧を掃きながら弾を1発ずつ置いていく。
  // 2本の腕は中央で交差し、X字の美しい弾道が画面に残る
  function updateSweep(dt) {
    if (sweepLeft <= 0) return;
    sweepT -= dt;
    if (sweepT > 0) return;
    sweepT = 0.05;
    sweepLeft--;
    var sx = body.x, sy = body.y + 38;
    var k = 1 - sweepLeft / sweepTotal;                    // 0→1 で掃引
    var ang = Math.PI * (0.12 + 0.76 * k);                 // 左→右へ掃く腕
    var v = 390 * spdMul();
    spawnBullet("randomize", sx, sy, Math.cos(ang) * v, Math.sin(ang) * v, 0, PP.BOSS.orb.r,
      { wave: { amp: 30, freq: 2.5, ph: k * 6 } });
    var ang2 = Math.PI - ang;                              // 右→左へ掃く腕(鏡像)
    spawnBullet("randomize", sx, sy, Math.cos(ang2) * v, Math.sin(ang2) * v, 0, PP.BOSS.orb.r,
      { wave: { amp: 30, freq: 2.5, ph: 3 + k * 6 } });
    // 0.05秒刻み(20回/秒)で毎回鳴らすと Oscillator+Gain の生成が積み上がるので
    // 3 tick に 1 回に間引く(上昇ジッパー音の聴感はほぼ同一)
    if (sweepLeft % 3 === 0) PP.audio.beep(500 + k * 500, 0.04, "square", 0.05);
  }

  // 運命のルーレットの進行(被弾したときだけ回り始める)。回転中はチェーンの
  // 全玉がルーレットのように目まぐるしく色を入れ替え、確定の瞬間に「補給と同じ
  // 塊生成ルール」で並び直す(chain.js scrambleColors)。理不尽な完全ランダムに
  // ならず、シャッフル後も同色の塊を狙うゲームがそのまま成立する。装填玉は不変。
  function updateRandomize(dt) {
    if (rndSpinT <= 0) return;
    rndSpinT -= dt;
    rndStepT -= dt;
    if (rndSpinT <= 0) {
      PP.chain.scrambleColors("final");
      PP.game.rouletteSpin = false;   // 確定 → 磁石を通常に戻す
      PP.fx.screenFlash("rgba(142,240,208,0.25)", 0.25, 500);
      PP.audio.beep(1175, 0.16, "triangle", 0.1);
      PP.audio.beep(1568, 0.2, "triangle", 0.08);
      return;
    }
    if (rndStepT <= 0) {
      rndStepT = PP.BOSS.randomize.step;
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
    if (state !== "telegraph" || !curAttack) {
      if (charge.visible) charge.visible = false;
      return;
    }
    charge.visible = true;
    chargeAcc += dt;
    if (chargeAcc < 1 / 20) return;
    chargeAcc = 0;
    drawCharge();
    if (charge.cacheCanvas) charge.updateCache();
    else charge.cache(-178, -178, 356, 356);
  }

  function drawCharge() {
    var g = charge.graphics;
    g.clear();
    if (state !== "telegraph" || !curAttack) return;
    var a = ATTACKS[curAttack];
    var k = 1 - stateT / curTeleTotal;                // 0→1 で収束
    var r = 140 - 64 * k + Math.sin(t * 18) * 6;
    charge.x = body.x; charge.y = body.y - 20;
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
    if (!active || state === "dying" || state === "dead") return false;
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
      PP.fx.ring(body.x, body.y - 20, "#78c8ff", 30, 130, 500);
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
    if (state === "telegraph") {
      // 攻撃の阻止! チャージ中に撃ち込めた読みへのご褒美。
      // ⚠マーカー・安全柱・バナーも一緒に片付ける(攻撃自体が消える)
      state = "recover";
      stateT = PP.BOSS.recover + 0.6;   // 怯みで隙も少し伸びる
      curAttack = null;
      queuedAttack = null;
      charge.graphics.clear();
      clearWarnings();
      clearCrossTele();
      hideSafePillar();
      hideBanner();
      PP.fx.floatText(PP.i18n.t("boss.stopped"), body.x, body.y + 96, "#8ef0d0", 24);
      PP.audio.beep(880, 0.12, "triangle", 0.1);
      PP.audio.beep(1175, 0.18, "triangle", 0.1);
    }
    // HP半分で怒りフェーズへ(1回だけ)
    if (!phase2 && hp > 0 && hp <= Math.ceil(maxHp() * PP.BOSS.phase2.hpRatio)) enterPhase2();
    if (hp <= 0) startDying();
    return true;
  }

  // 怒りフェーズ: 攻撃間隔短縮・弾速アップ・コンボ追撃。見た目も血赤に燃える
  function enterPhase2() {
    phase2 = true;
    PP.fx.shake(20, 0.5);
    PP.fx.screenFlash("rgba(200,30,20,0.25)", 0.25, 700);
    showBanner(PP.i18n.t("boss.rage"), "#ff5030", 2.0);
    PP.audio.bossRoar();
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
    PP.fx.floatText(PP.i18n.t("boss.slain"), PP.W / 2, PP.H / 2 - 60, "#ffdf8a", 40);
    PP.audio.explode();
    PP.audio.krakenDeath();    // 断末魔
  }

  function updateDying(dt) {
    stateT -= dt;
    body.y += 46 * dt;             // 海へ沈んでいく
    body.alpha = Math.max(0, stateT / 1.6);
    if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 14) { // 沈みながら弾ける
      PP.fx.burst(body.x + (Math.random() - 0.5) * 160,
                  body.y + (Math.random() - 0.5) * 120, "#39d8b8", 8, 1.4);
    }
    if (stateT <= 0) {
      state = "dead";
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
    rndSpinT = 0;
    PP.game.rouletteSpin = false;
    barrageLeft = 0;
    sweepLeft = 0;
    curtainLeft = 0;
    curtainDropT = 0;
    tentWavesLeft = 0;
    tentPending.length = 0;
    queuedAttack = null;
    crossActive = false;
    crossT = 0;
    crossEmitAcc = 0;
    crossHitCd = 0;
    crossCenterK = 0;
    meteorKnock = null;
    orbHitCd = 0;
    parryBeepCd = 0;
    PP.cannon.clearHurt();   // ステージリセットで点滅を残留させない
    if (crossSafe) crossSafe.alpha = 0;
    clearCrossTele();
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

    // 状態異常タイマー(bossFx)の減算は powerups.js の update に一本化した
    // (骸骨玉・パワーダウンとの共用のため。二重に減らさないこと)。
    // 発生・解除の文字通知は出さない(HUD の状態異常チップに一本化)
    if (iFrames > 0) iFrames -= dt;
    if (guardFxCd > 0) guardFxCd -= dt;
    // シールドの残りと泡の明滅(無敵中だけ見える)
    if (guardT > 0) {
      guardT = Math.max(0, guardT - dt);
      if (shield) shield.alpha = 0.55 + 0.25 * Math.sin(t * 10)
        * (guardT < 0.6 ? guardT / 0.6 : 1);   // 終わり際は瞬いて消える
      if (shield && guardT === 0) shield.alpha = 0;
    } else if (shield && shield.alpha !== 0) shield.alpha = 0;

    updateInk(dt);
    updateBullets(dt);
    updateRandomize(dt);
    updateWarnings(dt);
    updateStrikes(dt);
    updateTentacleWaves(dt);
    updateWave(dt);
    updateBarrage(dt);
    updateCross(dt);
    updateSweep(dt);
    updateCurtain(dt);
    updateChips(dt);
    if (crossHitCd > 0) crossHitCd -= dt;
    if (orbHitCd > 0) orbHitCd -= dt;
    if (parryBeepCd > 0) parryBeepCd -= dt;
    // 時凪のカーテン: 全段出揃って dropDelay 秒後、「全弾同時」に一斉落下。
    // 凪いでいた画面全体の弾が同じ瞬間に流れ出すのが演出の芯なので、
    // 弾ごとではなくここで一括して速度を跳ね上げる
    if (curtainDropT > 0) {
      curtainDropT -= dt;
      if (curtainDropT <= 0) {
        var dMul = B.shotSlow.dashMul, dFx = 4;
        for (var di = 0; di < bullets.length; di++) {
          var db = bullets[di];
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
    if (meteorKnock) {
      meteorKnock.t += dt;
      var kk = Math.min(1, meteorKnock.t / meteorKnock.dur);
      var ke = 1 - (1 - kk) * (1 - kk);   // quadOut: 勢いよく飛んで減速
      PP.cannon.forceX(meteorKnock.fromX + (meteorKnock.toX - meteorKnock.fromX) * ke);
      g.bossFx.freeze = Math.max(g.bossFx.freeze, 0.1);
      if (PP.fx.particleLoad() < 0.75 && Math.random() < dt * 30) {
        PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, Math.random() < 0.5 ? "#ffa040" : "#8a8a8a", 2, 1.2);
      }
      if (kk >= 1) meteorKnock = null;
    }
    // 両舷斉射の予兆線は⚠と同じリズムで明滅させる
    for (var cti = 0; cti < crossTele.length; cti++) {
      crossTele[cti].alpha = 0.55 + 0.35 * Math.sin(t * 12);
    }
    // 安置柱は予兆中だけ明滅表示(初期安地=中央を示す)。発射後は消して、
    // 降ってくる2本の線そのものを見て隙間を追わせる(出しっぱなしは過剰)
    if (crossSafe) {
      var showSafe = state === "telegraph" && curAttack === "cross";
      crossSafe.alpha = showSafe ? 0.55 + 0.25 * Math.sin(t * 8) : 0;
    }
    // 怒りフェーズの赤ビネット(ゆっくり脈打つ圧迫感)
    if (rageVin) rageVin.alpha = phase2 ? 0.10 + 0.05 * Math.sin(t * 4) : 0;

    if (state === "dead") return;
    if (state === "dying") { updateDying(dt); drawTentaclesThrottled(1, dt); return; }

    // 移動: 画面上部をゆったり往復+上下の浮遊。
    // 両舷斉射のときだけは別: 予兆の間に画面中央へ滑り寄り、撃ち終わるまで
    // 中央に留まる(端から撃つと左右非対称の避けにくい交差になるため)。
    // crossCenterK を 0⇄1 で滑らかに出し入れして、動きが跳ばないようにする
    var wantX = PP.W / 2 + Math.sin(moveT * B.moveSpeed) * B.moveAmp;
    var crossHold = crossActive || (state === "telegraph" && curAttack === "cross");
    crossCenterK = crossHold ? Math.min(1, crossCenterK + dt * 1.6)
                             : Math.max(0, crossCenterK - dt * 1.6);
    body.x = wantX + (PP.W / 2 - wantX) * crossCenterK;
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

    drawTentaclesThrottled(0, dt);
    drawChargeThrottled(dt);

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
        // 両舷斉射(cross)はコンボの起点にしない: 振り子の掃引そのものが
        // swings×period 秒かけて画面を薙ぎ払う長い攻撃で、撃ち終わった直後も
        // まだ弾が降っている。そこへ短予兆(comboTelegraph)の追撃を重ねると、
        // 降り注ぐ線を避けながら次の予兆を読むことになり、見てから捌けない
        if (phase2 && !queuedAttack &&
            fired !== "ink" && fired !== "freeze" && fired !== "cross" &&
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
    hp = maxHp();
    lastHpDrawn = -1;
    state = "idle";
    stateT = PP.BOSS.firstDelay;
    curAttack = null; lastAttack = null;
    iFrames = 0; hurtT = 0; t = 0; moveT = 0;
    hitStreak = 0; guardT = 0; guardFxCd = 0;
    victoryPending = false; victoryConsumed = false;
    phase2 = false; attackCount = 0;
    clearStatusFx();
    if (built) {
      body.alpha = 1;
      body.x = PP.W / 2; body.y = PP.BOSS.y;
      hurt.alpha = 0;
      if (rageRim) { createjs.Tween.removeTweens(rageRim); rageRim.alpha = 0; }
      if (rageVin) rageVin.alpha = 0;
      if (shield) shield.alpha = 0;
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
    if (!active) removeOpeningHint();   // 非ボス面へ戻ったらヒントも片付ける
    if (active) {
      showBanner(PP.i18n.t("boss.banner"), "#ff5030", 3.2);
      PP.fx.screenFlash("rgba(160,20,16,0.3)", 0.3, 900);
      PP.fx.shake(12, 0.5);
      PP.fx.floatText(PP.i18n.t("boss.intro"), PP.W / 2, PP.H / 2 + 10, "#e6d3b8", 22);
      PP.audio.beep(55, 0.8, "sawtooth", 0.14);
      PP.audio.beep(82, 0.6, "sawtooth", 0.1);
      PP.audio.beep(110, 0.5, "sine", 0.08);
      showOpeningHint();
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
    PP.layers.hud.addChild(hintTxt);
    createjs.Tween.get(hintTxt)
      .wait(12000)
      .to({ alpha: 0 }, 900)
      .call(function () {
        if (hintTxt && hintTxt.parent) hintTxt.parent.removeChild(hintTxt);
        hintTxt = null;
      });
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
    getBulletCount: function () { return bullets.length; },
    // 指定した技を即座に予兆から始める(バランス調整・動作確認用)
    forceAttack: function (key) {
      if (!active || !built || !ATTACKS[key]) return false;
      if (state !== "idle" && state !== "recover") return false;
      startTelegraph(key);
      return true;
    }
  };
})();
