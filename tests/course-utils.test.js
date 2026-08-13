"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var vm = require("node:vm");

function loadCourseUtils() {
  var context = {
    window: {
      PP: {
        SPEED: { entry: 800, hole: 22, curve: 1.3 }
      }
    }
  };
  var source = fs.readFileSync(path.join(__dirname, "..", "js", "course-utils.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "course-utils.js" });
  return context.window.PP.courseUtils;
}

// VM 内で作られた配列を通常のプレーンデータへ戻して比較する。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("単一レーンの旧形式とオブジェクト座標を正規化できる", function () {
  var utils = loadCourseUtils();
  var lanes = utils.normalizeLanes({ ctrl: [[1, 2, 0], { x: 3, y: 4 }] });
  assert.deepEqual(plain(lanes), [{ ctrl: [[1, 2, 0], [3, 4]] }]);
});

test("複数レーンの区間指定と橋の相手を正規化する", function () {
  var utils = loadCourseUtils();
  var lanes = utils.normalizeLanes({
    lanes: [{
      ctrl: [[0, 0], [10, 10]],
      tunnels: [[0.1, 0.2]],
      raised: [{ from: 0.3, to: 0.4 }],
      raisedOver: [1, 1, "2"]
    }]
  });
  assert.deepEqual(plain(lanes), [{
    ctrl: [[0, 0], [10, 10]],
    tunnels: [{ from: 0.1, to: 0.2 }],
    raised: [{ from: 0.3, to: 0.4 }],
    raisedOver: [1, 2]
  }]);
});

test("ゲーム用コピーは元データと配列を共有しない", function () {
  var utils = loadCourseUtils();
  var source = {
    ctrl: [[1, 2, 3]],
    tunnels: [{ from: 0.1, to: 0.2 }],
    raisedOver: [2]
  };
  var copy = utils.copyLane(source);
  copy.ctrl[0][0] = 99;
  copy.tunnels[0].from = 0.9;
  copy.raisedOver.push(3);
  assert.equal(source.ctrl[0][0], 1);
  assert.equal(source.tunnels[0].from, 0.1);
  assert.deepEqual(source.raisedOver, [2]);
});

test("編集用コピーは欠けた区間を空配列で補う", function () {
  var utils = loadCourseUtils();
  assert.deepEqual(plain(utils.copyEditableLane({ ctrl: [[1, 2]] })), {
    ctrl: [[1, 2]], tunnels: [], raised: []
  });
});
