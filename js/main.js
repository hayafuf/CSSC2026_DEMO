/* main.js — ステージの初期化と、1フレームの更新・描画順序。
 * ゲーム進行はsession.js、玉の配置と描画順はchain-view.jsに委ねる。 */
(function () {
  "use strict";
  var PP = window.PP;

  var stage;

  var DBG_LEVEL = 0;  // ?level=N

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
  // ---- 上限FPS(Ticker.framerate)の切替 ----
  // 品質と上限FPSは対で動く: 通常品質=targetFps(タッチは TOUCH_CAP)、
  // 低負荷=LOW_CAP。?cap=NN で固定されたときは品質が変わっても上限を動かさない
  // (端末の切り分け用)。PP.PERF.curFps は「いまの上限」で、計測表示と
  // 復帰しきい値が参照する
  var capFixed = false;
  function applyCap(fps) {
    if (createjs.Ticker.timingMode === createjs.Ticker.RAF) return;
    PP.PERF.curFps = fps;
    if (createjs.Ticker.framerate !== fps) createjs.Ticker.framerate = fps;
  }
  function setQuality(q) {
    if (PP.quality === q) return;
    PP.quality = q;
    if (!capFixed) applyCap(q === 0 ? PP.PERF.LOW_CAP : PP.PERF.targetFps);
  }
  PP.setQuality = setQuality;   // settings.js の画質セグメントもここを通す
  function updateQuality(rawDt) {
    // ユーザーが画質を固定している(設定パネルで 高/低 を選択)なら自動調整は休む。
    // 毎フレームの代入で、設定変更が次のフレームから確実に効く
    var ovr = PP.PERF.userQuality;
    if (ovr && ovr !== "auto") { setQuality(ovr === "low" ? 0 : 1); return; }
    if (!PP.PERF.AUTO || rawDt <= 0) return;
    var P = PP.PERF;
    // しきい値は「いまの上限FPS」に対する割合(config.js の解説参照)。
    // 転落は通常上限(60)基準、復帰は低負荷上限(30)基準で見る。低負荷中は
    // 30 までしか刻めないので、60 基準のままだと復帰条件が永遠に満たせない
    if (PP.quality === 1 && fpsAvg < P.LOW_ENTER_RATIO * P.curFps) {
      qualHold += rawDt;
      if (qualHold >= P.HOLD) { setQuality(0); qualHold = 0; }
    } else if (PP.quality === 0 && fpsAvg > P.LOW_EXIT_RATIO * P.curFps) {
      qualHold += rawDt;
      if (qualHold >= P.HOLD * (P.EXIT_HOLD_MUL || 1)) { setQuality(1); qualHold = 0; }
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
    // 計測表示自身が負荷にならないよう固定領域で cache(更新は 0.25s に1回、
    // 文字列が変わったときだけ updateCache)
    fpsText.cache(-4, -4, 340, 26);
    stage.addChild(fpsText);
  }
  function updateFpsMeter(rawDt) {
    if (!fpsText) return;
    fpsMeterAcc += rawDt;
    if (fpsMeterAcc < 0.25) return;
    fpsMeterAcc = 0;
    fpsBallCount = 0;
    PP.game.eachLane(countLaneBalls);
    // cap=いまの上限FPS、fl=直近フレームの GPU flush(draw call)回数(gl-patch.js が
    // 数える。lighter⇔通常 の境界ごとに 1 回増えるので、背景/粒子の合成順の
    // まとまり具合を実機で確かめる指標)
    var s = "FPS " + fpsAvg.toFixed(1) + "/" + (PP.PERF.curFps || "-") +
            (PP.glActive ? " | GL fl" + (stage._ppFlushLast || 0) : " | 2D") +
            " | Q" + PP.quality + " | balls " + fpsBallCount;
    // ボス戦中は妖弾数も添える(弾数上限 bulletMax・プールの調整用)
    if (PP.boss && PP.boss.isActive()) s += " | orbs " + PP.boss.getBulletCount();
    if (s !== fpsMeterStr) { fpsMeterStr = s; fpsText.text = s; fpsText.updateCache(); }
  }

  // tick 内で eachLane へ渡すループ本体。無名関数のまま渡すと毎フレーム
  // クロージャの確保が起きて GC のゴミになるので、モジュールスコープへ
  // 巻き上げる(ループの結果はモジュール変数 deadLaneFound で受け取る)
  // 先頭球の位置を毎フレーム記録する(クリア走査の終点になる)。
  // 宝玉は除く: 宝玉はウェーブの末尾に付くので、色玉を全滅させた直後の
  // 数フレームは宝玉だけが balls[0] になる。それを拾うと走査が「宝玉の
  // いた場所」まで走ってしまうので、最初の非宝玉が見つかった時だけ更新する
  // (宝玉しか残っていないフレームでは直前の色玉先頭の値を保持)
  // ---------- メインループ ----------
  var pauseDrawn = false;   // ポーズ画面を描き終えたか(tick 冒頭参照)
  // タッチ端末のメニュー系画面(タイトル/ゲームオーバー/全クリア)は
  // 海背景が揺れているだけなので、描画を1フレームおきに間引く(60fps 上限
  // と合わせて実効 30fps)。ロジックと Tween は dt 駆動で進み続けるので
  // 演出の速度は変わらず、見た目の滑らかさだけを電池と発熱に換える。
  // ボタン操作は DOM とステージのイベントが担い、Ticker には依存しない
  var menuDrawToggle = false;
  function menuSkipDraw(state) {
    if (!PP.TOUCH ||
        (state !== "title" && state !== "over" && state !== "gameclear")) {
      menuDrawToggle = false;
      return false;
    }
    menuDrawToggle = !menuDrawToggle;
    return menuDrawToggle;
  }
  function tick(e) {
    // FPS の平均と計測表示はポーズ中も更新する(ポーズ画面の描画負荷も見たい)
    var rawDt = e.delta / 1000;
    updateFpsAvg(rawDt);
    updateFpsMeter(rawDt);
    // ポーズ(停泊)中はゲームの一切を進めない。盤面は完全に静止しているので
    // 最初の1フレーム(オーバーレイの表示)だけ描いたら以後の再描画をやめる。
    // 60fps で全画面を描き直し続けるとポーズ中でも端末が発熱するため。
    // ?fps=1 のときも描き直さない(以前は毎フレーム描いていたが、それでは
    // 計測表示がポーズ画面の負荷を「作って」しまい測定にならない。計測文字の
    // 更新は 0.25 秒ごとに 1 回だけ描く)。
    // pause() は showPause() → Ticker.paused の順なので、ここに来る最初の
    // フレームでオーバーレイは配置済み=1回の update で正しく写る(pause.js)
    if (PP.pauseCtl && PP.pauseCtl.active) {
      if (!pauseDrawn || (fpsText && fpsMeterAcc === 0)) {
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
      PP.session.updatePlaying(dt);
    } else if (g.state === "intro") {
      // コース開始イントロ。ゲームプレイ更新は一切呼ばない(玉はまだ流れない)
      PP.session.updateIntro(dt);
    } else if (g.state === "choosing") {
      // 【強化】宝玉の力の3択中。ゲームプレイ更新を一切呼ばない=盤面・弾・
      // アイテム・タイマーが全部その場で凍る(retrying と同じ考え方)。
      // 背景・パーティクル・カードの Tween は下の共通処理で動き続ける
      PP.upgrades.updateChoice(dt);
    } else if (g.state === "retrying") {
      PP.session.updateRetry(dt);   // リトライの画面切り替え(【課題5-3】)。終わると playing に戻る
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
    // 夜: playing 以外(イントロ・クリア・3択など)でも砲口の光は砲に付いていくが、
    // 燃料は減らさない(playing 中の減算は上の分岐で済んでいる)
    if (g.state !== "playing") PP.night.update(dt, false);
    // チュートリアルの進行とトースト(DOM 描画なので下の間引きの影響を受けない)
    if (PP.tut) PP.tut.update(dt);

    PP.chainView.render();
    PP.night.render();   // 夜: 玉の位置を示すゴースト(玉の座標が確定した後。夜以外は即 return)

    if (menuSkipDraw(g.state)) return;   // メニュー系画面の間引き(上の解説参照)
    stage.update(e);
  }

  // ---------- 描画器の選択(WebGL / Canvas 2D) ----------
  // Stage 3D: タッチ端末は既定で StageGL(WebGL)にする。全描画が cache 済み
  // ビットマップになった今、玉300〜480枚/フレームの blit は GPU のバッチ描画が
  // 圧倒的に安く、CPU ラスタライズの発熱源が丸ごと消える。加算合成(lighter)は
  // js/gl-patch.js が面倒を見る。
  // 優先順: URL ?gl=1/0 → 保存設定(store "renderer": auto/on/off) → 既定 auto。
  // auto はタッチのみ GL(PC は Canvas 2D で十分速く、実績のある経路を維持)
  function wantWebGL() {
    var q = null;
    try { q = new URLSearchParams(location.search).get("gl"); } catch (e) {}
    if (q === "1") return true;
    if (q === "0") return false;
    var saved = PP.store ? PP.store.get("renderer", "auto") : "auto";
    if (saved === "on") return true;
    if (saved === "off") return false;
    return PP.TOUCH;
  }
  function createGameStage() {
    PP.glActive = false;
    if (wantWebGL() && createjs.StageGL) {
      // 本番 canvas でいきなり試さない: 一度 "webgl" コンテキストを取った canvas は
      // 二度と "2d" に戻れないため、失敗時のフォールバックが効かなくなる。
      // 使い捨ての probe canvas で WebGL の可否を先に確かめる
      var probe = document.createElement("canvas");
      var ok = false;
      try { ok = !!(probe.getContext("webgl") || probe.getContext("experimental-webgl")); }
      catch (e) { ok = false; }
      if (ok) {
        try {
          var s = new createjs.StageGL("gameCanvas",
            { premultiply: false, transparent: false, antialias: false, autoPurge: 1200 });
          if (s._webGLContext) {
            // 背景は background.js が全画面を描くので、クリア色は何でも見えない
            s.setClearColor("#000000");
            PP.glActive = true;
            return s;
          }
        } catch (e2) { /* 下の Canvas 2D へフォールバック */ }
      }
    }
    return new createjs.Stage("gameCanvas");
  }

  // ---------- 初期化 ----------
  function init() {
    stage = PP.stage = createGameStage();
    // スマホ/タブレット対応: タッチを CreateJS のマウスイベントに変換する。
    // これでタップが stagemousedown、指のドラッグが stagemousemove として
    // input.js に届く。入力側はタッチとマウスの操作体系を分けて扱う。
    // (StageGL は Stage のサブクラスなので Touch/ヒットテストはそのまま動く)
    // 第2引数 singleTouch=true: 省略すると multitouch=true になり、指ごとに
    // ポインタ記録と座標計算が走る(以前は省略していた)。第3引数 allowDefault は
    // false のまま(canvas は CSS の touch-action:none で既にスクロール不可)
    if (createjs.Touch.isSupported()) createjs.Touch.enable(stage, true, false);
    // タッチの「指の移動」は stage 座標へ変換しない。EaselJS は touchmove の
    // たびに _updatePointerPosition → getBoundingClientRect + getComputedStyle
    // (強制レイアウト)を走らせるが、タッチ操作の照準は DOM ボタン駆動で、
    // input.js は stagemousemove のタッチ分を捨てている(=完全に無駄な仕事)。
    // タッチのサンプリングは 90〜240Hz なので、指を置いている間じゅう毎フレーム
    // 数回のレイアウト計算が消えていた。down/up は従来どおり変換する
    var origPointerMove = stage._handlePointerMove;
    if (typeof origPointerMove === "function") {
      stage._handlePointerMove = function (id, e, pageX, pageY, owner) {
        // touch* のみ捨てる。コースエディタはハンドルの pressmove(指の移動)を
        // 使うので、エディタ表示中は従来どおり通す
        if (e && e.type && e.type.charAt(0) === "t" &&
            !(PP.editor && PP.editor.active)) return;
        return origPointerMove.call(this, id, e, pageX, pageY, owner);
      };
    }
    // 毎フレームの stage.update() が表示ツリー全体へ "tick" イベントを配る
    // 既定動作を止める。このゲームで "tick" を聞く表示物は無く(Tween は
    // Ticker 直結)、玉+粒子+光点で 1500〜2500 個の再帰呼び出しと Event
    // オブジェクト生成が毎フレーム無駄になっていた
    stage.tickOnUpdate = false;

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
      night: new createjs.Container(),    // 夜の闇と灯り(玉より上・弾より下。night.js。夜以外は非表示)
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
      PP.layers.tunnel, PP.layers.barrel, PP.layers.night,
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
    var deaf = ["path", "ballUnder", "ballOver", "barrel", "night", "shot", "item"];
    PP.layers.night.visible = false;   // 夜の難易度で startLevel → night.reset が出す
    for (var di = 0; di < deaf.length; di++) {
      PP.layers[deaf[di]].mouseEnabled = false;
      PP.layers[deaf[di]].mouseChildren = false;
    }

    PP.bg.build();
    // デバッグ: index.html?level=3 のように URL で開始レベルを指定できる。
    // 指定中はゲームオーバー後もそのレベルから再開する(DBG_LEVEL)。
    var dbgLevel = parseInt(new URLSearchParams(location.search).get("level"), 10);
    if (dbgLevel >= 1) { PP.game.level = dbgLevel; DBG_LEVEL = dbgLevel; PP.session.setStartLevel(dbgLevel); }
    // 開始レベルのコースを組む(crisis/gameover は build 前なので relocate は空振り、
    // このあとの build が新しいレールを直接読む)
    PP.game.builtCourse = PP.COURSES[PP.session.courseForLevel(PP.game.level)];
    PP.session.buildCourse(PP.game.builtCourse);
    PP.crisis.build();
    PP.gameover.build();
    PP.cannon.build();
    PP.hud.build();
    PP.hud.buildOverlay();

    // 音源を読み終えてからタイトルを出す。
    PP.game.state = "loading";
    PP.hud.showOverlay(PP.i18n.t("main.loadingTitle"), PP.i18n.t("main.loading"));
    PP.startup.begin(PP.session.showTitle);
    PP.audio.preload(
      function (loaded, total) {
        if (!PP.startup.isLoading()) return;
        PP.hud.showOverlay(PP.i18n.t("main.loadingTitle"),
          PP.i18n.t("main.loadingN", { loaded: loaded, total: total }));
      },
      function () { PP.startup.ready("audio"); }
    );

    // 入力状態とイベント配線は input.js に集約する。ゲーム進行に必要な
    // コールバックだけを渡し、入力モジュールから main の内部状態へは触れさせない。
    PP.input.attach(stage, {
      startLevel: PP.session.startLevel,
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
    //
    // タッチ端末の上限は PP.PERF.TOUCH_CAP(=60)。以前の 40 は RAF_SYNCHED の
    // 採用閾値の都合で 60Hz/90Hz パネルでは実測 30fps に化けていた
    // (config.js TOUCH_CAP の解説)。発熱対策は「低負荷モードに落ちたら
    // LOW_CAP(30)へ下げる」方式に改め、上限の切替は setQuality が行う。
    // 切り分け用に ?cap=NN で上限を固定できる(固定中は品質が変わっても動かさない)
    var q = new URLSearchParams(location.search);
    if (q.get("hz") === "raf") {
      createjs.Ticker.timingMode = createjs.Ticker.RAF;
      PP.PERF.curFps = PP.PERF.targetFps = 60;
    } else {
      createjs.Ticker.timingMode = createjs.Ticker.RAF_SYNCHED;
      var cap = parseInt(q.get("cap"), 10);
      if (cap > 0) capFixed = true;
      else cap = PP.TOUCH ? PP.PERF.TOUCH_CAP : 60;
      PP.PERF.targetFps = cap;   // 品質自動調整の転落しきい値はこの値基準
      applyCap((PP.quality === 0 && !capFixed) ? PP.PERF.LOW_CAP : cap);
    }
    // FPS 移動平均の初期値も上限に合わせる。高いままだと起動直後の
    // HOLD 秒間だけ「低下した」と誤認しかねない
    fpsAvg = PP.PERF.curFps;
    // デバッグ: index.html?fps=1 で左下に FPS / 品質 / 玉数の計測表示を出す
    if (q.get("fps")) buildFpsMeter();
    createjs.Ticker.on("tick", tick);
    // headless smoke test でも確認できる、全同期初期化の完了マーカー。
    // audio preload の完了前でも stage・各モジュール・入力配線は利用可能になっている。
    // data-pp-renderer は「実際にどちらの描画器で起動したか」の記録
    // (--dump-dom でも WebGL 経路の起動成功を確認できる)
    document.documentElement.setAttribute("data-pp-ready", "true");
    document.documentElement.setAttribute("data-pp-renderer", PP.glActive ? "gl" : "2d");
  }

  if (typeof createjs !== "undefined") init();
})();
