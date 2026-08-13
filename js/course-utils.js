/* =========================================================
 * course-utils.js — コースデータの正規化・複製
 *
 * course-api.js と editor.js の双方で扱う、表示に依存しないデータ操作を
 * まとめる。ゲーム用レーンと編集用レーンで「空配列を残すか」が異なるため、
 * copyLane / copyEditableLane を分けて意図を明確にしている。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  function isNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function copyPoint(point) {
    var copy = [+point[0], +point[1]];
    if (point.length > 2 && isNumber(+point[2])) copy.push(+point[2]);
    return copy;
  }

  function copyPoints(points) {
    return (points || []).map(copyPoint);
  }

  function copySpans(spans) {
    return (spans || []).map(function (span) {
      return { from: span.from, to: span.to };
    });
  }

  function copyLane(lane) {
    var copy = { ctrl: copyPoints(lane.ctrl) };
    if (lane.tunnels) copy.tunnels = copySpans(lane.tunnels);
    if (lane.raised) copy.raised = copySpans(lane.raised);
    if (lane.raisedOver) copy.raisedOver = lane.raisedOver.slice();
    return copy;
  }

  function copyEditableLane(lane) {
    return {
      ctrl: copyPoints(lane.ctrl),
      tunnels: copySpans(lane.tunnels),
      raised: copySpans(lane.raised)
    };
  }

  function normalizeCtrl(spec) {
    var ctrl = spec.ctrl;
    if (!ctrl && spec.lanes && spec.lanes[0]) ctrl = spec.lanes[0].ctrl;
    if (!Array.isArray(ctrl)) return [];
    return ctrl.map(function (point) {
      if (Array.isArray(point)) return copyPoint(point);
      if (point && isNumber(point.x) && isNumber(point.y)) return [+point.x, +point.y];
      return [NaN, NaN];
    });
  }

  function normalizeSpans(spans) {
    if (!Array.isArray(spans)) return undefined;
    var normalized = [];
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      var from = span && span.from !== undefined ? span.from : span && span[0];
      var to = span && span.to !== undefined ? span.to : span && span[1];
      if (isNumber(+from) && isNumber(+to)) normalized.push({ from: +from, to: +to });
    }
    return normalized.length ? normalized : undefined;
  }

  function normalizeRaisedOver(indices) {
    if (!Array.isArray(indices)) return undefined;
    var normalized = [];
    for (var i = 0; i < indices.length; i++) {
      var index = Math.round(+indices[i]);
      if (isNumber(index) && index >= 0 && normalized.indexOf(index) < 0) normalized.push(index);
    }
    return normalized.length ? normalized : undefined;
  }

  function normalizeSpeed(speed) {
    if (!speed || typeof speed !== "object") return undefined;
    var normalized;
    for (var key in PP.SPEED) {
      if (isNumber(+speed[key])) {
        normalized = normalized || {};
        normalized[key] = +speed[key];
      }
    }
    return normalized;
  }

  function normalizeLanes(spec) {
    var lanes = spec.lanes && spec.lanes.length ? spec.lanes : null;
    if (!lanes) return [{ ctrl: normalizeCtrl(spec) }];
    return lanes.map(function (laneSpec) {
      var lane = { ctrl: normalizeCtrl(laneSpec) };
      var tunnels = normalizeSpans(laneSpec.tunnels);
      var raised = normalizeSpans(laneSpec.raised);
      var raisedOver = normalizeRaisedOver(laneSpec.raisedOver);
      if (tunnels) lane.tunnels = tunnels;
      if (raised) lane.raised = raised;
      if (raisedOver) lane.raisedOver = raisedOver;
      return lane;
    });
  }

  PP.courseUtils = {
    isNumber: isNumber,
    copyPoint: copyPoint,
    copyPoints: copyPoints,
    copySpans: copySpans,
    copyLane: copyLane,
    copyEditableLane: copyEditableLane,
    normalizeCtrl: normalizeCtrl,
    normalizeSpans: normalizeSpans,
    normalizeRaisedOver: normalizeRaisedOver,
    normalizeSpeed: normalizeSpeed,
    normalizeLanes: normalizeLanes
  };
})();
