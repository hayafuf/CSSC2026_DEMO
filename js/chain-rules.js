/* chain-rules.js — 描画・得点を変更しないチェーンの判定。
 * balls[0]が樽側の先頭。dは洞窟からの距離(px)で、配列順に小さくなる。 */
(function () {
  "use strict";
  var PP = window.PP;
  function colorRun(balls, index, spacing) {
    if (index < 0 || index >= balls.length) return null;
    var color = balls[index].color;
    if (color == null || balls[index].treasure) return null;
    var first = index, last = index;
    while (first > 0 && !balls[first - 1].treasure && balls[first - 1].color === color &&
        balls[first - 1].d - balls[first].d <= spacing + 1) first--;
    while (last + 1 < balls.length && !balls[last + 1].treasure && balls[last + 1].color === color &&
        balls[last].d - balls[last + 1].d <= spacing + 1) last++;
    return { first: first, last: last, count: last - first + 1 };
  }
  function treasureHasOwner(balls, index, spacing) {
    var treasure = balls[index];
    if (index > 0 && !balls[index - 1].treasure) return true;
    var behind = balls[index + 1];
    return !!behind && !behind.treasure && behind.wave === treasure.wave &&
      treasure.d - behind.d <= spacing + 0.5;
  }
  PP.chainRules = { colorRun: colorRun, treasureHasOwner: treasureHasOwner };
})();
