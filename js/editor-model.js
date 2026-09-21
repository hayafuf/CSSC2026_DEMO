/* editor-model.js — 編集データと取消履歴。DOM・CreateJSに依存しない。
 * ED.ctrlと選択中レーンのctrlは、常に同じ配列を参照する。 */
(function () {
  "use strict";
  var PP = window.PP;
  PP.createEditorModel = function (ED) {
    var HISTORY_MAX = 50;
    var courseUtils = PP.courseUtils;
    var copyLane = courseUtils.copyEditableLane, copyCtrl = courseUtils.copyPoints;
    function copyLanes(a) { return a.map(copyLane); }

    function newLane() { return { ctrl: [], tunnels: [], raised: [] }; }

    function lanesFrom(list) {
      return (list && list.length ? list : [newLane()]).map(copyLane);
    }

    function activeLane() { return ED.lanes[ED.laneIdx]; }

    function commitCtrl() { if (activeLane()) activeLane().ctrl = ED.ctrl; }

    function selectLane(i) {
      commitCtrl();
      ED.laneIdx = Math.max(0, Math.min(ED.lanes.length - 1, i));
      ED.ctrl = activeLane().ctrl;
      ED.sel = -1; ED.spanStart = null;
    }

    function currentCourse() {
      commitCtrl();
      return PP.courseAPI.create(courseUtils.copyMetadata(ED.metadata, {
        sharp: ED.sharp, corner: ED.corner,
        overpass: ED.overpass, lanes: copyLanes(ED.lanes)
      }));
    }

    function snapshot() {
      commitCtrl();   // ED.ctrl の最新を lanes に反映してから丸ごと保存
      return {
        metadata: courseUtils.copyMetadata(ED.metadata),
        lanes: copyLanes(ED.lanes), laneIdx: ED.laneIdx,
        sharp: ED.sharp, corner: ED.corner, overpass: ED.overpass, sel: ED.sel
      };
    }

    function restore(s) {
      ED.metadata = courseUtils.copyMetadata(s.metadata || {});
      // 旧形式(ctrl だけ)の履歴も一応受ける
      ED.lanes = s.lanes ? copyLanes(s.lanes) : [{ ctrl: copyCtrl(s.ctrl || []), tunnels: [], raised: [] }];
      ED.laneIdx = Math.max(0, Math.min(ED.lanes.length - 1, s.laneIdx || 0));
      ED.ctrl = activeLane().ctrl;
      ED.spanStart = null;
      ED.sharp = s.sharp; ED.corner = s.corner; ED.overpass = s.overpass;
      ED.sel = (typeof s.sel === "number" && s.sel < ED.ctrl.length) ? s.sel : -1;
    }

    function pushSnapshot(s) {
      ED.history.push(s);
      if (ED.history.length > HISTORY_MAX) ED.history.shift();
      ED.redo.length = 0;   // 新しい操作をしたらやり直しは無効
    }

    function pushHistory() { pushSnapshot(snapshot()); }

    function loadCourse(c) {
      ED.metadata = courseUtils.copyMetadata(c);
      ED.lanes = lanesFrom(c.lanes);
      ED.laneIdx = 0; ED.ctrl = activeLane().ctrl;
      ED.sharp = c.sharp; ED.corner = c.corner; ED.overpass = c.overpass;
      ED.sel = -1; ED.spanStart = null;
    }
    return {
      copyLanes: copyLanes,
      newLane: newLane,
      lanesFrom: lanesFrom,
      activeLane: activeLane,
      commitCtrl: commitCtrl,
      selectLane: selectLane,
      currentCourse: currentCourse,
      snapshot: snapshot,
      restore: restore,
      pushSnapshot: pushSnapshot,
      pushHistory: pushHistory,
      loadCourse: loadCourse
    };
  };
})();
