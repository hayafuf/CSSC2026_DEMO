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

  function canPlay() {
    return PP.game.state === "playing" && !(PP.pauseCtl && PP.pauseCtl.active);
  }

  // ゲームオーバーと全ステージ制覇は、どちらもラン単位の状態を畳んで再出航する。
  function resetRun(startLevel, restartLevel) {
    var game = PP.game;
    game.level = restartLevel();
    game.score = 0;
    game.coins = 0;
    game.lives = PP.LIFE.startLives;
    PP.upgrades.onRunReset();
    PP.hud.hideOverlay();
    startLevel();
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
        PP.cannon.setX(aimStageX(event.stageX));
        PP.cannon.fire();
      }
    } else if (game.state === "clear") {
      game.level++;
      PP.hud.hideOverlay();
      startLevel();
    } else if (game.state === "gameclear" || game.state === "over") {
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
  }

  function bindKeyboard() {
    window.addEventListener("keydown", function (event) {
      if (PP.editor && PP.editor.active) return;
      PP.audio.unlock();
      if (event.code === "KeyP") {
        if (PP.pauseCtl) PP.pauseCtl.toggle();
        return;
      }
      if (PP.pauseCtl && PP.pauseCtl.active) return;
      if (event.code === "Space") {
        event.preventDefault();
        PP.cannon.swap();
      } else if (event.code === "KeyM") {
        PP.fx.floatText(PP.audio.toggleMute() ? "🔇 消音" : "🔊 音あり",
          PP.W / 2, 88, "#f0e6c8", 22);
      } else if (/^Digit[1-3]$/.test(event.code) && PP.game.state === "choosing") {
        PP.upgrades.chooseIndex(parseInt(event.code.charAt(5), 10) - 1);
      } else if (/^Digit[1-4]$/.test(event.code)) {
        var state = PP.game.state;
        if (state === "title" || state === "over" || state === "gameclear") {
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
      PP.cannon.setX(aimStageX(event.stageX));
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
    bindKeyboard();
  }

  function update(deltaSeconds) {
    // 短押しは微調整、長押しは画面横断に使えるよう移動速度をランプさせる。
    if (!touchMoveDirection) {
      touchMoveHeld = 0;
      return;
    }
    touchMoveHeld += deltaSeconds;
    var speed = TOUCH_MOVE_START + (TOUCH_MOVE_MAX - TOUCH_MOVE_START) *
      Math.min(1, touchMoveHeld / TOUCH_MOVE_RAMP);
    var direction = PP.game.bossFx.addle > 0 ? -touchMoveDirection : touchMoveDirection;
    PP.cannon.setX(PP.cannon.x + direction * speed * deltaSeconds);
  }

  PP.input = { attach: attach, update: update };
})();
