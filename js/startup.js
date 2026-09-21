/* startup.js — 音声とエディタの準備を待ち、起動先を一度だけ決める。
 * file://でも、読み込み順・音声タイムアウトに左右されず共有URLを処理する。 */
(function () {
  "use strict";
  var PP = window.PP;
  var audioReady = false, editorReady = false, finished = false;
  var showTitle = null;
  function complete() {
    if (finished || !audioReady || !editorReady || !showTitle) return;
    finished = true;
    // 読み込み中にAPIから開始したプレイを、遅い通知で上書きしない。
    if (PP.game.state !== "loading") return;
    showTitle();
    PP.courseAPI.checkURL();
  }
  PP.startup = {
    begin: function (title) { showTitle = title; complete(); },
    ready: function (part) {
      if (part === "audio") audioReady = true;
      if (part === "editor") editorReady = true;
      complete();
    },
    isLoading: function () { return !finished && !audioReady && PP.game.state === "loading"; }
  };
})();
