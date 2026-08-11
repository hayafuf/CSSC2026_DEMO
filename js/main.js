/* =========================================================
 * main.js — 初期化・ゲーム進行・メインループ・入力
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
      lane.balls.forEach(function (b) { if (b.view.parent) b.view.parent.removeChild(b.view); });
      lane.balls = [];
      lane.recoil = null;
      lane.wave = 0;
      lane.pending = 0;
      lane.needTreasure = false;
      lane.waveFresh = false;
      lane.waveTimer = 0;
      lane.pendingMatches = [];
    });
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
    // 骸骨玉の弾・墨と状態異常を仕切り直す(リトライ・再出航もここを通る)。
    // ボス戦は boss.setActive → reset → clearStatusFx が別途ゼロ化するが、
    // 通常コースはここが唯一のリセット地点になる
    if (PP.skull) PP.skull.clear();
    var bfx = g.bossFx;
    for (var bk in bfx) bfx[bk] = 0;

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
    // 最初の波の SE(startWave 内)は state が playing のときだけ鳴るので、
    // 波を出す前に確定させておく
    g.state = "playing";
    // 全レーンで最初の波を湧かせる
    g.lanes.forEach(function (lane) { PP.chain.startWave(lane); });

    g.currentColor = Math.floor(Math.random() * g.nColors);
    // 開始時から手札が同じ色2個にならないようにする
    g.nextColor = (g.currentColor + 1 + Math.floor(Math.random() * (g.nColors - 1))) % g.nColors;
    PP.cannon.refreshBalls();

    PP.hud.update();
  }

  // 生存ゲージが空になった瞬間。補給を打ち切り、残りの掃討に入る
  function startFinishing() {
    var g = PP.game;
    g.finishing = true;
    PP.audio.timeOver();      // 生存ゲージの時間切れ(掃討フェーズ移行)
    PP.fx.floatText("補給が止まった! 残りを掃討せよ!", PP.W / 2, 96, "#8ef0d0", 24);
  }

  function levelClear() {
    var g = PP.game;
    var total = PP.COURSES.length;
    // 最終ステージ(自作コースのプレイ中は除く)ならゲームクリア
    var isFinal = !g.customCourse && g.level >= total;
    g.score += 1000;
    if (PP.skull) PP.skull.clear();   // クリア画面に妖弾・墨を固めて残さない
    PP.crisis.stop();          // 警報と赤い帳を畳む
    PP.audio.setDanger(false);
    PP.audio.clear();
    if (isFinal) {
      g.state = "gameclear";
      g.score += 5000;         // 全海域制覇ボーナス
      PP.hud.update();
      PP.hud.showOverlay(g.bossMode ? "🏆 クラーケン討伐! 全海域制覇!" : "🏆 全海域制覇!",
        "全 " + total + " ステージを生き延びた! 秘宝は我らのものだ!\n" +
        "制覇ボーナス +5000\n最終スコア " + g.score + " 点\n" + PP.TAP + "で最初の海へ");
      return;
    }
    g.state = "clear";
    PP.hud.update();
    // 次がボス海域なら、ただの「次のステージへ」ではなく最終決戦の前口上にする
    var next = PP.COURSES[courseForLevel(g.level + 1)];
    if (next && next.boss) {
      // 最終決戦の前口上 + 倒し方の要点(ボス戦はここまでのルールと勝利条件が
      // 違うので、突入前に必ず一度は目に入る場所で教える)
      PP.hud.showOverlay("⚓ ステージ " + g.level + "/" + total + " 制覇!",
        "生存ボーナス +1000 / スコア " + g.score + " 点 ――深淵の主が目を覚ました…\n" +
        "🎯 クラーケンの頭に玉を当てて HP を削り切れば勝利!\n" +
        "⚡ 予兆(チャージ)中に当てれば攻撃を阻止できる\n" +
        "🛡 妖弾は自弾で迎撃できる(ミサイルは貫通)。樽への玉列も守り続けろ!\n" +
        PP.TAP + "で最終決戦へ");
    } else {
      PP.hud.showOverlay("⚓ ステージ " + g.level + "/" + total + " 制覇!",
        "耐え切って残りも掃討した! 生存ボーナス +1000\nスコア " + g.score + " 点\n" + PP.TAP + "で次のステージへ");
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
    line("❤ 残りライフ " + PP.game.lives, -22, 34, "#ff5d8f");
    line("同じ海域の最初から再挑戦", 30, 18, "#e6d3b8");
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
    startLevel();       // state はこの中で "playing" に戻る
    PP.hud.update();
    var f = retryFx;
    retryFx = null;
    if (f) {
      createjs.Tween.get(f.cont)
        .to({ alpha: 0 }, PP.RETRY.fade * 1000)
        .call(function () { PP.stage.removeChild(f.cont); });
    }
    PP.fx.floatText("❤ ライフを使って再挑戦!", PP.W / 2, 96, "#ff5d8f", 24);
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

  // 演出が「暗黒」まで進んだら文字を出す(ここでクリック受付が復活する)
  function finishGameOver() {
    var g = PP.game;
    g.state = "over";
    PP.hud.showOverlay("☠ ゲームオーバー",
      "船は宝もろとも呑まれた…\n最終スコア " + g.score + " 点 (ステージ " + g.level + ")\n" + PP.TAP + "でリスタート",
      "doom");
  }

  // ---------- メインループ ----------
  function tick(e) {
    // ポーズ(停泊)中はゲームの一切を進めない。描画だけ更新して、
    // ポーズ画面の表示とクリック(解除)を受け付ける
    if (PP.pauseCtl && PP.pauseCtl.active) {
      stage.update(e);
      return;
    }
    var dt = Math.min(e.delta / 1000, 0.05);
    var g = PP.game;

    if (g.state === "playing") {
      // 携帯の ◀▶ ボタン: 短押しは低速で微調整、押し続けると加速して横断も速い
      if (touchMoveDir) {
        touchMoveHeld += dt;
        var mv = TOUCH_MOVE_V0 + (TOUCH_MOVE_V1 - TOUCH_MOVE_V0) *
                 Math.min(1, touchMoveHeld / TOUCH_MOVE_RAMP);
        // ボスの Addle!!(操作反転)中は ◀▶ ボタンの向きも反転する
        var tDir = g.bossFx.addle > 0 ? -touchMoveDir : touchMoveDir;
        PP.cannon.setX(PP.cannon.x + tDir * mv * dt);
      } else {
        touchMoveHeld = 0;
      }
      if (g.comboTimer > 0) {
        g.comboTimer -= dt;
        if (g.comboTimer <= 0) { g.combo = 0; PP.hud.update(); }
      }
      PP.chain.update(dt);         // 全レーンのチェーンを更新
      PP.cannon.updateShots(dt);   // 命中時にその場でマッチ判定される
      PP.powerups.update(dt);
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
      var deadLane = null;
      g.eachLane(function (lane) {
        if (lane.balls.length > 0 &&
            lane.balls[0].d >= lane.rail.holeD + PP.D * PP.barrelCap()) {
          deadLane = lane; return false;
        }
      });
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
      // 掃討完了: 補給が尽きて、全レーンの玉も無くなったらクリア
      if (g.state === "playing" && g.finishing && allLanesEmpty()) {
        levelClear();
      }

      if (g.state === "playing") {
        PP.crisis.update(dt);
        PP.cannon.syncColors();
      }
    } else if (g.state === "retrying") {
      updateRetry(dt);   // リトライの画面切り替え(【課題5-3】)。終わると playing に戻る
    } else if (g.state === "draining" || g.state === "over") {
      PP.gameover.update(dt);
    }

    PP.bg.update(dt);          // 動く背景(波・光条・霧・きらめき・遠雷)
    PP.courseView.updateRailFlow(dt);   // 溝を流れる光(作画は course-view.js)
    PP.fx.updateShake(dt);
    PP.fx.updateParticles(dt);   // プール式パーティクルの前進(fx.js)
    PP.cannon.updateAim();

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
    if (b.view.spin) b.view.spin.rotation = vd * PP.SPIN_K;
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
    startLevel();
  };
  // レールと洞窟・樽だけを組み直す(玉は並べ直さない)。エディタのプレビュー用。
  PP.previewCourse = function (course) { buildCourse(course); };
  // 【課題5】の復帰(ステージ最初からやり直し)。main.js 内では retryLevel() で呼べる
  PP.retryLevel = retryLevel;

  // ---------- 入力 ----------
  // タッチ操作は画面の仮想ボタン(index.html の #touchUI)に一本化:
  //   ◀ ▶ ボタン(押しっぱなし) … 大砲の移動(押し続けると加速)
  //   FIRE ボタン               … 発射(長押しで連射)
  //   ⇄ ボタン / 大砲をタップ  … 玉の交換
  // 盤面を指で触っても大砲は動かない(誤操作防止。ボタンだけで遊ぶ)。
  // マウスは従来どおり「動かして照準、クリックした瞬間に発射」。
  var touchAiming = false;   // タッチで盤面に触れている最中か(大砲タップ交換の判定用)
  var touchDownX = 0, touchDownT = 0, touchOnCannon = false;
  var touchMoveDir = 0;               // ◀▶ ボタンで押されている方向(-1/0/+1)
  var TOUCH_MOVE_V0 = 600;            // ◀▶ 押し始めの速さ px/s(微調整用)
  var TOUCH_MOVE_V1 = 1800;           // ◀▶ 押し続けたときの最高速 px/s
  var TOUCH_MOVE_RAMP = 0.45;         // 最高速に達するまでの秒数
  var touchMoveHeld = 0;              // ◀▶ を押し続けている秒数
  function isTouchEv(e) {
    var n = e && e.nativeEvent;
    return !!(n && n.type && n.type.indexOf("touch") === 0);
  }

  // ボスの Addle!!(操作反転)中は、マウスの狙い位置を左右反転して返す。
  // cannon.setX の中ではなくマウス入力の入り口で反転する: ◀▶ ボタンは
  // 「今の位置 + 差分」で setX を呼ぶので、setX 内で反転すると毎フレーム
  // 鏡写しに往復するフィードバックになってしまう(あちらは tick 側で反転)。
  function aimStageX(sx) {
    return PP.game.bossFx.addle > 0 ? PP.W - sx : sx;
  }

  function onStageDown(e) {
    if (PP.editor && PP.editor.active) return;
    if (e.nativeEvent && e.nativeEvent.button === 2) return;   // 右ボタンは交換専用
    var g = PP.game;
    if (g.state === "loading") return;
    PP.audio.unlock();
    // ポーズ中のクリックは「再開」専用。このクリックで発射はしない
    if (PP.pauseCtl && PP.pauseCtl.active) {
      PP.pauseCtl.resume();
      return;
    }
    // 難易度ボタン(【課題1】)のクリックを先に調べる。難易度は「1回の出航」単位
    // なので、ボタンが出る画面(タイトル/ゲームオーバー/全制覇後)でだけ当たる。
    // ボタンに当たったら難易度を変えるだけで、ゲームは始めない。
    var diffHit = PP.hud.hitDifficulty(e.stageX, e.stageY);
    if (diffHit) {
      g.difficulty = diffHit;
      PP.hud.setDifficulty(diffHit);
      return;
    }
    if (g.state === "title") {
      PP.hud.hideOverlay();
      startLevel();
    } else if (g.state === "playing") {
      // ⏸ ボタンへのクリックは発射ではなくポーズ
      if (PP.hud.hitPauseBtn(e.stageX, e.stageY)) {
        PP.pauseCtl.pause("manual");
        return;
      }
      // ⇄ 交換ボタン(タッチ端末用。右クリック/Space の代わり)は発射ではなく交換
      if (PP.hud.hitSwapBtn(e.stageX, e.stageY)) {
        PP.cannon.swap();
        return;
      }
      // 特殊弾ストックスロットへのクリックは発射ではなく交換
      if (PP.cannon.hitStock(e.stageX, e.stageY)) {
        PP.cannon.toggleSpecial();
        return;
      }
      if (isTouchEv(e)) {
        // タッチで盤面を触っても大砲は動かさない(操作は ◀▶/FIRE/⇄ ボタン)。
        // 「大砲を動かさず短くタップ」だけは玉交換の合図として拾う(stagemouseup 側)
        touchAiming = true;
        touchDownX = e.stageX; touchDownT = Date.now();
        touchOnCannon = Math.abs(e.stageX - PP.cannon.x) < 80 && e.stageY > PP.cannon.y - 90;
      } else {
        PP.cannon.setX(aimStageX(e.stageX));
        PP.cannon.fire();
      }
    } else if (g.state === "clear") {
      g.level++;
      PP.hud.hideOverlay();
      startLevel();
    } else if (g.state === "gameclear") {
      // 全ステージ制覇。スコアを畳んで最初の海からもう一周
      g.level = DBG_LEVEL || 1;       // ?level=N のデバッグ中は同じレベルから再開
      g.score = 0;
      g.coins = 0;
      g.lives = PP.LIFE.startLives;   // 新しいランは所持ライフから始まる【課題5】
      PP.hud.hideOverlay();
      startLevel();
    } else if (g.state === "over") {
      g.level = DBG_LEVEL || 1;       // ?level=N のデバッグ中は同じレベルから再開
      g.score = 0;
      g.coins = 0;
      g.lives = PP.LIFE.startLives;   // 新しいランは所持ライフから始まる【課題5】
      PP.hud.hideOverlay();
      startLevel();
    }
  }

  // ---------- 初期化 ----------
  function init() {
    stage = PP.stage = new createjs.Stage("gameCanvas");
    // スマホ/タブレット対応: タッチを CreateJS のマウスイベントに変換する。
    // これでタップが stagemousedown、指のドラッグが stagemousemove として届く
    // (タップ = その位置へ照準して発射。既存の onStageDown がそのまま使える)。
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
    PP.hud.showOverlay("🏴‍☠️ 海賊の秘宝", "音楽を読み込み中…");
    PP.audio.preload(
      function (loaded, total) {
        PP.hud.showOverlay("🏴‍☠️ 海賊の秘宝",
          "音楽を読み込み中… " + loaded + " / " + total);
      },
      function () {
        PP.game.state = "title";
        PP.hud.showOverlay("🏴‍☠️ Are you ready?",
          PP.TOUCH
            ? "タップで出航!\n◀ ▶ ボタンで大砲を移動(押し続けると加速)\nFIRE ボタンで発射(長押しで連射)、⇄ ボタンで玉を交換\n特殊弾は左下のスロットをタップで交換"
            : "クリックで出航!\nマウスで大砲を移動、クリックで発射\n右クリック / Space で玉を交換、M で消音\n特殊弾は左下のスロットをクリックで交換");
      }
    );

    stage.on("stagemousedown", onStageDown);
    // 盤面のタッチは離しても発射しない(発射は FIRE ボタン)。
    // 大砲の上で「動かさず短く」タップしたときだけ、玉の交換
    stage.on("stagemouseup", function (e) {
      if (!touchAiming) return;
      touchAiming = false;
      if (PP.game.state !== "playing") return;
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      var moved = Math.abs(e.stageX - touchDownX) > 24;
      var quick = Date.now() - touchDownT < 350;
      if (touchOnCannon && !moved && quick) PP.cannon.swap();
    });
    // 音の解錠の保険: ブラウザの自動再生制限は「ユーザー操作の中」でしか
    // 解けない。タッチ変換が効かない環境でも最初の1タップで確実に解く
    document.addEventListener("pointerdown", function () { PP.audio.unlock(); }, { once: true });

    // ---- 携帯用の操作ボタン(index.html の #touchUI)の配線 ----
    // 表示/非表示は CSS(pointer: coarse)が決めるので、ここでは配線だけ行う
    (function wireTouchButtons() {
      function canPlay() {
        return PP.game.state === "playing" && !(PP.pauseCtl && PP.pauseCtl.active);
      }
      // 押しっぱなしで効く移動ボタン。指が滑って外れても止まるように
      // pointercancel / lostpointercapture でも解除する
      function bindHold(id, dir) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          PP.audio.unlock();
          if (el.setPointerCapture) { try { el.setPointerCapture(ev.pointerId); } catch (e2) {} }
          touchMoveDir = dir;
        });
        function stop() { if (touchMoveDir === dir) touchMoveDir = 0; }
        el.addEventListener("pointerup", stop);
        el.addEventListener("pointercancel", stop);
        el.addEventListener("lostpointercapture", stop);
        el.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
      }
      // 押した瞬間に1回だけ効くボタン。ポーズ中は「再開」として働く
      function bindTap(id, action) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          PP.audio.unlock();
          if (PP.pauseCtl && PP.pauseCtl.active) { PP.pauseCtl.resume(); return; }
          if (canPlay()) action();
        });
        el.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
      }
      // FIRE は押した瞬間に1発 + 押しっぱなしで連射。指が滑って外れても止まる
      function bindFire(id) {
        var el = document.getElementById(id);
        if (!el) return;
        var timer = null;
        function stop() { if (timer) { clearInterval(timer); timer = null; } }
        el.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          PP.audio.unlock();
          if (PP.pauseCtl && PP.pauseCtl.active) { PP.pauseCtl.resume(); return; }
          if (!canPlay()) return;
          PP.cannon.fire();
          if (el.setPointerCapture) { try { el.setPointerCapture(ev.pointerId); } catch (e2) {} }
          stop();
          timer = setInterval(function () {
            if (!canPlay()) { stop(); return; }
            PP.cannon.fire();
          }, 180);
        });
        el.addEventListener("pointerup", stop);
        el.addEventListener("pointercancel", stop);
        el.addEventListener("lostpointercapture", stop);
        el.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
      }
      bindHold("tLeft", -1);
      bindHold("tRight", 1);
      bindFire("tFire");
      bindTap("tSwap", function () { PP.cannon.swap(); });
    })();

    stage.on("stagemousemove", function (e) {
      if (PP.pauseCtl && PP.pauseCtl.active) return;   // ポーズ中は大砲も動かさない
      if (isTouchEv(e)) return;   // タッチでは大砲を動かさない(◀▶ ボタンで移動)
      PP.cannon.setX(aimStageX(e.stageX));
    });
    // 右クリックで玉を交換(メニューは出さない)
    document.getElementById("gameCanvas").addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (PP.editor && PP.editor.active) return;   // エディタ中は右クリック=点の削除
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      PP.cannon.swap();
    });
    window.addEventListener("keydown", function (e) {
      if (PP.editor && PP.editor.active) return;   // エディタ中はゲームのキー操作を止める
      PP.audio.unlock();
      if (e.code === "KeyP") {
        // ポーズの切り替え(プレイ中のみ有効。pause.js 側でガードしている)
        if (PP.pauseCtl) PP.pauseCtl.toggle();
        return;
      }
      // ポーズ中は P 以外のゲーム操作を受け付けない
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      if (e.code === "Space") {
        e.preventDefault();
        PP.cannon.swap();
      } else if (e.code === "KeyM") {
        PP.fx.floatText(PP.audio.toggleMute() ? "🔇 消音" : "🔊 音あり",
          PP.W / 2, 88, "#f0e6c8", 22);
      } else if (/^Digit[1-4]$/.test(e.code)) {
        // 1〜4 キーでも難易度(【課題1】)を選べる。難易度ボタンが出ている画面
        // (タイトル/ゲームオーバー/全制覇後)だけ有効。ステージの合間は変えられない
        var st = PP.game.state;
        if (st === "title" || st === "over" || st === "gameclear") {
          var key = PP.DIFFICULTY_ORDER[parseInt(e.code.charAt(5), 10) - 1];
          if (key) {
            PP.game.difficulty = key;
            PP.hud.setDifficulty(key);
          }
        }
      }
    });

    createjs.Ticker.timingMode = createjs.Ticker.RAF;
    createjs.Ticker.on("tick", tick);
  }

  if (typeof createjs !== "undefined") init();
})();
