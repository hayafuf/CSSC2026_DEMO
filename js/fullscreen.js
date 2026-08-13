/* =========================================================
 * fullscreen.js — 全画面表示とモバイルの横向き固定
 * ========================================================= */
(function () {
  "use strict";

  var wrapper = document.getElementById("stageWrap");
  var button = document.getElementById("fsBtn");
  if (!wrapper || !button) return;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  function toggleFullscreen() {
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (wrapper.requestFullscreen || wrapper.webkitRequestFullscreen) {
      (wrapper.requestFullscreen || wrapper.webkitRequestFullscreen).call(wrapper);
    }
  }

  function syncButton() {
    button.textContent = fullscreenElement() ? "🗗" : "⛶";
  }

  function lockLandscape() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(function () {});
      }
    } catch (error) {}
  }

  button.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncButton);
  document.addEventListener("webkitfullscreenchange", syncButton);
  window.addEventListener("keydown", function (event) {
    if (event.code !== "KeyF") return;
    var target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
        target.isContentEditable)) return;
    event.preventDefault();
    toggleFullscreen();
  });

  if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
    // 全画面・画面方向固定はユーザー操作中しか許可されないため、最初のタップで
    // 一度だけ試す。API がない iPhone などでは何もせず通常表示を継続する。
    wrapper.addEventListener("pointerdown", function enterMobileFullscreen() {
      wrapper.removeEventListener("pointerdown", enterMobileFullscreen);
      try {
        if (fullscreenElement()) {
          lockLandscape();
          return;
        }
        var request = wrapper.requestFullscreen || wrapper.webkitRequestFullscreen;
        if (!request) return;
        var promise = request.call(wrapper);
        if (promise && promise.then) promise.then(lockLandscape).catch(function () {});
        else lockLandscape();
      } catch (error) {}
    });
  }
})();
