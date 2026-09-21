/* lifecycle.js — 表示物と、その表示物に属するTweenの寿命を管理する。
 * 使い終えた玉・弾を配列から捨てる前に呼ぶ。永続UIのTweenには触れない。 */
(function () {
  "use strict";
  var PP = window.PP;

  function stopTweens(view) {
    if (!view) return;
    createjs.Tween.removeTweens(view);
    if (view.children) view.children.forEach(stopTweens);
  }
  function removeView(view) {
    if (!view) return;
    stopTweens(view);
    if (view.parent) view.parent.removeChild(view);
  }
  function clearShots() {
    PP.game.shots.forEach(function (shot) { removeView(shot.view); });
    PP.game.shots.length = 0;
  }
  function clearLanes() {
    PP.game.lanes.forEach(function (lane) {
      lane.balls.forEach(function (ball) {
        removeView(ball.view);
        PP.ball.releaseView(ball.view);
      });
      lane.balls.length = 0;
      lane.pendingMatches.length = 0;
      lane.recoil = null;
    });
    // 消滅演出中の玉は既にballsから抜けているが、まだレイヤー上にいる。
    if (PP.layers) [PP.layers.ballUnder, PP.layers.ballOver].forEach(function (layer) {
      if (!layer) return;
      layer.children.slice().forEach(function (view) {
        removeView(view);
        PP.ball.releaseView(view);
      });
    });
    PP.game.ballsDirty = true;
  }
  PP.lifecycle = { stopTweens: stopTweens, removeView: removeView,
    clearShots: clearShots, clearLanes: clearLanes };
})();
