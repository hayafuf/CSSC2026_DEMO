"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(initial) {
  const data = new Map(Object.entries(initial || {}));
  const storage = {
    get length() { return data.size; },
    key: i => [...data.keys()][i],
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  const PP = { W: 1300, CANNON_Y: 648, SPEED: { entry: 800, hole: 22, curve: 1.3 },
    i18n: { t: (key, args) => key + JSON.stringify(args || {}) } };
  const context = vm.createContext({ window: { PP }, localStorage: storage });
  for (const file of ["course-utils", "course-api", "editor-model"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/" + file + ".js"), "utf8"), context);
  return { api: PP.courseAPI, utils: PP.courseUtils, storage, data, PP };
}
const spec = { name: "roundtrip", nameKey: "course.test", sharp: true, corner: 0,
  speed: { entry: 123 }, boss: true, spawnCluster: 0, dropMult: 0, skullMult: 0,
  lanes: [{ ctrl: [[0, 100], [1000, 100], [1000, 600]], raisedOver: [1] },
    { ctrl: [[0, 200], [1000, 200], [1000, 500]] }] };

test("course clone/JSON preserves gameplay metadata including zero", () => {
  const { api } = setup();
  const restored = api.fromJSON(api.create(spec).clone().toJSON()).toCourse();
  for (const key of ["name", "nameKey", "corner", "boss", "spawnCluster", "dropMult", "skullMult"])
    assert.equal(restored[key], spec[key], key);
  assert.equal(restored.speed.entry, 123);
  assert.deepEqual(Array.from(restored.lanes[0].raisedOver), [1]);
});
test("reserved storage name never overwrites the slot index", () => {
  const { api, data } = setup();
  api.create(spec).save("existing");
  const before = data.get("pp.course.index");
  assert.throws(() => api.create(spec).save("index"));
  assert.equal(data.get("pp.course.index"), before);
  api.create(spec).save("next");
  assert.deepEqual(Array.from(api.slots()), ["existing", "next"]);
});
test("damaged index recovers only course entries without deleting unrelated data", () => {
  const { api, data } = setup({ "pp.course.index": JSON.stringify(spec),
    "pp.course.saved": JSON.stringify(spec), "pp.course.bad": "broken", "unrelated": "keep" });
  assert.deepEqual(Array.from(api.slots()), ["saved"]);
  api.create(spec).save("next");
  assert.deepEqual(Array.from(api.slots()), ["saved", "next"]);
  assert.equal(data.get("unrelated"), "keep");
});
test("index write failure is reported and course write is rolled back", () => {
  const { api, storage, data } = setup({ "pp.course.index": "[]" });
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key === "pp.course.index") throw Error("quota"); write(key, value); };
  assert.throws(() => api.create(spec).save("new"), /quota/);
  assert.equal(data.has("pp.course.new"), false);
});

test("editor history preserves metadata and lane references without aliasing", () => {
  const { api, utils, PP } = setup();
  const state = { history: [], redo: [] };
  const model = PP.createEditorModel(state);
  model.loadCourse(api.create(spec));
  const before = model.currentCourse().toJSON();
  model.pushHistory();
  state.ctrl[0][0] = 999;
  state.metadata.speed.entry = 500;
  utils.removeLane(state.lanes, 1);
  assert.deepEqual(Array.from(state.lanes[0].raisedOver), []);
  model.restore(state.history.pop());
  assert.equal(model.currentCourse().toJSON(), before);
  assert.equal(state.ctrl, state.lanes[state.laneIdx].ctrl);
});
test("deleting a lane shifts raisedOver references after the deleted index", () => {
  const { utils } = setup();
  const lanes = [{ raisedOver: [1, 2] }, {}, {}];
  utils.removeLane(lanes, 1);
  assert.deepEqual(lanes[0].raisedOver, [1]);
});
test("course defaults distinguish zero from missing values", () => {
  const { utils } = setup();
  assert.equal(utils.valueOr({ spawnCluster: 0 }, "spawnCluster", 0.35), 0);
  assert.equal(utils.valueOr({}, "spawnCluster", 0.35), 0.35);
  assert.equal(utils.valueOr(null, "dropMult", 1), 1);
});
test("storage access and data write failures are surfaced", () => {
  const { api, storage } = setup();
  storage.getItem = () => { throw Error("access denied"); };
  assert.throws(() => api.slots(), /access denied/);
  assert.throws(() => api.create(spec).save("new"), /access denied/);
});
