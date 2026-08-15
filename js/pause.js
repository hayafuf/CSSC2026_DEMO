/* =========================================================
 * pause.js — ポーズ(停泊)機能
 *
 * ・手動ポーズ: P キー、または HUD 右上の ⏸ ボタン(main.js が呼ぶ)
 * ・自動ポーズ: 別のウィンドウ/タブへ切り替えた瞬間(visibilitychange / blur)。
 *   課題の資料を見に行っている間にゲームが進んでしまわないようにする。
 *   自動ポーズからの復帰は「クリック」のみ(戻った瞬間に勝手に再開しない)
 *
 * 仕組み: createjs.Ticker.paused = true にすると、tick イベント自体は
 * 発火し続けるが、Tween は ignoreGlobalPause 指定のないものが全部凍結する。
 * さらに main.js の tick() が先頭で早期 return するので、玉の移動・タイマー・
 * エフェクト・危機演出など dt 駆動の処理も一括で止まる。
 * 音は audio.js の pauseAll()/resumeAll() で止めて戻す。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var ctl = {
    active: false,
    reason: null,   // "manual"(Pキー/⏸ボタン) | "auto"(ウィンドウ切り替え)

    pause: function (reason) {
      // 時間駆動の状態はすべて停泊できる。タイトル/クリア/オーバー画面は
      // タイマーが無い(進んで困るものがない)ので停めず、BGM を流したままにする。
      // ここを playing 限定にしていた頃は、カード選択・リトライ暗幕・ゲーム
      // オーバー演出中にタブを離れると Tween だけが先に完走して画面が壊れていた
      var PAUSABLE = { playing: 1, intro: 1, choosing: 1, retrying: 1, draining: 1 };
      if (ctl.active) return;
      if (!PP.game || !PAUSABLE[PP.game.state]) return;
      if (PP.editor && PP.editor.active) return;
      ctl.active = true;
      ctl.reason = reason || "manual";
      // 逆操作中のマウス格納(Pointer Lock)は返上する。ポーズ画面は
      // 「クリックで再開」なので、カーソルが見えないと操作できない
      if (PP.input && PP.input.releaseLock) PP.input.releaseLock();
      PP.fx.resetShake();               // 揺れの途中で止まると画面がズレたままになる
      PP.hud.showPause(ctl.reason);
      PP.audio.pauseAll();
      createjs.Ticker.paused = true;
    },

    resume: function () {
      if (!ctl.active) return;
      createjs.Ticker.paused = false;
      ctl.active = false;
      ctl.reason = null;
      PP.hud.hidePause();
      PP.audio.resumeAll();
    },

    toggle: function () {
      if (ctl.active) ctl.resume();
      else ctl.pause("manual");
    }
  };

  // 自動ポーズ: 他のウィンドウ/タブに切り替えたら錨を下ろす。
  // 戻ってきても自動では再開しない(課題を確認してからクリックで再開)
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) return;
    // ポーズが拒否される画面(タイトル等)でも、揺れの途中オフセットだけは
    // 残さない(戻ってきたとき盤面がズレたままになるため)
    if (PP.fx && PP.fx.resetShake) PP.fx.resetShake();
    ctl.pause("auto");
  });
  window.addEventListener("blur", function () {
    ctl.pause("auto");
  });

  PP.pauseCtl = ctl;
})();
