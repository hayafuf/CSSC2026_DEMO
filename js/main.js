/* =========================================================
 * main.js — 初期化・ゲーム進行・メインループ
 *
 * ゲーム進行は原作 Arcade モード式:
 * 生存ゲージ(秒数)が空になるまで耐えればレベルクリア。
 * 玉は波単位で補給され続け、いずれかのレーンの先頭が穴に届いたらゲームオーバー。
 *
 * マルチレーン: コースは 1〜N 本のレーン(レール+チェーン)を持つ。各レーンは
 * 自分の洞窟・樽を持ち独立して走る。どれか1本でも樽が溢れたらゲームオーバー、
 * 全レーンを掃討したらクリア。1本コースなら要素1のレーンが走るだけで従来と同一。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var stage;

  // 毎フレームのホットループ用の使い回しオブジェクト(posAtInto の書き込み先)。
  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };
  // デバッグ起動(?level=N)のレベル。指定中はゲームオーバー後の再開も
  // レベル1ではなく N から始める(死ぬたびに URL を開き直さなくて済む)
  var DBG_LEVEL = 0;
  // 樽に飲み込まれた玉が沈み切るまでの弧長(この距離で scale/alpha が下限へ)。
  var SINK = PP.D * (PP.BARREL_CAPACITY + 1);

  // ---------- 背景(動く夜の海) ----------
  var MOON_X = PP.bg ? PP.bg.MOON_X : PP.W * 0.62;   // 月光方向(レールの照り等で使う)

  // どのレベルでどのコースを走るか。5ステージ・1周のキャンペーンで、
  // ステージ N = コース N。最終コースをクリアするとゲームクリア(levelClear)。
  // COURSES に自作コース(course-api の register)が加わるとキャンペーンが伸びる。
  // 剰余は ?level=N の指定過剰や register 後の巡回に対する安全弁として残す。
  function courseForLevel(level) {
    var n = PP.COURSES.length || 1;
    return ((level - 1) % n + n) % n;   // level は 1 始まり。負値も安全に丸める
  }

  // ---------- レーンの生成 ----------
  // コースの各レーン定義から rail インスタンスとチェーン状態を作る。
  function buildLanes(course) {
    var nLanes = (course && course.lanes && course.lanes.length) || 1;
    var lanes = [];
    for (var i = 0; i < nLanes; i++) {
      lanes.push({
        rail: PP.rail.create(course, i),
        balls: [], recoil: null,
        wave: 0, pending: 0, needTreasure: false, waveFresh: false, waveTimer: 0,
        pendingMatches: [],
        barrel: null
      });
    }
    PP.game.lanes = lanes;
    return lanes;
  }

  // ---------- コース(レール・洞窟・樽)の構築 ----------
  // レベルでコースが替わるたびに呼ぶ。全レーンのレールを組み直し、path/barrel/
  // tunnel レイヤーの溝・洞窟・樽・覆いを描き直して、危機/ゲームオーバー演出を合わせる。
  function buildCourse(course) {
    // 速度はコースごとの設計。レーン長が違うので、px/s の一式もコースと一緒に差し替える。
    PP.game.speed = PP.speedProfile(course);
    var lanes = buildLanes(course);
    PP.game.hasOverpass = anyLaneHasOverpass();
    PP.game.ballsDirty = true;

    // 前のコースの描画物と、残っている玉の表示を片付ける
    PP.layers.path.removeAllChildren();
    PP.layers.bridgeUnder.removeAllChildren();
    PP.layers.bridge.removeAllChildren();
    PP.layers.barrel.removeAllChildren();
    PP.layers.tunnel.removeAllChildren();
    PP.layers.railFlow.removeAllChildren();
    PP.layers.ballUnder.removeAllChildren();
    PP.layers.ballOver.removeAllChildren();

    // 各レーンの木道・洞窟・立体交差の橋・樽・トンネルを描く(作画は course-view.js)
    // 交差点の一覧は石橋のアーチ割り(橋脚を交差点に立てず、下の道を塞がない)に使う。
    // courseCrossings は全レーンを measure し直す O(n^2) なので、レーンごとではなく
    // ここで1回だけ引いて配る。
    PP.courseView.reset();
    var crossings = PP.rail.courseCrossings(course);
    for (var i = 0; i < lanes.length; i++) PP.courseView.drawLane(lanes[i], crossings, i);
    // 危機/ゲームオーバー演出が参照する樽パーツ一覧
    PP.barrels = lanes.map(function (l) { return l.barrel; });

    // 演出(樽の灯り・這う赤・呑み込みの渦)を新しいレールへ合わせ直す
    if (PP.crisis.relocate) PP.crisis.relocate();
    if (PP.gameover.relocate) PP.gameover.relocate();
  }

  // ---------- レベル進行 ----------
  function startLevel() {
    var g = PP.game;
    // レベルに応じてコースを切り替える(玉を並べ直す前にレールを確定させる)。
    var course = g.customCourse || PP.COURSES[courseForLevel(g.level)];
    if (course !== g.builtCourse) { g.builtCourse = course; buildCourse(course); }
    // ボス戦(クラーケンの海域)か。フラグを立てて各所のボス分岐を有効にし、
    // ボス本体の表示と状態(HP・攻撃タイマー・状態異常)を仕切り直す
    g.bossMode = !!(course && course.boss);
    if (PP.boss) PP.boss.setActive(g.bossMode);
    if (PP.bg.setBossMode) PP.bg.setBossMode(g.bossMode);   // 背景も嵐の海へ切替
    PP.crisis.reset();           // 赤い帳・警報・ドクロを平常へ戻す
    PP.gameover.reset();         // 暗幕・渦・ドクロを片付ける
    PP.audio.gameStart();        // ゲームオーバー BGM から通常曲へ戻す
    PP.chain.clearTreasures();   // 宝玉は光の Tween を止めてから撤去する

    // 各レーンのチェーン状態をリセット(玉の表示も片付ける)
    g.ballsDirty = true;
    g.lanes.forEach(function (lane) {
      // 色玉はプールへ返す(宝玉など makeView 製でない view は releaseView が
      // 受け取らないので、従来どおり外すだけ)。リトライ/コース替えのたびに
      // プールが温まり、次の波の補給が丸ごと生成ゼロで済む
      lane.balls.forEach(function (b) {
        PP.ball.releaseView(b.view);
        if (b.view.parent) b.view.parent.removeChild(b.view);
      });
      lane.balls = [];
      lane.recoil = null;
      lane.wave = 0;
      lane.pending = 0;
      lane.needTreasure = false;
      lane.waveFresh = false;
      lane.waveTimer = 0;
      lane.pendingMatches = [];
      lane.leadD = 0;   // 先頭球の最終位置(クリア時の爆発走査の終点)も仕切り直す
    });
    killSweep();    // 走査の途中で試遊などが始まったときの保険(彗星の頭も片付ける)
    killIntro();    // イントロの最中に再スタートが走ったときも彗星を残さない
    itemWaitHinted = false;
    g.shots.forEach(function (s) { PP.layers.shot.removeChild(s.view); });
    g.shots = [];
    g.combo = 0;
    g.comboTimer = 0;
    g.rolloutDone = false;
    g.rolloutBoost = 1;      // 開始直後だけ速く流れ込み、減衰して通常速度へ
    g.special = null;
    g.specialLoaded = false;
    g.finishing = false;
    PP.powerups.clear();
    PP.chain.resetWind();   // 風の物理も仕切り直す(吹いてる最中のリトライで凪が誤発火しないように)
    PP.upgrades.onLevelStart();   // 【強化】自動系タイマー・救済を仕切り直す(段数は維持)
    // 骸骨玉の弾・墨と状態異常を仕切り直す(リトライ・再出航もここを通る)。
    // ボス戦は boss.setActive → reset → clearStatusFx が別途ゼロ化するが、
    // 通常コースはここが唯一のリセット地点になる
    if (PP.skull) PP.skull.clear();
    var bfx = g.bossFx;
    for (var bk in bfx) bfx[bk] = 0;
    PP.input.resetAim();   // 逆転(addle)の照準ブレンド状態も仕切り直す

    // Arcade 式: 生存ゲージが尽きるまで波が補給され続ける。
    // 難易度(【課題1】config.js の timeMult)で耐える秒数が伸縮する
    g.timeTotal = Math.round(Math.min(PP.ARCADE.maxTime,
      PP.ARCADE.baseTime + (g.level - 1) * PP.ARCADE.timePerLevel) * PP.diff().timeMult);
    g.timeLeft = g.timeTotal;
    // 色数を増やすと「装填色が先頭の危機に噛み合わない」場面が増える。
    // 難易度(【課題1】config.js)の colorAdd で早く増え、colorMax で上限、
    // colorMin で最低色数(序盤の底上げ。3色は消えすぎるので4色から)が決まる:
    // Easy/Normal は最終的に黒以外の全色(6)、Hard/HardCore は黒込みの全色(7)。
    // ただし全体の上限 PP.COLORS.max(課題2で解禁)を超えることはない。
    var c = PP.COLORS;
    var colorCap = Math.min(c.max, PP.diff().colorMax || c.max);
    g.nColors = Math.min(c.max,
      c.base + Math.floor((g.level - 1) / c.levelStep) * c.perLevel);
    g.nColors = Math.max(PP.diff().colorMin || 2, Math.min(colorCap, g.nColors + PP.diff().colorAdd));
    // イントロ(各レーンの道筋を彗星がなぞる)。ライフ消費リトライは暗幕演出が
    // あるので skipIntroOnce で飛ばす。"intro" 中は chain.startWave の SE ゲート
    // (state === "playing" のときだけ鳴る)が閉じるので、出航の波音は
    // イントロ明け(finishIntro)で1回だけ鳴らす。
    var doIntro = !skipIntroOnce;
    skipIntroOnce = false;
    g.state = doIntro ? "intro" : "playing";
    // 全レーンで最初の波を湧かせる(intro 中は chain.update が回らないので
    // 実際に玉が流れ込むのはイントロ明けから)
    g.lanes.forEach(function (lane) { PP.chain.startWave(lane); });

    g.currentColor = Math.floor(Math.random() * g.nColors);
    // 開始時から手札が同じ色2個にならないようにする
    g.nextColor = (g.currentColor + 1 + Math.floor(Math.random() * (g.nColors - 1))) % g.nColors;
    PP.cannon.refreshBalls();

    PP.hud.update();
    if (doIntro) startIntro();
  }

  // 生存ゲージが空になった瞬間。補給を打ち切り、残りの掃討に入る
  function startFinishing() {
    var g = PP.game;
    g.finishing = true;
    PP.audio.timeOver();      // 生存ゲージの時間切れ(掃討フェーズ移行)
    PP.fx.floatText(PP.i18n.t("main.finishing"), PP.W / 2, 96, "#8ef0d0", 24);
  }

  function levelClear() {
    var g = PP.game;
    var total = PP.COURSES.length;
    // 最終ステージ(自作コースのプレイ中は除く)ならゲームクリア
    var isFinal = !g.customCourse && g.level >= total;
    // 【強化】空中に残った 💎 を回収してからスコアを畳む。最後の波の宝玉は
    // 盤面が空になる瞬間に解放されるので、ここで拾わないと必ず取り損ねる。
    // 選択の権利は次のステージ開始直後に3択として開く(最終ステージ後は
    // ランが終わるため、権利はスコア +500 だけ残して畳まれる)
    PP.powerups.collectTreasures();
    g.score += 1000;
    g.failStreak = 0;   // ステージを越えられた=連続失敗の記録を畳む(ピティ解除)
    if (PP.skull) PP.skull.clear();   // クリア画面に妖弾・墨を固めて残さない
    PP.crisis.stop();          // 警報と赤い帳を畳む
    PP.audio.setDanger(false);
    PP.audio.clear();
    if (isFinal) {
      g.state = "gameclear";
      g.score += 5000;         // 全海域制覇ボーナス
      PP.hud.update();
      showGameClear();
      return;
    }
    g.state = "clear";
    PP.hud.update();
    var t = PP.i18n.t;
    // 次がボス海域なら、ただの「次のステージへ」ではなく最終決戦の前口上にする
    var next = PP.COURSES[courseForLevel(g.level + 1)];
    if (next && next.boss) {
      // 最終決戦の前口上 + 倒し方の要点(ボス戦はここまでのルールと勝利条件が
      // 違うので、突入前に必ず一度は目に入る場所で教える)
      PP.hud.showOverlay(t("main.clearTitle", { level: g.level, total: total }),
        t("main.clearBossBody", { score: g.score, tap: PP.TAP }));
    } else {
      PP.hud.showOverlay(t("main.clearTitle", { level: g.level, total: total }),
        t("main.clearBody", { score: g.score, tap: PP.TAP }));
    }
  }

  // 全海域制覇のオーバーレイ(levelClear と、gameclear 画面での言語切り替えの
  // 貼り替えで共用する。本文はその時点の g から毎回組み立て直す)
  function showGameClear() {
    var g = PP.game;
    var t = PP.i18n.t;
    // コンティニューの航海録: 一度も沈まなかったランには称号を、
    // 沈んだランにはどの海域で立ち上がったかを添える
    var honor = g.continues === 0
      ? t("main.gcNoContinue")
      : t("main.gcContinues", { n: g.continues, stages: g.continueStages.join(", ") });
    PP.hud.showOverlay(t(g.bossMode ? "main.gcTitleBoss" : "main.gcTitle"),
      t("main.gcBody", { total: PP.COURSES.length, honor: honor, score: g.score, tap: PP.TAP }));
  }

  // ---------- ステージクリアの爆発走査(Zuma 式の距離ボーナス) ----------
  // 掃討完了の瞬間、各レーンの樽の口から「先頭球が最後にいた場所」(lane.leadD、
  // tick が毎フレーム控えている)まで金の爆発が駆け抜け、玉1個ぶん(D)ごとに
  // PP.CLEAR_SWEEP.pointsPerBall を加算する。走査が終わってから levelClear() へ。
  // 走査中も state は "playing" のまま(盤面は空なので害がなく、HUD のスコアが
  // 生きた状態でカウントアップして見える)。数値は config.js の PP.CLEAR_SWEEP。
  var sweep = null;   // { t, parts: [{lane, d, to, nextBurst, n, bonus, done, comet}] }
  // 「残ったアイテムを回収せよ」の案内を出したか(クリアごとに1回だけ)
  var itemWaitHinted = false;
  // コース開始イントロ(各レーンの道筋を彗星がなぞる)。sweep と同じ彗星を使う
  var intro = null;           // { t, parts: [{lane, d, delay, nextSpark, done, comet}] }
  var skipIntroOnce = false;  // 次の startLevel でイントロを飛ばす(ライフ消費リトライ用)

  // 走査の先頭で燃える「彗星の頭」。多層の放射グラデを一度だけ焼いて使い回し、
  // 毎フレームは位置と脈動スケールを書くだけ(ラスタライズは起きない)
  function makeComet() {
    var s = new createjs.Shape();
    s.graphics
      .beginRadialGradientFill(
        ["rgba(255,252,230,0.95)", "rgba(255,214,90,0.6)", "rgba(255,150,40,0)"],
        [0, 0.35, 1], 0, 0, 0, 0, 0, 40)
      .drawCircle(0, 0, 40);
    s.compositeOperation = "lighter";
    s.cache(-41, -41, 82, 82);
    PP.layers.fx.addChild(s);
    return s;
  }

  // 走査の途中で試遊・リトライなどが始まったときの後始末(彗星の頭を残さない)
  function killSweep() {
    if (!sweep) return;
    for (var i = 0; i < sweep.parts.length; i++) {
      var c = sweep.parts[i].comet;
      if (c && c.parent) c.parent.removeChild(c);
    }
    sweep = null;
  }

  // ---------- コース開始イントロ(各レーンの道筋を彗星がなぞる) ----------
  // 出航の合図: 光の彗星が洞窟(d=0)から樽(holeD)まで各レーンを駆け抜け、
  // 「玉がどこを通ってどこへ落ちるか」を見せてからコースが始まる。
  // クリア走査(sweep)の逆走版で、彗星・火花・終点花火の道具立ても共有する。
  // タップでスキップ可(input.js → PP.skipIntro)。数値は config.js の PP.INTRO。
  function killIntro() {
    if (!intro) return;
    for (var i = 0; i < intro.parts.length; i++) {
      var pt = intro.parts[i];
      if (pt.comet && pt.comet.parent) pt.comet.parent.removeChild(pt.comet);
      if (pt.trail) {
        createjs.Tween.removeTweens(pt.trail);
        if (pt.trail.parent) pt.trail.parent.removeChild(pt.trail);
      }
    }
    intro = null;
  }

  // 彗星の尾のパラメータ。尾は「塗り残した線」ではなく、頭が通り過ぎたあと
  // 時間差でスッと消えていく(彗星の頭 makeComet と同じ 白熱→金→橙 の配色)
  var INTRO_TAIL_TIME = 0.55;   // 頭が通ってから尾のその地点が消えるまでの秒数
  var INTRO_TAIL_STEP = 14;     // 尾の頂点間隔 px(小さいほど曲線が滑らか)

  // 尾の描画用シェイプ(毎フレーム全消し→描き直し。加算合成で発光して見える)
  function makeIntroTrail() {
    var s = new createjs.Shape();
    s.compositeOperation = "lighter";
    PP.layers.fx.addChild(s);
    return s;
  }

  // 頭(pt.d)から離れすぎた頂点を尾の末端から捨てる
  function pruneIntroTail(pt) {
    var tailLen = pt.speed * INTRO_TAIL_TIME;
    while (pt.tailPts.length && pt.d - pt.tailPts[0].d > tailLen) pt.tailPts.shift();
  }

  // 尾を描く: 頭に近いほど太く白熱し、末端へ向かって金→橙に冷めながら細く消える
  function drawIntroTail(pt) {
    var tg = pt.trail.graphics;
    tg.clear();
    var pts = pt.tailPts;
    if (pts.length < 2) return;
    var tailLen = pt.speed * INTRO_TAIL_TIME;
    for (var j = 1; j < pts.length; j++) {
      var a = pts[j - 1], b = pts[j];
      var k = 1 - (pt.d - b.d) / tailLen;   // 1=頭の直後、0=消える寸前
      if (k <= 0) continue;
      // 外層: 橙の淡いグロー
      tg.setStrokeStyle(3 + 15 * k * k, "round", "round")
        .beginStroke("rgba(255,150,40," + (0.25 * k * k).toFixed(3) + ")")
        .moveTo(a.x, a.y).lineTo(b.x, b.y).endStroke();
      // 芯: 白熱(頭)→ 金(末端)。makeComet の放射グラデと同じ温度感
      tg.setStrokeStyle(1.5 + 4.5 * k, "round", "round")
        .beginStroke("rgba(255," + Math.round(200 + 52 * k) + "," +
                     Math.round(90 + 140 * k) + "," + (0.9 * k).toFixed(3) + ")")
        .moveTo(a.x, a.y).lineTo(b.x, b.y).endStroke();
    }
  }

  function startIntro() {
    var g = PP.game;
    var parts = [];
    g.eachLane(function (lane) {
      var p0 = lane.rail.posAt(0);
      var pt = { lane: lane, d: 0, tailPts: [], lastTailD: 0,
                 nextSpark: 0, nextRing: 0, n: 0,
                 // 順番になぞるので、長いレーンは maxLaneTime 秒に収まるよう加速する
                 speed: Math.max(PP.INTRO.speed, lane.rail.holeD / PP.INTRO.maxLaneTime),
                 trail: makeIntroTrail(), comet: makeComet() };
      pt.comet.x = p0.x; pt.comet.y = p0.y;
      pt.comet.visible = false;   // 自分の番が来るまで隠しておく
      parts.push(pt);
    });
    if (!parts.length) { g.state = "playing"; return; }
    intro = { t: 0, idx: 0, parts: parts };
    PP.fx.screenFlash("rgba(255,214,110,0.28)", 0.28, 500);
    PP.fx.shake(10, 0.35);
    PP.fx.floatText(PP.i18n.t("main.introGo"), PP.W / 2, PP.H / 2 - 84, "#ffd24a", 40);
    PP.fx.floatText(PP.i18n.t("main.introHint"), PP.W / 2, PP.H / 2 - 44, "#f5e8c8", 22);
    PP.fx.floatText(PP.i18n.t("main.introSkip", { tap: PP.TAP }), PP.W / 2, PP.H / 2 - 14, "#b0a890", 15);
    beginIntroLane(0);
  }

  // k 番目のレーンのなぞりを始める(複数レーンは同時ではなく1本ずつ順番)。
  // 音のライザーはレーンごとに下降→上昇→下降…と交互(偶数=下降、奇数=上昇)
  function beginIntroLane(k) {
    var pt = intro.parts[k];
    pt.comet.visible = true;
    var c0 = pt.lane.rail.posAt(0);
    PP.fx.flash(c0.x, c0.y, "#ffe9a0", 80);
    PP.fx.ring(c0.x, c0.y, "#ffd24a", 12, 130, 420);
    PP.fx.burst(c0.x, c0.y, "#ffd24a", 22, 2.0);
    PP.fx.shake(8, 0.25);
    PP.audio.introLaunch(k);
    PP.audio.introRiser(pt.lane.rail.holeD / pt.speed, (k & 1) === 1);
  }

  function updateIntro(dt) {
    if (!intro) { PP.game.state = "playing"; return; }   // UI 無しの保険
    intro.t += dt;

    // なぞり終えたレーンの尾: 仮想の頭(pt.d)を進め続けることで、
    // 樽に吸い込まれるように末端からスッと消えていく
    for (var i = 0; i < intro.idx && i < intro.parts.length; i++) {
      var ft = intro.parts[i];
      if (!ft.tailPts.length) continue;
      ft.d += ft.speed * dt;
      pruneIntroTail(ft);
      drawIntroTail(ft);
    }
    if (intro.idx >= intro.parts.length) return;   // 全レーン到達後の保険

    var pt = intro.parts[intro.idx];
    var up = (intro.idx & 1) === 1;   // チクタクの音程もライザーと同じ向きに
    pt.d += pt.speed * dt;
    var end = pt.lane.rail.holeD;
    var hp = pt.lane.rail.posAt(Math.min(pt.d, end));

    // 尾の頂点をレール弧長 INTRO_TAIL_STEP ごとに拾う(曲線でも滑らかな尾になる)
    var headD = Math.min(pt.d, end);
    while (pt.lastTailD + INTRO_TAIL_STEP <= headD) {
      pt.lastTailD += INTRO_TAIL_STEP;
      var tp = pt.lane.rail.posAt(pt.lastTailD);
      pt.tailPts.push({ x: tp.x, y: tp.y, d: pt.lastTailD });
    }
    pruneIntroTail(pt);
    drawIntroTail(pt);

    pt.comet.x = hp.x; pt.comet.y = hp.y;
    pt.comet.scaleX = pt.comet.scaleY = 1.2 + 0.35 * Math.sin(intro.t * 22);
    // 火の粉: 頭の位置から白金の粒がこぼれ落ちる
    PP.fx.burst(hp.x, hp.y, (pt.n & 1) ? "#ffd24a" : "#fff3c0", 2, 0.8);
    // D×sparkEvery ごとの火花 + チクタク(処理落ちでも while で追いつく)
    while (pt.nextSpark <= pt.d && pt.nextSpark < end) {
      var sp = pt.lane.rail.posAt(pt.nextSpark);
      PP.fx.burst(sp.x, sp.y, (pt.n & 1) ? "#fff3c0" : "#ffd24a", 5, 1.2);
      PP.audio.introTick(pt.n, up);
      pt.n++;
      pt.nextSpark += PP.D * PP.INTRO.sparkEvery;
    }
    // 8個ごとの節目は金の波紋リングを刻む
    while (pt.nextRing <= pt.d && pt.nextRing < end) {
      var rp = pt.lane.rail.posAt(pt.nextRing);
      PP.fx.ring(rp.x, rp.y, "#ffd24a", 4, 64, 320);
      pt.nextRing += PP.D * 8;
    }

    if (pt.d >= end) {
      // 樽(ゴール)へ到達: 大花火で「ここに入れたら負け」を目立たせて次のレーンへ。
      // 尾は上の「なぞり終えたレーン」ループが末端から消してくれる
      if (pt.comet.parent) pt.comet.parent.removeChild(pt.comet);
      PP.fx.flash(hp.x, hp.y, "#fff6d0", 90);
      PP.fx.ring(hp.x, hp.y, "#ffd24a", 10, 150, 500);
      PP.fx.ring(hp.x, hp.y, "#fff3c0", 5, 90, 380);
      PP.fx.burst(hp.x, hp.y, "#ffd24a", 26, 2.4);
      PP.fx.burst(hp.x, hp.y, "#ff5d5d", 12, 1.6);
      PP.fx.shake(18, 0.35);
      PP.audio.sweepFinish();
      intro.idx++;
      if (intro.idx < intro.parts.length) beginIntroLane(intro.idx);
      else finishIntro();
    }
  }

  // イントロの締め(全レーン到達 or タップでスキップ)。ここで初めて時が動き出す。
  // 軌跡はフェードで消し、彗星は即座に片付ける
  function finishIntro() {
    var g = PP.game;
    if (g.state !== "intro") { killIntro(); return; }
    if (intro) {
      for (var i = 0; i < intro.parts.length; i++) {
        var pt = intro.parts[i];
        if (pt.comet.parent) pt.comet.parent.removeChild(pt.comet);
        (function (tr) {
          createjs.Tween.get(tr, { override: true })
            .to({ alpha: 0 }, 800)
            .call(function () { if (tr.parent) tr.parent.removeChild(tr); });
        })(pt.trail);
      }
      intro = null;
    }
    g.state = "playing";
    PP.fx.screenFlash("rgba(255,214,110,0.28)", 0.28, 400);
    PP.fx.shake(12, 0.3);
    PP.fx.floatText(PP.i18n.t("main.battleStart"), PP.W / 2, PP.H / 2 - 60, "#ffd24a", 34);
    PP.audio.introGo();   // 着水のドン
    PP.audio.newWave();   // イントロ中に抑えていた出航の波音をここで1回
    PP.hud.update();
  }

  function startClearSweep() {
    var g = PP.game;
    var parts = [];
    g.eachLane(function (lane) {
      var from = lane.rail.holeD;
      var to = Math.max(lane.leadD || 0, PP.R);   // 先頭球が最後にいた場所まで
      if (from - to < PP.D) return;               // 走る距離が無いレーンは飛ばす
      // 発進の号砲: 樽の口で大きく弾けてから走り出す
      var p0 = lane.rail.posAt(from);
      PP.fx.flash(p0.x, p0.y, "#ffe9a0", 60);
      PP.fx.ring(p0.x, p0.y, "#ffd24a", 10, 110, 420);
      PP.fx.burst(p0.x, p0.y, "#ffd24a", 18, 1.8);
      parts.push({ lane: lane, d: from, to: to, nextBurst: from, n: 0, bonus: 0,
                   done: false, comet: makeComet() });
    });
    if (!parts.length) { levelClear(); return; }
    // 全画面の金フラッシュ + 揺れ + 宣言で「ボーナスタイム発動!」を伝える
    PP.fx.screenFlash("rgba(255,214,110,0.28)", 0.28, 450);
    PP.fx.shake(14, 0.4);
    PP.fx.floatText(PP.i18n.t("main.sweepStart"), PP.W / 2, PP.H / 2 - 60, "#ffd24a", 30);
    PP.audio.sweepStart();   // 発進の巻き上げライザー + 号砲
    sweep = { t: 0, parts: parts };
  }

  function updateSweep(dt) {
    var g = PP.game;
    var cs = PP.CLEAR_SWEEP;
    sweep.t += dt;
    var allDone = true;
    for (var i = 0; i < sweep.parts.length; i++) {
      var pt = sweep.parts[i];
      if (pt.done) continue;
      allDone = false;
      pt.d -= cs.speed * dt;
      // 彗星の頭を先頭に追従させる(加算合成の光が脈打ちながら駆け抜ける)
      var hp = pt.lane.rail.posAt(Math.max(pt.d, pt.to));
      pt.comet.x = hp.x; pt.comet.y = hp.y;
      pt.comet.scaleX = pt.comet.scaleY = 1 + 0.3 * Math.sin(sweep.t * 22 + i * 2);
      // D ごとに爆発と加点(処理落ちフレームでは複数段まとめて進む)
      while (pt.nextBurst >= pt.d && pt.nextBurst >= pt.to) {
        var p = pt.lane.rail.posAt(pt.nextBurst);
        // 金と白金を交互に散らす火花のシャワー(パーティクルはプール制なので
        // 飽和しても超過分が捨てられるだけ=重くならない)
        PP.fx.burst(p.x, p.y, (pt.n & 1) ? "#fff3c0" : "#ffd24a", 7, 1.4);
        if ((pt.n & 1) === 0) PP.fx.ring(p.x, p.y, "#ffd24a", 4, 52, 260);
        if ((pt.n & 1) === 0) {
          // 駆け上がる多層のジッパー音(audio.js の sweepTick)。2段に1回で
          // 毎秒40発近く鳴るので1発は小さめに作ってある。うるさければ
          // (pt.n & 3) に戻せば密度が半分になる。マルチレーンで音が飽和する
          // ようなら i === 0 のパートだけ鳴らすのも手
          PP.audio.sweepTick(pt.n);
        }
        if ((pt.n & 7) === 0) {   // 8個ごとの節目は大きく光って小さく揺れる
          PP.fx.flash(p.x, p.y, "#ffe9a0", 40);
          PP.fx.shake(5, 0.15);
        }
        g.score += cs.pointsPerBall;
        pt.bonus += cs.pointsPerBall;
        pt.n++;
        pt.nextBurst -= PP.D;
      }
      if (pt.d <= pt.to) {
        pt.done = true;
        if (pt.comet.parent) pt.comet.parent.removeChild(pt.comet);
        var pe = pt.lane.rail.posAt(Math.max(pt.to, PP.R));
        // 終点の大花火: 白閃光 + 多重リング + 大量の金粉 + 揺れ
        PP.fx.flash(pe.x, pe.y, "#fff6d0", 80);
        PP.fx.ring(pe.x, pe.y, "#ffd24a", 8, 130, 460);
        PP.fx.ring(pe.x, pe.y, "#fff3c0", 4, 80, 340);
        PP.fx.burst(pe.x, pe.y, "#ffd24a", 22, 2.4);
        PP.fx.burst(pe.x, pe.y, "#fff3c0", 12, 1.6);
        PP.fx.shake(16, 0.35);
        PP.audio.sweepFinish();   // 終点の花火に音を付ける(低音の腹 + アルペジオ)
        PP.fx.floatText(PP.i18n.t("main.sweepBonus", { n: pt.bonus }), pe.x, pe.y - 26, "#ffd24a", 26);
      }
    }
    PP.hud.update();
    if (allDone) {
      // 走査完了 → すぐにクリア画面を開かず、余韻(afterglow)を置く。
      // 大花火の残光の中、終点からきらめきが立ちのぼる間を見せてから畳む
      if (sweep.after === undefined) {
        sweep.after = cs.afterglow;
        PP.fx.screenFlash("rgba(255,230,150,0.22)", 0.22, 500);
      }
      sweep.after -= dt;
      // 終点あたりから、まばらな金のきらめきが立ちのぼり続ける
      if (Math.random() < dt * 10) {
        var ap = sweep.parts[Math.floor(Math.random() * sweep.parts.length)];
        var pp = ap.lane.rail.posAt(Math.max(ap.to, PP.R));
        PP.fx.burst(pp.x + (Math.random() - 0.5) * 120, pp.y - Math.random() * 60,
                    Math.random() < 0.5 ? "#ffd24a" : "#fff3c0", 3, 1.2);
      }
      if (sweep.after <= 0) {
        sweep = null;
        levelClear();
      }
    }
  }

  // ---------- 【課題5-3】(模範解答つき)リトライの画面切り替え ----------
  // 【課題5】ライフを使った復帰: いまのステージを「最初から」やり直す。
  // レベル・スコア・コインはそのままで、チェーンだけ仕切り直しになる。
  //
  // 最初の実装は「startLevel() を呼ぶだけ」だった。それだと樽が溢れた次の
  // フレームには新しい盤面が出ていて、切り替わりが急すぎる。プレイヤーは
  // 「何が起きた? ライフは減った?」を確認する間がない。
  // そこで、切り替えを3拍子に分ける:
  //   拍1: その場で時が止まる(衝撃 + 静止。ミスした盤面を一瞬見せる)
  //   拍2: 暗転して「❤ 残りライフ」を確認させる
  //   拍3: 暗転の裏で盤面を組み直し、明転して再開
  // 各拍の長さは config.js の PP.RETRY で調整できる(TODO【課題5-3】)。
  //
  // 進行は「dt で減っていくタイマー + 状態(state)」の小さな仕組み。
  // state を "retrying" にすると、tick のプレイ処理(玉の移動・タイマー・危機)が
  // まるごと素通りになるので、拍1の間は盤面がその場で固まって見える。
  // これは課題5-2 の if/else と同じ「state で分岐する」考え方の応用。
  var retryFx = null;      // 暗転の幕とライフ表示(切り替え中だけ存在する)
  var retryPhase = "";     // "freeze"(拍1) → "veil"(拍2)
  var retryT = 0;          // いまの拍の残り秒

  // 拍1: 樽が溢れた衝撃。時を止めて、揺れと重い音でミスを体に伝える。
  // 警報はここで「ぶつ切り」にするが、危機の赤い帳はあえて残す
  // (赤いままの静止画面 = 「まずいことが起きた」がひと目で伝わる)
  function retryLevel() {
    var g = PP.game;
    g.state = "retrying";
    PP.audio.crisis(0);        // 警報だけ即切る。直後の静けさが「まずい」を語る
    PP.audio.setDanger(false);
    PP.audio.swallowed(1);     // 腹に来る重い衝撃音
    PP.fx.shake(60, 0.7);
    // 赤の二連明滅。1回だと瞬きで見逃すので、警報灯のように2度打つ
    PP.fx.screenFlash("rgba(255,46,46,0.5)", 0.5, 300);
    var pulse = new createjs.Shape();
    PP.layers.fx.addChild(pulse);
    createjs.Tween.get(pulse).wait(220).call(function () {
      PP.layers.fx.removeChild(pulse);
      PP.fx.screenFlash("rgba(255,46,46,0.35)", 0.35, 340);
    });
    // 飛んでいた玉は宙で消える(gameOver と同じ後始末)
    g.shots.forEach(function (s) { PP.layers.shot.removeChild(s.view); });
    g.shots = [];
    if (PP.skull) PP.skull.clear();   // 骸骨玉の妖弾も宙に残さない
    PP.hud.update();   // 右上の ❤ をこの時点で減らす(暗転の文字と食い違わないように)
    buildRetryVeil();
    retryPhase = "freeze";
    retryT = PP.RETRY.freeze;
  }

  // 暗転の幕と「❤ 残りライフ」を用意する。最初は透明で、拍2で現れる
  function buildRetryVeil() {
    removeRetryVeil();
    var c = new createjs.Container();
    c.mouseEnabled = false;
    var veil = new createjs.Shape();
    // 中央がわずかに明るい放射グラデーション(平坦な黒塗りより舞台の暗幕らしくなる)。
    // 画面が揺れている最中でも端がのぞかないように、一回り大きく塗る
    veil.graphics.beginRadialGradientFill(
      ["rgba(16,10,12,1)", "rgba(4,2,3,1)"], [0, 1],
      PP.W / 2, PP.H / 2, 120, PP.W / 2, PP.H / 2, PP.W * 0.72)
      .drawRect(-140, -140, PP.W + 280, PP.H + 280);
    veil.alpha = 0;
    c.addChild(veil);
    var texts = [];
    function line(str, dy, size, color) {
      var t = new createjs.Text(str,
        '800 ' + size + 'px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', color);
      t.textAlign = "center"; t.textBaseline = "middle";
      t.x = PP.W / 2; t.y = PP.H / 2 + dy;
      t.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 3, 8);
      t.alpha = 0;
      c.addChild(t);
      texts.push(t);
    }
    // 主役は「残りライフ」。案内文はその下に小さく(読む順番を大きさで作る)
    line(PP.i18n.t("main.retryLives", { n: PP.game.lives }), -22, 34, "#ff5d8f");
    line(PP.i18n.t("main.retrySub"), 30, 18, "#e6d3b8");
    // 2行のあいだの細い金の飾り線(オーバーレイのディバイダと同じ意匠)
    var div = new createjs.Shape();
    div.graphics.beginStroke("rgba(202,169,106,0.7)").setStrokeStyle(1.2)
      .moveTo(-90, 0).lineTo(90, 0);
    div.x = PP.W / 2; div.y = PP.H / 2 + 4;   // 拡大ポップしても中央からずれないよう原点基準で描く
    div.alpha = 0;
    c.addChild(div);
    texts.push(div);
    PP.stage.addChild(c);   // どのレイヤーよりも手前(HUDの上)に置く
    retryFx = { cont: c, veil: veil, texts: texts };
  }

  // 拍2: 暗転。危機の赤い帳はこの暗幕の下でこっそり畳み、
  // 「どくん」という一拍とともに残りライフを確認する「間」を作る
  function showRetryVeil() {
    if (!retryFx) return;
    PP.crisis.stop();          // stop() は即座に消えるので、暗転に隠れてから呼ぶ
    PP.audio.heartbeat();
    createjs.Tween.get(retryFx.veil).to({ alpha: PP.RETRY.veil }, 340);
    retryFx.texts.forEach(function (t, i) {
      t.scaleX = t.scaleY = 0.72;
      createjs.Tween.get(t).wait(160 + i * 130)
        .to({ alpha: 1, scaleX: 1.05, scaleY: 1.05 }, 200, createjs.Ease.backOut)
        .to({ scaleX: 1, scaleY: 1 }, 90);
    });
  }

  // 拍3: 暗転の裏で盤面を組み直してから明転する。
  // 組み直し(startLevel)を幕が開く前にやるのがポイント
  // (幕が透明なうちに組み直すと、玉が一瞬で消し替わるところが丸見えになる)
  function finishRetry() {
    skipIntroOnce = true;   // 暗幕からの明転が主役なので、イントロ演出は重ねない
    startLevel();       // state はこの中で "playing" に戻る
    PP.hud.update();
    var f = retryFx;
    retryFx = null;
    if (f) {
      createjs.Tween.get(f.cont)
        .to({ alpha: 0 }, PP.RETRY.fade * 1000)
        .call(function () { PP.stage.removeChild(f.cont); });
    }
    PP.fx.floatText(PP.i18n.t("main.retryGo"), PP.W / 2, 96, "#ff5d8f", 24);
  }

  // 切り替えの進行役。tick から state === "retrying" の間だけ呼ばれ、
  // タイマー(retryT)が切れるたびに次の拍へ進む
  function updateRetry(dt) {
    retryT -= dt;
    if (retryT > 0) return;
    if (retryPhase === "freeze") {
      retryPhase = "veil";
      retryT = PP.RETRY.veilTime;
      showRetryVeil();
    } else {
      finishRetry();
    }
  }

  function removeRetryVeil() {
    if (retryFx) { PP.stage.removeChild(retryFx.cont); retryFx = null; }
  }

  // 樽が溢れた。ここから先は gameover.js の演出に進行を預ける
  function gameOver() {
    var g = PP.game;
    g.state = "draining";
    PP.crisis.stop();   // 警報を止める。この直後の無音がゲームオーバーの合図
    // 飛んでいた玉は宙で消える(演出中は撃てないので置き去りにしない)
    g.shots.forEach(function (s) { PP.layers.shot.removeChild(s.view); });
    g.shots = [];
    if (PP.skull) PP.skull.clear();   // 骸骨玉の妖弾も置き去りにしない
    // 残っている宝玉は道連れに砕ける(全レーン)
    PP.chain.treasureList().forEach(function (t) {
      var p = t.lane.rail.posAt(Math.max(t.ball.d, 0));
      PP.fx.burst(p.x, p.y, "#c9a86a", 10);
    });
    PP.chain.clearTreasures();
    PP.gameover.start(finishGameOver);
  }

  // 演出が「暗黒」まで進んだら文字を出す(ここでクリック受付が復活する)。
  // 進路はパネル下の2ボタンで選ぶ: ⚓再挑戦(コンティニュー: この海域から
  // スコア0・ライフ全回復・強化維持)/ 🏠タイトルへ(ランを畳む)
  function finishGameOver() {
    var g = PP.game;
    g.state = "over";
    PP.hud.showOverlay(PP.i18n.t("main.overTitle"),
      PP.i18n.t("main.overBody", { score: g.score, level: g.level }),
      "doom");
  }

  // ---------- 低FPS検知(自動品質調整) ----------
  // 弱い端末では描画の cache 化を尽くしても足りないことがあるので、実測 FPS を
  // 見て「低負荷モード」(PP.quality = 0)へ自動で落とす保険。判定は
  //   ・瞬間値ではなく指数移動平均(PP.PERF.FPS_WINDOW 秒の時定数)
  //   ・入り(LOW_ENTER)と出(LOW_EXIT)でしきい値を分けたヒステリシス
  //   ・どちらも HOLD 秒続いたときだけ切り替え
  // の三段構えで、GC やコース組み直しの一瞬のスパイクではパタつかせない
  // (境界の往復振動を嫌う作りは crisis.js の bgmRelease と同じ思想)。
  // 低負荷モードで削るもの: fx.particles の破片数・crisis の滴りと走査ノイズ・
  // background の光の塵(内訳は config.js の PP.PERF.LOW)
  var fpsAvg = 60, qualHold = 0;
  PP.quality = 1;
  // 保存された画質設定(settings.js / PP.PERF.userQuality)を起動時から反映する
  if (PP.PERF.userQuality === "low") PP.quality = 0;
  // FPS の指数移動平均は品質自動調整と ?fps=1 の計測表示が共用する。
  // PERF.AUTO を切っても計測表示が生きるよう、平均の更新は判定から分離してある
  function updateFpsAvg(rawDt) {
    if (rawDt <= 0) return;
    fpsAvg += (1 / rawDt - fpsAvg) * Math.min(1, rawDt / PP.PERF.FPS_WINDOW);
  }
  function updateQuality(rawDt) {
    // ユーザーが画質を固定している(設定パネルで 高/低 を選択)なら自動調整は休む。
    // 毎フレームの代入で、設定変更が次のフレームから確実に効く
    var ovr = PP.PERF.userQuality;
    if (ovr && ovr !== "auto") { PP.quality = ovr === "low" ? 0 : 1; return; }
    if (!PP.PERF.AUTO || rawDt <= 0) return;
    var P = PP.PERF;
    if (PP.quality === 1 && fpsAvg < P.LOW_ENTER) {
      qualHold += rawDt;
      if (qualHold >= P.HOLD) { PP.quality = 0; qualHold = 0; }
    } else if (PP.quality === 0 && fpsAvg > P.LOW_EXIT) {
      qualHold += rawDt;
      if (qualHold >= P.HOLD) { PP.quality = 1; qualHold = 0; }
    } else {
      qualHold = 0;   // しきい値の内側に戻ったら数え直し
    }
  }

  // ---------- FPS計測表示(?fps=1)----------
  // 実機での軽量化の効果測定用。計測表示そのものが負荷にならないよう、
  //   ・Shadow なしの素の Text 1 個(stage 直下=全レイヤーより上)
  //   ・0.25 秒間引き+文字列が変わったときだけ text 代入(hud.js と同じ dirty 方式)
  // で描く。玉数は「いま何個抱えて重いのか」の文脈を掴むために添える。
  var fpsText = null, fpsMeterAcc = 0, fpsMeterStr = "";
  var fpsBallCount = 0;
  function countLaneBalls(lane) { fpsBallCount += lane.balls.length; }
  function buildFpsMeter() {
    fpsText = new createjs.Text("", 'bold 13px "Consolas","Menlo",monospace', "#7fffd4");
    fpsText.x = 8; fpsText.y = PP.H - 22;
    fpsText.mouseEnabled = false;
    stage.addChild(fpsText);
  }
  function updateFpsMeter(rawDt) {
    if (!fpsText) return;
    fpsMeterAcc += rawDt;
    if (fpsMeterAcc < 0.25) return;
    fpsMeterAcc = 0;
    fpsBallCount = 0;
    PP.game.eachLane(countLaneBalls);
    var s = "FPS " + fpsAvg.toFixed(1) + " | Q" + PP.quality + " | balls " + fpsBallCount;
    // ボス戦中は妖弾数も添える(弾数上限 bulletMax・プールの調整用)
    if (PP.boss && PP.boss.isActive()) s += " | orbs " + PP.boss.getBulletCount();
    if (s !== fpsMeterStr) { fpsMeterStr = s; fpsText.text = s; }
  }

  // tick 内で eachLane へ渡すループ本体。無名関数のまま渡すと毎フレーム
  // クロージャの確保が起きて GC のゴミになるので、モジュールスコープへ
  // 巻き上げる(ループの結果はモジュール変数 deadLaneFound で受け取る)
  function recordLeadD(lane) {
    if (lane.balls.length) lane.leadD = lane.balls[0].d;
  }
  var deadLaneFound = null;
  function findDeadLane(lane) {
    if (lane.balls.length > 0 &&
        lane.balls[0].d >= lane.rail.holeD + PP.D * PP.barrelCap()) {
      deadLaneFound = lane; return false;
    }
  }

  // ---------- メインループ ----------
  var pauseDrawn = false;   // ポーズ画面を描き終えたか(tick 冒頭参照)
  function tick(e) {
    // FPS の平均と計測表示はポーズ中も更新する(ポーズ画面の描画負荷も見たい)
    var rawDt = e.delta / 1000;
    updateFpsAvg(rawDt);
    updateFpsMeter(rawDt);
    // ポーズ(停泊)中はゲームの一切を進めない。盤面は完全に静止しているので
    // 最初の1フレーム(オーバーレイの表示)だけ描いたら以後の再描画をやめる。
    // 60fps で全画面を描き直し続けるとポーズ中でも端末が発熱するため。
    // ?fps=1 のときだけは計測表示を動かし続ける(ポーズ画面の負荷も見たい)。
    // pause() は showPause() → Ticker.paused の順なので、ここに来る最初の
    // フレームでオーバーレイは配置済み=1回の update で正しく写る(pause.js)
    if (PP.pauseCtl && PP.pauseCtl.active) {
      if (!pauseDrawn || fpsText) {
        stage.update(e);
        pauseDrawn = true;
      }
      return;
    }
    pauseDrawn = false;   // 解除されたら次のポーズでまた1回描く
    var dt = Math.min(e.delta / 1000, 0.05);
    var g = PP.game;
    updateQuality(rawDt);

    // マウス格納(Pointer Lock)の見張り。カード選択・クリア・ゲームオーバー等
    // 「カーソルで押す画面」へ移った瞬間に返上する(input.js watchLock)
    PP.input.watchLock();

    if (g.state === "playing") {
      PP.input.update(dt);
      if (g.comboTimer > 0) {
        g.comboTimer -= dt;
        if (g.comboTimer <= 0) { g.combo = 0; PP.hud.update(); }
      }
      PP.chain.update(dt);         // 全レーンのチェーンを更新
      // 先頭球の位置を毎フレーム控える(クリア時の爆発走査の終点になる)
      g.eachLane(recordLeadD);
      PP.cannon.updateShots(dt);   // 命中時にその場でマッチ判定される
      PP.powerups.update(dt);
      // bossFx(addle/freeze)の減算は ↑ の powerups.update に一本化されている。
      // タイマー失効と同じフレーム内で照準の橋渡しエッジを張り直す(input.js)。
      // これが無いと検知が次フレームにずれ、間に届いた mousemove が旧写像で
      // 砲台を書いて一瞬跳ねることがある
      PP.input.syncEdges();
      PP.upgrades.update(dt);      // 【強化】自動機銃・自動装填・手詰まり救済
      // 骸骨玉の弾幕(通常コースのみ。ボス戦は boss.js の弾幕があるので出さない)
      if (!g.bossMode && PP.skull) PP.skull.update(dt);
      PP.hud.updateEffects();

      // ボス戦: クラーケンの移動・攻撃・状態異常タイマーを進め、
      // 撃破演出が終わっていたらクリアへ(生存ゲージの代わりの勝利条件)
      if (g.bossMode) {
        PP.boss.update(dt);
        if (PP.boss.consumeVictory()) levelClear();
      }

      // ゲームオーバー判定: いずれかのレーンで樽の許容個数を超えたら。
      // 許容個数は難易度で変わる(【課題1】config.js の barrelBonus → PP.barrelCap)
      // ボス戦も同じ: 補給が絶え間ない代わりに、樽を守れなければ負け
      deadLaneFound = null;
      g.eachLane(findDeadLane);
      var deadLane = deadLaneFound;
      if (deadLane) {
        // 【課題5-2】(模範解答つき) ライフが残っていればゲームオーバーの代わりに、
        // ライフを1つ使ってこのステージの最初からやり直す(スコアとコインは残る)。
        // 難易度「深海の悪魔」(useLives: false)は救済のない1発ゲームオーバー。
        // この if/else は完成品として入れてある。読み解いたら、次の問いを
        // 「予想 → 実際に書き換えて試す → 元に戻す」で確かめよう(答えはガイド 5-3):
        //   Q1. && の左右(useLives の条件と g.lives > 0)を入れ替えても同じ動き?
        //   Q2. g.lives > 0 を g.lives >= 0 にすると、何が壊れる?
        //   Q3. g.lives-- を retryLevel() の「後」に動かすと、画面のどこがおかしくなる?
        // (コインでライフを増やす処理は powerups.js の【課題5-1】= あちらは自分で書く)
        if (PP.diff().useLives !== false && g.lives > 0) {
          g.lives--;
          g.failStreak++;   // 連続失敗を数える(ピティドロップ用。クリアで0へ)
          retryLevel();
        } else {
          gameOver();
        }
      }

      // 生存ゲージ(ロールアウト完了後から減る)。空になったら掃討フェーズへ。
      // ボス戦にはゲージが無い(勝利条件はボスの HP)ので減らさない
      if (g.state === "playing" && !g.bossMode && g.rolloutDone && !g.finishing) {
        g.timeLeft -= dt;
        if (g.timeLeft <= 0) {
          g.timeLeft = 0;
          startFinishing();
        }
      }
      // 掃討完了: 補給が尽きて、全レーンの玉も無くなったら、まず空中に残った
      // アイテム(💎・コイン・パワーアップ)をプレイヤーに取らせる。全部
      // 取る/落ちるのを待ってから、樽から先頭跡まで爆発が駆け抜ける距離
      // ボーナス(Zuma 式のクリア演出)を経てクリアへ。アイテムは重力で必ず
      // 画面外へ落ちる(💎 だけは powerups が自動回収する)ので、待ちは詰まらない
      if (g.state === "playing" && g.finishing && allLanesEmpty() && !sweep) {
        if (PP.powerups.count() > 0) {
          if (!itemWaitHinted) {
            itemWaitHinted = true;
            PP.fx.floatText(PP.i18n.t("main.collectItems"), PP.W / 2, PP.H / 2 - 40, "#ffe08a", 26);
          }
        } else {
          startClearSweep();   // 走る距離が無ければその場で levelClear() が呼ばれる
        }
      }
      if (sweep && g.state === "playing") {
        updateSweep(dt);     // 走査が終わった tick で levelClear() が呼ばれる
      }

      if (g.state === "playing") {
        PP.crisis.update(dt);
        PP.cannon.syncColors();
      }
      // 【強化】💎 キャッチで積まれた選択の権利をここで消化する(遅延オープン)。
      // collect の瞬間に開かないのは、同フレーム直後の樽あふれ判定が state を
      // retrying/draining へ上書きし得るため。「まだ playing なら開く」が安全
      // (boss.consumeVictory と同じパターン)。リトライと重なった場合は権利が
      // 保持され、明転後の最初の playing フレームでここが開く。
      if (g.state === "playing" && PP.upgrades.pendingChoice()) {
        PP.upgrades.openChoice();
      }
    } else if (g.state === "intro") {
      // コース開始イントロ。ゲームプレイ更新は一切呼ばない(玉はまだ流れない)
      updateIntro(dt);
    } else if (g.state === "choosing") {
      // 【強化】宝玉の力の3択中。ゲームプレイ更新を一切呼ばない=盤面・弾・
      // アイテム・タイマーが全部その場で凍る(retrying と同じ考え方)。
      // 背景・パーティクル・カードの Tween は下の共通処理で動き続ける
      PP.upgrades.updateChoice(dt);
    } else if (g.state === "retrying") {
      updateRetry(dt);   // リトライの画面切り替え(【課題5-3】)。終わると playing に戻る
    } else if (g.state === "draining" || g.state === "over") {
      PP.gameover.update(dt);
    }

    PP.bg.update(dt);          // 動く背景(波・光条・霧・きらめき・遠雷)
    PP.courseView.updateRailFlow(dt);   // 溝を流れる光(作画は course-view.js)
    PP.fx.updateShake(dt);
    PP.fx.updateParticles(dt);   // プール式パーティクルの前進(fx.js)
    PP.cannon.updateHurt(dt);    // 被弾後の無敵の点滅(非プレイ時は自動で解除される)
    PP.cannon.updateAim(dt);   // dt は望遠鏡の着弾走査(firstHitY)の間引きに使う
    PP.cannon.updateGuide(dt);   // 砲の真上の現在位置ガイド(格納中のカーソル代役)

    renderChains();

    stage.update(e);
  }

  // 掃討フェーズの完了判定: 全レーンで玉が尽き、補給も終わっているか
  function allLanesEmpty() {
    var empty = true;
    PP.game.eachLane(function (l) {
      if (l.balls.length !== 0 || l.pending !== 0 || l.needTreasure) { empty = false; return false; }
    });
    return empty;
  }

  // どこかのレーンに立体交差(橋)があるか。あれば玉の積み直しが要る。
  // 毎フレーム呼ぶのでコース構築時に PP.game.hasOverpass へメモしておく。
  function anyLaneHasOverpass() {
    var over = false;
    PP.game.eachLane(function (l) {
      if (l.rail.overIntervals.length > 0) { over = true; return false; }
    });
    return over;
  }

  // 玉1個の表示をレール上へ配置する(座標・割り込みスライド・樽沈み・回転・可視)。
  // 立体交差の上下判定に使う実効弧長 vd(= d + slide)を返す。
  var showSpin = true;   // 回転レイヤーを見せるか(renderChains が毎フレーム更新)
  function placeBall(b, rail) {
    // slide: 割り込みで押し広げられた分を遅れて追従。ins: 着弾点から枠へ滑り込む
    var vd = b.d + (b.slide || 0);
    var p = rail.posAtInto(Math.max(vd, 0), _pos);
    var vx = p.x, vy = p.y;
    if (b.ins) {
      var k = 1 - b.ins.t / PP.INSERT_TIME;
      k = 1 - (1 - k) * (1 - k);           // quadOut
      vx = b.ins.x + (p.x - b.ins.x) * k;
      vy = b.ins.y + (p.y - b.ins.y) * k;
      b.view.scaleX = b.view.scaleY = 1 + 0.3 * (1 - k);
    }
    // 樽に飲み込まれた分だけ小さく暗く沈める
    var depth = b.d - rail.holeD;
    if (depth > 0) {
      var t = Math.min(depth / SINK, 1);
      b.view.scaleX = b.view.scaleY = 1 - 0.45 * t;
      b.view.alpha = 1 - 0.45 * t;
    } else if (!b.ins && b.view.alpha !== 1) {
      b.view.scaleX = b.view.scaleY = 1;
      b.view.alpha = 1;
    }
    b.view.x = vx;
    b.view.y = vy;
    // 回転レイヤー(塗装の合わせ目)は低負荷モードでは隠す: 玉200個で描画
    // コールが 600→400 になる。base+shade は残すので立体感は保たれる。
    // visible をここで毎フレーム同期するので、auto の途中切替・プール再利用・
    // ユーザー設定変更のどの経路でも自動で追従する(大砲の装填玉は placeBall を
    // 通らないが 2〜3 個なので対象外)
    if (b.view.spin) {
      if (b.view.spin.visible !== showSpin) b.view.spin.visible = showSpin;
      if (showSpin) b.view.spin.rotation = vd * PP.SPIN_K;
    }
    // 洞窟の外側だけ非表示にする。トンネル内の玉は描画したままにする:
    // 覆い(tunnel 層は玉より上)が不透明なので自然に隠れ、覆いに開けた
    // 舷窓の穴からだけ覗く(撃てない判定は cannon.js が rail.tunnelAt で行う)。
    b.view.visible = vd > -PP.R;
    return vd;
  }

  // チェーンの描画反映(全レーンの玉を各レールへ配置。宝玉も同じ列の一員)。
  // 立体交差コースでは玉が橋の上下(ballOver/ballUnder)を行き来する。かつては
  // 毎フレーム両レイヤーを空にして積み直していたが、玉の追加/削除(ballsDirty)も
  // 層をまたぐ玉も無いフレームでは前フレームの並びがそのまま正しいので、その時だけ
  // 積み直す。積み直すときの手順・並び順は従来と完全に同じ。
  function renderChains() {
    var g = PP.game;
    var lanes = g.lanes;
    // 低負荷モードなら回転レイヤーを隠す(placeBall で毎フレーム同期)
    showSpin = PP.quality !== 0 || PP.PERF.LOW.ballSpin !== false;
    var canRestack = g.state === "playing" && g.hasOverpass;
    var needRestack = false;
    var li, bi, lane, balls, b, vd, target;

    // 配置しつつ、各玉の行き先レイヤーを判定する。
    // 立体交差:「上に来る帯」の玉は橋の桁より上(ballOver)、それ以外は下(ballUnder)。
    // 判定は玉半径ぶん広げた区間で行う。区間をそのまま使うと、玉の中心が橋の端を
    // 越えた瞬間に下の層へ落ちて、まだ桁に乗っている前半分が桁に欠かれてしまう。
    for (li = 0; li < lanes.length; li++) {
      lane = lanes[li]; balls = lane.balls;
      for (bi = 0; bi < balls.length; bi++) {
        b = balls[bi];
        vd = placeBall(b, lane.rail);
        target = lane.rail.heightAt(vd, PP.R) > 0 ? PP.layers.ballOver : PP.layers.ballUnder;
        b.layer = target;
        if (b.view.parent !== target) needRestack = true;
      }
    }

    if (canRestack) {
      if (needRestack || g.ballsDirty) {
        PP.layers.ballUnder.removeAllChildren();
        PP.layers.ballOver.removeAllChildren();
        for (li = 0; li < lanes.length; li++) {
          balls = lanes[li].balls;
          for (bi = 0; bi < balls.length; bi++) balls[bi].layer.addChild(balls[bi].view);
        }
        g.ballsDirty = false;
      }
    } else {
      // 交差なし/プレイ外は従来どおり必要な玉だけ移す(addChild は末尾追加なので
      // 並びが乱れうる。次にプレイ中の積み直しへ入ったとき直せるよう dirty を立てる)
      for (li = 0; li < lanes.length; li++) {
        balls = lanes[li].balls;
        for (bi = 0; bi < balls.length; bi++) {
          b = balls[bi];
          if (b.view.parent !== b.layer) { b.layer.addChild(b.view); g.ballsDirty = true; }
        }
      }
    }
  }

  // ---------- 外部 API(コースエディタ / course-api.js が使う) ----------
  PP.playCourse = function (course) {
    var g = PP.game;
    g.customCourse = course || null;
    g.level = 1;
    if (PP.editor && PP.editor.active) PP.editor.close();
    if (PP.hud && PP.hud.hideOverlay) PP.hud.hideOverlay();
    PP.upgrades.closeChoice();   // 【強化】3択の途中で試遊が始まったときの保険
    startLevel();
  };
  // レールと洞窟・樽だけを組み直す(玉は並べ直さない)。エディタのプレビュー用。
  PP.previewCourse = function (course) { buildCourse(course); };
  // 【課題5】の復帰(ステージ最初からやり直し)。main.js 内では retryLevel() で呼べる
  PP.retryLevel = retryLevel;
  // コース開始イントロのスキップ(input.js がタップで呼ぶ)
  PP.skipIntro = finishIntro;

  // タイトル画面の表示(起動時の音源読み込み完了後と、ゲームオーバーからの帰還で共用)
  function showTitle() {
    PP.game.state = "title";
    PP.hud.showOverlay(PP.i18n.t("main.titleTitle"),
      PP.i18n.t(PP.TOUCH ? "main.titleTouch" : "main.titleMouse"));
  }

  // 言語切り替え時: いま開いているオーバーレイの文言を貼り替える。
  // 切り替えボタンが出るのはタイトル / 全制覇画面だけなので、この2枚だけ見ればよい
  PP.i18n.onChange(function () {
    var st = PP.game.state;
    if (st === "title") showTitle();
    else if (st === "gameclear") showGameClear();
  });

  // ゲームオーバー画面の「🏠 タイトルへ戻る」(input.js が呼ぶ)。
  // ランを完全に畳む(スコア・コイン・強化・コンティニュー記録・試遊コース)
  PP.returnToTitle = function () {
    var g = PP.game;
    PP.gameover.reset();     // 暗幕・渦・ドクロを片付ける
    PP.crisis.reset();
    g.customCourse = null;   // 試遊中の自作コースも畳んで通常進行へ
    g.builtCourse = null;    // 次の出航で必ずレールを組み直す
    g.level = DBG_LEVEL || 1;
    g.score = 0;
    g.coins = 0;
    g.lives = PP.LIFE.startLives;
    g.continues = 0;
    g.continueStages = [];
    g.failStreak = 0;
    PP.upgrades.onRunReset();
    PP.audio.gameStart();    // ゲームオーバー曲から通常曲へ戻す
    PP.hud.update();
    showTitle();
  };

  // ---------- 初期化 ----------
  function init() {
    stage = PP.stage = new createjs.Stage("gameCanvas");
    // スマホ/タブレット対応: タッチを CreateJS のマウスイベントに変換する。
    // これでタップが stagemousedown、指のドラッグが stagemousemove として
    // input.js に届く。入力側はタッチとマウスの操作体系を分けて扱う。
    if (createjs.Touch.isSupported()) createjs.Touch.enable(stage);  // シングルタッチで十分

    // 玉は立体交差・トンネルのために層を分ける:
    //   bridgeUnder(橋の落ち影・アーチ・橋脚)→ ballUnder(橋の下/道の玉)
    //   → bridge(石橋の桁)→ ballOver(橋の上の玉)
    //   → tunnel(トンネルの覆い=玉を隠す) → barrel(樽の手前)
    //
    // bridgeUnder が path と別の層である理由: 橋の構造を path に描くと、あとから
    // 描かれる別レーンの道が橋の落ち影やアーチの暗がりを上塗りしてしまい、
    // 「橋が下の道に影を落としていない」= 浮いて見えない絵になる。全レーンの道より
    // 上・すべての玉より下に置くことで、影は道に落ち、玉はアーチの中に見える。
    PP.layers = {
      path: new createjs.Container(),
      railFlow: new createjs.Container(),  // 溝を流れる光(玉より下、レールより上)
      bridgeUnder: new createjs.Container(), // 橋の落ち影・水面の反射・アーチ・橋脚
      ballUnder: new createjs.Container(),
      bridge: new createjs.Container(),   // 橋の桁(下の道の玉を隠す遮蔽)
      ballOver: new createjs.Container(),
      tunnel: new createjs.Container(),   // トンネルの覆い(区間内の玉を隠す)
      barrel: new createjs.Container(),   // 樽の手前側(玉より上)
      shot: new createjs.Container(),
      item: new createjs.Container(),
      fx: new createjs.Container(),
      cannon: new createjs.Container(),
      crisis: new createjs.Container(),   // 危機の赤い帳(盤面の上、HUDの下)
      doom: new createjs.Container(),     // ゲームオーバーの暗幕(盤面の上、HUDの下)
      hud: new createjs.Container(),
      overlay: new createjs.Container()
    };
    stage.addChild(PP.layers.path, PP.layers.railFlow, PP.layers.bridgeUnder,
      PP.layers.ballUnder, PP.layers.bridge, PP.layers.ballOver,
      PP.layers.tunnel, PP.layers.barrel,
      PP.layers.shot, PP.layers.item, PP.layers.fx, PP.layers.cannon,
      PP.layers.crisis, PP.layers.doom, PP.layers.hud, PP.layers.overlay);
    PP.layers.railFlow.mouseEnabled = false;
    PP.layers.bridgeUnder.mouseEnabled = false;
    PP.layers.bridge.mouseEnabled = false;
    PP.layers.tunnel.mouseEnabled = false;
    PP.layers.fx.mouseEnabled = false;
    PP.layers.crisis.mouseEnabled = false;
    PP.layers.doom.mouseEnabled = false;
    // 玉・レール・弾・アイテムの層もマウス走査から外す。ゲーム入力はすべて
    // stage レベルのイベント(input.js の stagemousedown / stagemousemove)で
    // 受けており、これらは子のヒットテストを必要としない。EaselJS のヒット
    // テストは対象を 1px のキャンバスへ実際に描いて判定する高価な処理で、
    // 有効なままだとタップのたびに盤面の全玉(×3 Bitmap)を走査していた。
    // mouseChildren=false も付けて走査が子へ降りること自体を止める。
    // (hud / overlay / cannon はボタン類の可能性を考えて触らず残す。
    //  エディタは自前の Container にリスナーを張るので影響しない)
    var deaf = ["path", "ballUnder", "ballOver", "barrel", "shot", "item"];
    for (var di = 0; di < deaf.length; di++) {
      PP.layers[deaf[di]].mouseEnabled = false;
      PP.layers[deaf[di]].mouseChildren = false;
    }

    PP.bg.build();
    // デバッグ: index.html?level=3 のように URL で開始レベルを指定できる。
    // 指定中はゲームオーバー後もそのレベルから再開する(DBG_LEVEL)。
    var dbgLevel = parseInt(new URLSearchParams(location.search).get("level"), 10);
    if (dbgLevel >= 1) { PP.game.level = dbgLevel; DBG_LEVEL = dbgLevel; }
    // 開始レベルのコースを組む(crisis/gameover は build 前なので relocate は空振り、
    // このあとの build が新しいレールを直接読む)
    PP.game.builtCourse = PP.COURSES[courseForLevel(PP.game.level)];
    buildCourse(PP.game.builtCourse);
    PP.crisis.build();
    PP.gameover.build();
    PP.cannon.build();
    PP.hud.build();
    PP.hud.buildOverlay();

    // 音源を読み終えてからタイトルを出す。
    PP.game.state = "loading";
    PP.hud.showOverlay(PP.i18n.t("main.loadingTitle"), PP.i18n.t("main.loading"));
    PP.audio.preload(
      function (loaded, total) {
        PP.hud.showOverlay(PP.i18n.t("main.loadingTitle"),
          PP.i18n.t("main.loadingN", { loaded: loaded, total: total }));
      },
      function () {
        showTitle();
      }
    );

    // 入力状態とイベント配線は input.js に集約する。ゲーム進行に必要な
    // コールバックだけを渡し、入力モジュールから main の内部状態へは触れさせない。
    PP.input.attach(stage, {
      startLevel: startLevel,
      restartLevel: function () { return DBG_LEVEL || 1; }
    });

    // タブ復帰時の巨大 delta を Ticker 側で丸める。tick の dt だけでなく
    // TweenJS(同じ tick イベントで進む)にも効くので、位相機械(dt駆動)と
    // Tween(演出)の進行がタブ切替でズレなくなる(EaselJS 1.0 の maxDelta)
    if ("maxDelta" in createjs.Ticker) createjs.Ticker.maxDelta = 50;
    // 120Hz/144Hz 画面の端末では素の RAF だと毎秒 120 回 tick+全描画が走り、
    // それだけで 60Hz 端末の倍の描画負荷になる(ミドル帯スマホに多い構成)。
    // RAF_SYNCHED は rAF の拍に同期したまま目標 FPS へ間引くモードで、
    // 60Hz 画面では実質無変化。dt 駆動なのでゲームの進行速度も変わらない。
    // 万一ジャダーが出た端末の切り分け用に ?hz=raf で従来挙動へ戻せる。
    if (new URLSearchParams(location.search).get("hz") === "raf") {
      createjs.Ticker.timingMode = createjs.Ticker.RAF;
    } else {
      createjs.Ticker.timingMode = createjs.Ticker.RAF_SYNCHED;
      createjs.Ticker.framerate = 60;
    }
    // デバッグ: index.html?fps=1 で左下に FPS / 品質 / 玉数の計測表示を出す
    if (new URLSearchParams(location.search).get("fps")) buildFpsMeter();
    createjs.Ticker.on("tick", tick);
    // headless smoke test でも確認できる、全同期初期化の完了マーカー。
    // audio preload の完了前でも stage・各モジュール・入力配線は利用可能になっている。
    document.documentElement.setAttribute("data-pp-ready", "true");
  }

  if (typeof createjs !== "undefined") init();
})();
