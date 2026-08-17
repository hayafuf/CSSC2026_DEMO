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

  // ---- マウス操作は「移動量」で砲台を動かす(Pointer Lock でゲーム内へ格納) ----
  // マウスの絶対座標に砲台を張り付ける方式には2つの構造的な穴がある:
  //   (1) 逆操作(addle)で鏡像化すると、付与/解除のたびに砲台が自走する
  //   (2) ウィンドウ表示では、カーソルがキャンバスの外へ出た瞬間に操作が切れる
  // そこでプレイ中(playing / intro)は最初から Pointer Lock でマウスをゲーム内へ
  // 格納し、カーソル無しの純粋な移動量(movementX)で砲台を動かす
  // (=砲台がゲーム内カーソルそのもの)。逆操作は移動量の符号を反転するだけになる。
  // requestPointerLock はユーザー操作(クリック/キー)の直後でないと拒否される
  // ため、要求は必ず操作イベント起点(requestLockSoon)で行う。拒否された間や
  // Esc での自主解除の間は、従来の絶対追従(+逆操作の相対フォールバック)で
  // 操作が成立するようにしてある。
  var canvasEl = null;
  var pointerLocked = false;

  function requestLock() {
    if (PP.TOUCH || pointerLocked || !canvasEl || !canvasEl.requestPointerLock) return;
    try {
      var p = canvasEl.requestPointerLock();
      if (p && p.catch) p.catch(function () {});   // 拒否は握りつぶす(フォールバックあり)
    } catch (e) {}
  }
  function releaseLock() {
    if (canvasEl && document.pointerLockElement === canvasEl) {
      try { document.exitPointerLock(); } catch (e) {}
    }
  }

  // 操作イベント(クリック/キー)から呼ぶロック要求。状態遷移(タイトル→出航、
  // ポーズ解除→再開 など)が同じイベントの中で起きるので、ひと呼吸(setTimeout 0)
  // 置いてから「操作する画面にいるか」を確かめて要求する。ユーザー操作の効力
  // (transient activation)はこの遅延では失われない
  function requestLockSoon() {
    if (PP.TOUCH) return;
    setTimeout(function () {
      var st = PP.game.state;
      if ((st === "playing" || st === "intro") &&
          !(PP.pauseCtl && PP.pauseCtl.active) &&
          !(PP.editor && PP.editor.active)) requestLock();
    }, 0);
  }

  // 毎フレームの見張り(main.js の tick から状態を問わず呼ばれる)。
  // マウス格納が許されるのは操作する画面(playing / intro)だけ。カード選択・
  // クリア・ゲームオーバーなど「カーソルで押す画面」へ移ったら必ず返上する
  function watchLock() {
    if (!pointerLocked) return;
    var st = PP.game.state;
    var ok = (st === "playing" || st === "intro") &&
             !(PP.pauseCtl && PP.pauseCtl.active) &&
             !(PP.editor && PP.editor.active);
    if (!ok) releaseLock();
  }

  // 照準の状態(数値は config.js の PP.AIM)。
  // lastPointerX: 最後に見たマウスの生 stageX(タッチ操作では使わない)。
  //   逆転(addle)中は絶対写像を使わず、この値との差分(動き)だけを反転して
  //   砲台へ足す=砲台がゲーム内カーソルになる。
  // aimOffset: 逆転・停止(freeze)の解除後に残った「砲台X − マウスX」のズレ。
  //   時間では戻さない(入力していないのに砲台が自走するのは理不尽)。
  //   マウスが動いた量に比例してだけ吸収し、静止中は今の位置に留まる。
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

  // 逆転(addle)・停止(freeze)の「解除」エッジの検出。解除の瞬間に
  // 「今の砲台X − マウス実X」のズレをオフセットへ退避する(そのまま絶対写像へ
  // 戻すと、次の mousemove で砲台がマウス実位置へ一発ワープするため)。
  // 「新しい写像を最初に適用する前」に必ず呼ぶ必要があるため、毎フレームの
  // update・mousemove / mousedown ハンドラの先頭に加えて、main.js の tick でも
  // bossFx を減算する powerups.update の直後に呼ぶ(タイマー失効と同じフレーム内で
  // エッジを張り、検知の1フレーム遅れを閉じる。boss.js clearStatusFx も拾える)。
  // 逆転の「付与」側はエッジ処理が要らない: 相対移動へ切り替わるだけで、
  // 砲台はその場に留まる(以前の鏡像写像はここで自走が生まれていた)
  function syncEdges() {
    var addleOn = PP.game.bossFx.addle > 0;
    var frozen = PP.game.bossFx.freeze > 0;
    // 解除エッジ: addle が切れた / freeze が明けた(addle 継続中なら相対のまま)
    var edge = (prevAddleOn && !addleOn) || (prevFrozen && !frozen && !addleOn);
    if (addleOn && !prevAddleOn) aimOffset = 0;   // 相対モード入り: 古いズレは捨てる
    prevAddleOn = addleOn;
    prevFrozen = frozen;
    if (!edge) return;
    if (lastPointerX !== null && !touchAiming) {
      // ズレはマウスの「生の」X基準で持つ。可動域(CANNON_MARGIN)でクランプした
      // 値と比べると、マウスが可動域の外にいる間に解除が来たとき「クランプ差」の
      // ぶんだけ次の一動きで砲台が跳ぶ(適用側 x + aimOffset は生のXに足すため)
      aimOffset = PP.cannon.x - lastPointerX;
    }
  }

  // 解除後のズレ吸収: マウスが movedPx 動いたぶんに比例してだけ 0 へ近づける。
  // 時間減衰にしない理由: マウスが静止しているのに砲台だけ滑るのは「操作して
  // いないのに動く」理不尽で、避けている最中の事故のもとになる
  function absorbOffset(movedPx) {
    if (aimOffset === 0 || movedPx <= 0) return;
    var ab = Math.min(Math.abs(aimOffset), movedPx * PP.AIM.absorbPerPx);
    aimOffset += aimOffset > 0 ? -ab : ab;
    if (Math.abs(aimOffset) < 0.5) aimOffset = 0;
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

    var game = PP.game;
    if (game.state === "loading") return;

    // 右クリック = 玉の交換。判定は contextmenu ではなく mousedown で行う:
    // マウス格納(Pointer Lock)中のブラウザは contextmenu を発火しないため、
    // contextmenu 頼みだとプレイ中の右クリック交換が丸ごと効かなくなる
    // (mousedown は button=2 として通常どおり届く)。canvas 側の contextmenu は
    // ブラウザメニューを止めるだけの役目に絞ってある
    if (event.nativeEvent && event.nativeEvent.button === 2) {
      if (PP.pauseCtl && PP.pauseCtl.active) return;   // ポーズ中は解除もせず素通り
      PP.cannon.swap();
      return;
    }
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
      if (PP.store) PP.store.set("lastDiff", difficulty);   // 次回起動時に復元
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
        syncEdges();
        // 格納中(Pointer Lock)のクリックは発射のみ: stageX はロック時点で凍った
        // 古い座標なので、位置合わせに使ってはいけない(使うと過去の位置へワープ)。
        // 非格納時のフォールバックでは、逆操作・停止中を除き従来どおり
        // クリック位置へ寄せてから撃つ
        if (!pointerLocked &&
            PP.game.bossFx.addle <= 0 && PP.game.bossFx.freeze <= 0) {
          var dx0 = (lastPointerX === null) ? 0 : event.stageX - lastPointerX;
          absorbOffset(Math.abs(dx0));
          PP.cannon.setX(event.stageX + aimOffset);
        }
        if (!pointerLocked) lastPointerX = event.stageX;
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
      // 設定パネル/操作説明の表示中はゲームへのキーを止める(P で裏の
      // ゲームだけ再開してしまう事故を防ぐ)。Esc はパネルを閉じる
      if (PP.settings && PP.settings.isOpen()) {
        if (event.code === "Escape") PP.settings.closeTop();
        return;
      }
      PP.audio.unlock();
      // キー入力も確実なユーザー操作なのでロックを張り直すチャンス。
      // Esc だけは除外する: Esc はブラウザの「格納をやめる」操作そのもので、
      // 即座に張り直すとプレイヤーがマウスを取り返せなくなる(次のクリックで復帰)
      if (event.code !== "Escape") requestLockSoon();
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
        if (PP.settings) PP.settings.syncMute();   // 右上 🔊 ボタンの絵と同期
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
            if (PP.store) PP.store.set("lastDiff", key);   // 次回起動時に復元
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
      // 格納中は DOM の mousemove(movementX)が砲台を動かす。CreateJS の stageX は
      // クライアント座標由来で凍っているため、ここで使うと古い位置へワープする
      if (pointerLocked) return;
      syncEdges();
      var x = event.stageX;
      var dx = (lastPointerX === null) ? 0 : x - lastPointerX;
      lastPointerX = x;
      // 停止(freeze)中は setX が無効。位置だけ覚えて、ズレ吸収も行わない
      // (吸収だけ進むと、解除の瞬間にマウス実位置へ一発ワープしてしまう)
      if (PP.game.bossFx.freeze > 0) return;
      if (PP.game.bossFx.addle > 0) {
        // 逆操作中: マウスの絶対位置は使わず、「動き」を反転して砲台へ足す
        // (砲台がゲーム内カーソルになる。タッチの◀▶と同じ相対移動)。
        // カンバス外へ出て別の場所から入り直した1発目は差分が画面幅近くまで
        // 跳ぶので、1イベントの移動量を maxRelStep で頭打ちにする
        var cap = PP.AIM.maxRelStep;
        if (dx > cap) dx = cap; else if (dx < -cap) dx = -cap;
        if (dx !== 0) PP.cannon.setX(PP.cannon.x - dx);
      } else {
        absorbOffset(Math.abs(dx));
        PP.cannon.setX(x + aimOffset);
      }
    });

    // ---- ポインターロックの配線(プレイ中の「マウス格納」) ----
    canvasEl = document.getElementById("gameCanvas");
    document.addEventListener("pointerlockchange", function () {
      var was = pointerLocked;
      pointerLocked = document.pointerLockElement === canvasEl;
      // プレイ中に格納が解けた(Esc等)瞬間: OSカーソルは格納時の位置に復帰する
      // (ブラウザ仕様)ので、「砲台X − カーソル実X」のズレを退避しておく。
      // 以後の絶対追従フォールバックが、動いた量に応じて滑らかに合流してくれる
      if (was && !pointerLocked && PP.game.state === "playing" &&
          lastPointerX !== null && !touchAiming) {
        aimOffset = PP.cannon.x - lastPointerX;
      }
    });
    // 格納中は CreateJS の stageX(クライアント座標由来)が凍るため、
    // DOM の mousemove から movementX(純粋な移動量)を読む。キャンバスは CSS で
    // 拡縮されるので、実表示幅との比でステージ座標系へ換算する
    document.addEventListener("mousemove", function (event) {
      if (!pointerLocked) return;
      if (PP.pauseCtl && PP.pauseCtl.active) return;   // 念のため(pause 側で返上済み)
      if (PP.game.bossFx.freeze > 0) return;   // 停止中は動けない(setX も無効)
      var rect = canvasEl.getBoundingClientRect();
      var scale = rect.width ? PP.W / rect.width : 1;
      var dx = (event.movementX || 0) * scale;
      if (!dx) return;
      // 通常はそのまま、逆操作(addle)中は符号を反転するだけ
      PP.cannon.setX(PP.cannon.x + (PP.game.bossFx.addle > 0 ? -dx : dx));
    });
    // クリックは確実なユーザー操作 = ロックを張る/張り直すチャンス。
    // 初回の出航クリック、カード選択、ポーズ解除、Esc 後の復帰もすべてここで拾う
    canvasEl.addEventListener("mousedown", function () { requestLockSoon(); });

    // ブラウザの音声自動再生制限はユーザー操作の中でのみ解除できる。
    document.addEventListener("pointerdown", function () { PP.audio.unlock(); }, { once: true });
    // 右クリックの交換そのものは stagemousedown(button=2)が担当する。
    // ここはブラウザのコンテキストメニューを止めるだけ: 両方で swap を呼ぶと、
    // 格納していないとき(mousedown → contextmenu の順で両方届く)に2回交換され、
    // 見た目が元に戻ってしまう
    document.getElementById("gameCanvas").addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });

    bindTouchButtons();
    bindKeyboard(startLevel);
  }

  function update(deltaSeconds) {
    // エッジ検出(マウスが静止したまま addle/freeze が切り替わるケースを拾う)。
    // 解除後のズレ(aimOffset)はここでは減らさない: 吸収はマウスの移動量に
    // 比例して mousemove 側で行う。時間で戻すと「入力していないのに砲台が
    // 勝手にマウス実位置へ滑っていく」自走になり、回避中の事故のもとになる
    syncEdges();

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
    // マウス格納(Pointer Lock)はここでは返上しない: レベルをまたいでも
    // プレイは続いており、カーソルを一瞬見せる理由がない(返上の判断は watchLock)
  }

  PP.input = { attach: attach, update: update, resetAim: resetAim,
    syncEdges: syncEdges,      // main.js が powerups.update(bossFx減算)の直後に呼ぶ
    watchLock: watchLock,      // main.js の tick が状態を問わず毎フレーム呼ぶ
    releaseLock: releaseLock   // pause.js がポーズ時にカーソルを返すために呼ぶ
  };
})();
