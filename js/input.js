/* =========================================================
 * input.js — マウス・キーボード・タッチ操作
 *
 * main.js はゲーム進行に集中し、このモジュールには入力状態と DOM/CreateJS
 * イベントの配線を集約する。attach は起動時に1回、update はプレイ中の
 * 毎フレーム呼ぶ。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var touchAiming = false;
  var touchDownX = 0;
  var touchDownTime = 0;
  var touchOnCannon = false;
  var touchMoveDirection = 0;
  var touchMoveHeld = 0;

  // 逆転(addle)の付与/解除・停止(freeze)明けの瞬間に照準が瞬間移動しない
  // ための橋渡し(数値は config.js の PP.AIM)。
  // lastPointerX: 最後に見たマウスの生 stageX(タッチ操作では使わない)。
  // aimOffset: 切替の瞬間の「今の砲台X − 新写像での目標X」。指数減衰で0へ
  // 吸収するが、1フレームの吸収量には PP.AIM.maxAbsorb の速度上限を掛ける:
  // 逆転解除のオフセットは画面幅近くになり得るので、減衰だけだと出だしが
  // 数千px/s の「ワープ」になり、避けている最中に敵弾へ突っ込んでしまう。
  var lastPointerX = null;
  var aimOffset = 0;
  var prevAddleOn = false;
  var prevFrozen = false;

  var TOUCH_MOVE_START = 600;
  var TOUCH_MOVE_MAX = 1800;
  var TOUCH_MOVE_RAMP = 0.45;
  var FIRE_REPEAT_MS = 180;

  // CreateJS はタッチをマウスイベントへ変換するため、元イベントで入力元を判別する。
  function isTouchEvent(event) {
    var nativeEvent = event && event.nativeEvent;
    return !!(nativeEvent && nativeEvent.type && nativeEvent.type.indexOf("touch") === 0);
  }

  function aimStageX(stageX) {
    return PP.game.bossFx.addle > 0 ? PP.W - stageX : stageX;
  }

  // 逆転(addle)の付与/解除・停止(freeze)明けエッジの検出と、橋渡しオフセットの
  // 張り直し。「新しい写像を最初に適用する前」に必ず呼ぶ必要があるため、
  // 毎フレームの update・mousemove / mousedown ハンドラの先頭に加えて、
  // main.js の tick でも bossFx を減算する powerups.update の直後に呼ぶ
  // (タイマー失効と同じフレーム内でエッジを張り、検知の1フレーム遅れを閉じる。
  //  boss.js clearStatusFx の強制解除もこの経路で拾える)。
  function syncEdges() {
    var addleOn = PP.game.bossFx.addle > 0;
    var frozen = PP.game.bossFx.freeze > 0;
    // freeze の「解除」もエッジ: 停止中は setX が無効(cannon.js)なので、
    // その間にマウスだけ動くと、解除後の最初の setX で砲台がマウス実位置へ
    // 一発ワープする。解除の瞬間にズレをオフセットへ退避して滑らかに合流させる
    var edge = (addleOn !== prevAddleOn) || (prevFrozen && !frozen);
    prevAddleOn = addleOn;
    prevFrozen = frozen;
    if (!edge) return;
    if (lastPointerX !== null && !touchAiming) {
      var m = PP.CANNON_MARGIN;
      var want = Math.max(m, Math.min(PP.W - m, aimStageX(lastPointerX)));
      aimOffset = PP.cannon.x - want;
    }
  }

  function canPlay() {
    return PP.game.state === "playing" && !(PP.pauseCtl && PP.pauseCtl.active);
  }

  // 全ステージ制覇(とタイトルからの初回出航)はラン単位の状態を畳んで再出航する。
  function resetRun(startLevel, restartLevel) {
    var game = PP.game;
    game.level = restartLevel();
    game.score = 0;
    game.coins = 0;
    game.lives = PP.LIFE.startLives;
    game.continues = 0;
    game.continueStages = [];
    game.failStreak = 0;
    PP.upgrades.onRunReset();
    PP.hud.hideOverlay();
    startLevel();
  }

  // ゲームオーバーからのコンティニュー: 同じ海域をスコア0で再挑戦。
  // 宝玉の力(upgrades)・虹玉ストック・難易度・レベルは維持する。
  // どこでコンティニューしたかを記録し、全クリア時の結果表示に出す。
  function continueRun(startLevel) {
    var game = PP.game;
    game.continues++;
    game.continueStages.push(game.level);
    game.failStreak++;                 // ピティドロップの連続失敗として数える
    game.score = 0;
    game.coins = 0;
    game.lives = PP.LIFE.startLives;   // maxLives(3)ではなく出航時の枚数へ全回復
    PP.hud.hideOverlay();
    startLevel();                      // レベル・upgrades は維持(イントロ付きで再開)
  }

  function onStageDown(event, startLevel, restartLevel) {
    if (PP.editor && PP.editor.active) return;
    if (event.nativeEvent && event.nativeEvent.button === 2) return;

    var game = PP.game;
    if (game.state === "loading") return;
    PP.audio.unlock();
    if (PP.pauseCtl && PP.pauseCtl.active) {
      PP.pauseCtl.resume();
      return;
    }

    // オーバーレイ上の選択を盤面操作より先に判定し、同じクリックでの誤発射を防ぐ。
    // 言語ボタン(🌐)も同様に先取り(タイトル / 全制覇画面だけ当たる)
    if (PP.hud.hitLang(event.stageX, event.stageY)) {
      PP.i18n.set(PP.i18n.lang === "ja" ? "en" : "ja");
      return;
    }
    var difficulty = PP.hud.hitDifficulty(event.stageX, event.stageY);
    if (difficulty) {
      game.difficulty = difficulty;
      PP.hud.setDifficulty(difficulty);
      return;
    }

    if (game.state === "choosing") {
      var upgradeId = PP.upgrades.hitChoice(event.stageX, event.stageY);
      if (upgradeId) PP.upgrades.choose(upgradeId);
      return;
    }

    if (game.state === "intro") {
      // コース開始イントロはタップで即スキップ(そのままプレイへ)
      if (PP.skipIntro) PP.skipIntro();
      return;
    }

    if (game.state === "title") {
      PP.hud.hideOverlay();
      startLevel();
    } else if (game.state === "playing") {
      if (PP.hud.hitPauseBtn(event.stageX, event.stageY)) {
        PP.pauseCtl.pause("manual");
        return;
      }
      if (PP.hud.hitSwapBtn(event.stageX, event.stageY)) {
        PP.cannon.swap();
        return;
      }
      // 【新】🌈 虹玉ボタン(発射より先に判定し、同じクリックでの誤発射を防ぐ)
      if (PP.hud.hitWildBtn(event.stageX, event.stageY)) {
        PP.upgrades.toggleWild();
        return;
      }
      if (PP.cannon.hitStock(event.stageX, event.stageY)) {
        PP.cannon.toggleSpecial();
        return;
      }
      if (isTouchEvent(event)) {
        touchAiming = true;
        touchDownX = event.stageX;
        touchDownTime = Date.now();
        touchOnCannon = Math.abs(event.stageX - PP.cannon.x) < 80 &&
          event.stageY > PP.cannon.y - 90;
      } else {
        lastPointerX = event.stageX;
        syncEdges();
        PP.cannon.setX(aimStageX(event.stageX) + aimOffset);
        PP.cannon.fire();
      }
    } else if (game.state === "clear") {
      game.level++;
      PP.hud.hideOverlay();
      startLevel();
    } else if (game.state === "over") {
      // 進路はボタンで選ぶ(ボタン外のクリックは誤爆防止で何もしない)
      var pick = PP.hud.hitOverChoice(event.stageX, event.stageY);
      if (pick === "continue") continueRun(startLevel);
      else if (pick === "title" && PP.returnToTitle) PP.returnToTitle();
    } else if (game.state === "gameclear") {
      resetRun(startLevel, restartLevel);
    }
  }

  function bindTouchButtons() {
    // pointercancel / lostpointercapture も監視し、指がボタン外へ滑っても入力を止める。
    function bindHold(id, direction) {
      var element = document.getElementById(id);
      if (!element) return;
      element.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        PP.audio.unlock();
        if (element.setPointerCapture) {
          try { element.setPointerCapture(event.pointerId); } catch (error) {}
        }
        touchMoveDirection = direction;
      });
      function stop() {
        if (touchMoveDirection === direction) touchMoveDirection = 0;
      }
      element.addEventListener("pointerup", stop);
      element.addEventListener("pointercancel", stop);
      element.addEventListener("lostpointercapture", stop);
      element.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    }

    function bindTap(id, action) {
      var element = document.getElementById(id);
      if (!element) return;
      element.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        PP.audio.unlock();
        if (PP.pauseCtl && PP.pauseCtl.active) {
          PP.pauseCtl.resume();
          return;
        }
        if (canPlay()) action();
      });
      element.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    }

    function bindFire(id) {
      var element = document.getElementById(id);
      if (!element) return;
      var timer = null;
      function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
      }
      element.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        PP.audio.unlock();
        if (PP.pauseCtl && PP.pauseCtl.active) {
          PP.pauseCtl.resume();
          return;
        }
        if (!canPlay()) return;
        PP.cannon.fire();
        if (element.setPointerCapture) {
          try { element.setPointerCapture(event.pointerId); } catch (error) {}
        }
        stop();
        timer = setInterval(function () {
          if (!canPlay()) {
            stop();
            return;
          }
          PP.cannon.fire();
        }, FIRE_REPEAT_MS);
      });
      element.addEventListener("pointerup", stop);
      element.addEventListener("pointercancel", stop);
      element.addEventListener("lostpointercapture", stop);
      element.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    }

    bindHold("tLeft", -1);
    bindHold("tRight", 1);
    bindFire("tFire");
    bindTap("tSwap", function () { PP.cannon.swap(); });
    bindTap("tWild", function () { PP.upgrades.toggleWild(); });   // 【新】🌈 虹玉
  }

  function bindKeyboard(startLevel) {
    window.addEventListener("keydown", function (event) {
      if (PP.editor && PP.editor.active) return;
      PP.audio.unlock();
      if (event.code === "KeyP") {
        if (PP.pauseCtl) PP.pauseCtl.toggle();
        return;
      }
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      // ゲームオーバー画面の進路選択(ボタンと同じ2択のキー版)
      if (PP.game.state === "over") {
        if (event.code === "KeyR") { continueRun(startLevel); return; }
        if (event.code === "KeyT") { if (PP.returnToTitle) PP.returnToTitle(); return; }
      }
      if (event.code === "Space") {
        event.preventDefault();
        PP.cannon.swap();
      } else if (event.code === PP.WILD.key) {
        // 【新】虹玉の手動装填トグル(プレイ中のみ。詳細は upgrades.toggleWild)
        if (canPlay()) PP.upgrades.toggleWild();
      } else if (event.code === "KeyM") {
        PP.fx.floatText(PP.i18n.t(PP.audio.toggleMute() ? "in.mute" : "in.unmute"),
          PP.W / 2, 88, "#f0e6c8", 22);
      } else if (/^Digit[1-3]$/.test(event.code) && PP.game.state === "choosing") {
        PP.upgrades.chooseIndex(parseInt(event.code.charAt(5), 10) - 1);
      } else if (/^Digit[1-4]$/.test(event.code)) {
        var state = PP.game.state;
        // over 画面はコンティニュー(同ラン継続)になったので難易度は変えられない
        if (state === "title" || state === "gameclear") {
          var key = PP.DIFFICULTY_ORDER[parseInt(event.code.charAt(5), 10) - 1];
          if (key) {
            PP.game.difficulty = key;
            PP.hud.setDifficulty(key);
          }
        }
      }
    });
  }

  function attach(stage, options) {
    var startLevel = options.startLevel;
    var restartLevel = options.restartLevel;

    stage.on("stagemousedown", function (event) {
      onStageDown(event, startLevel, restartLevel);
    });
    stage.on("stagemouseup", function (event) {
      if (!touchAiming) return;
      touchAiming = false;
      if (!canPlay()) return;
      var moved = Math.abs(event.stageX - touchDownX) > 24;
      var quick = Date.now() - touchDownTime < 350;
      if (touchOnCannon && !moved && quick) PP.cannon.swap();
    });
    stage.on("stagemousemove", function (event) {
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      if (isTouchEvent(event)) return;
      lastPointerX = event.stageX;
      syncEdges();
      PP.cannon.setX(aimStageX(event.stageX) + aimOffset);
    });

    // ブラウザの音声自動再生制限はユーザー操作の中でのみ解除できる。
    document.addEventListener("pointerdown", function () { PP.audio.unlock(); }, { once: true });
    document.getElementById("gameCanvas").addEventListener("contextmenu", function (event) {
      event.preventDefault();
      if (PP.editor && PP.editor.active) return;
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      PP.cannon.swap();
    });

    bindTouchButtons();
    bindKeyboard(startLevel);
  }

  function update(deltaSeconds) {
    // エッジ検出(マウスが静止したまま addle/freeze が切り替わるケースを拾う)
    syncEdges();
    if (PP.game.bossFx.freeze > 0) {
      // 停止(freeze)中は cannon.setX が無効なので、オフセットの減衰も止める。
      // ここで減衰だけ回すと「見た目は動かないままズレだけ静かに消え、解除の
      // 瞬間にマウス実位置へ一発ワープ」する(解除エッジは syncEdges が拾う)
    } else if (aimOffset !== 0) {
      // 指数減衰のステップに速度上限を掛ける(定数と意図は config.js の PP.AIM)
      var step = aimOffset * (1 - Math.exp(-deltaSeconds / PP.AIM.blendTau));
      var cap = PP.AIM.maxAbsorb * deltaSeconds;
      if (step > cap) step = cap;
      else if (step < -cap) step = -cap;
      aimOffset -= step;
      if (Math.abs(aimOffset) < 0.5) aimOffset = 0;
      // マウスが静止していても減衰の途中経過が見えるよう毎フレーム書く
      if (lastPointerX !== null && !touchAiming) {
        PP.cannon.setX(aimStageX(lastPointerX) + aimOffset);
      }
    }

    // 短押しは微調整、長押しは画面横断に使えるよう移動速度をランプさせる。
    if (!touchMoveDirection) {
      touchMoveHeld = 0;
      return;
    }
    touchMoveHeld += deltaSeconds;
    var speed = TOUCH_MOVE_START + (TOUCH_MOVE_MAX - TOUCH_MOVE_START) *
      Math.min(1, touchMoveHeld / TOUCH_MOVE_RAMP);
    // タッチ移動は絶対座標の写像を持たない相対移動なので、逆転(addle)は
    // 方向の符号を返すだけでよい=解除時のワープは構造的に起きない
    var direction = PP.game.bossFx.addle > 0 ? -touchMoveDirection : touchMoveDirection;
    PP.cannon.setX(PP.cannon.x + direction * speed * deltaSeconds);
  }

  // レベル開始時のリセット(main.js startLevel が bossFx をゼロ化した直後に呼ぶ)。
  // 古いエッジ検出状態が最初のフレームで誤発火しないようにする
  function resetAim() {
    aimOffset = 0;
    prevAddleOn = false;
    prevFrozen = false;
  }

  PP.input = { attach: attach, update: update, resetAim: resetAim,
    syncEdges: syncEdges };   // main.js が powerups.update(bossFx減算)の直後に呼ぶ
})();
