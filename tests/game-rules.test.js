"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function load(file, PP, extras = {}) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/" + file + ".js"), "utf8"),
    { window: { PP }, ...extras }, { filename: file + ".js" });
}

test("matching follows contact, color, and treasure boundaries", () => {
  const PP = {}; load("chain-rules", PP);
  const balls = [144, 96, 48].map(d => ({ d, color: 2 }));
  assert.equal(PP.chainRules.colorRun(balls, 1, 48).count, 3);
  balls[2].d = 0;
  assert.equal(PP.chainRules.colorRun(balls, 1, 48).count, 2);
  balls[0].treasure = true;
  assert.equal(PP.chainRules.colorRun(balls, 0, 48), null);
  assert.equal(PP.chainRules.colorRun(balls, 1, 48).count, 1);
  assert.equal(PP.chainRules.colorRun(balls, -1, 48), null);
});
test("treasure ownership respects the preceding group and following wave", () => {
  const PP = {}; load("chain-rules", PP);
  const treasure = { treasure: true, d: 100, wave: 2 };
  assert.equal(PP.chainRules.treasureHasOwner([treasure], 0, 48), false);
  assert.equal(PP.chainRules.treasureHasOwner([{ color: 1 }, treasure], 1, 48), true);
  assert.equal(PP.chainRules.treasureHasOwner([treasure, { color: 1, wave: 2, d: 52 }], 0, 48), true);
  assert.equal(PP.chainRules.treasureHasOwner([treasure, { color: 1, wave: 3, d: 52 }], 0, 48), false);
});
test("reflected lethal hit can clear all bullets without double removal", () => {
  const PP = { game: {}, BOSS: { orb: {} }, cannon: { x: 0, y: 500 },
    PARRY: { reflectSpeed: 100 }, fx: { particleLoad: () => 0 } };
  load("boss-projectiles", PP);
  for (const lethal of [false, true]) {
    const battle = { bullets: [], body: { x: 100, y: 100 }, state: "idle", inkBlobs: [] };
    let hits = 0, projectiles;
    projectiles = PP.createBossProjectiles(battle, { attacks: {}, noParry: {},
      hitTest: () => true, onHit: () => {
        hits++;
        if (lethal) { battle.state = "dying"; projectiles.clearBullets(); }
      } });
    for (let i = 0; i < 2; i++) battle.bullets.push({ reflected: true, type: "freeze",
      x: 100, y: 80, t: 0, view: {} });
    assert.doesNotThrow(() => projectiles.updateBullets(0));
    assert.equal(battle.bullets.length, 0);
    assert.equal(hits, lethal ? 1 : 2);
  }
});
test("startup waits for both dependencies and handles the URL once", () => {
  for (const order of [["audio", "editor"], ["editor", "audio"]]) {
    let titles = 0, urls = 0;
    const PP = { game: { state: "loading" }, courseAPI: { checkURL: () => urls++ } };
    load("startup", PP);
    PP.startup.begin(() => { titles++; PP.game.state = "title"; });
    PP.startup.ready(order[0]); assert.equal(urls, 0);
    PP.startup.ready(order[1]); PP.startup.ready(order[0]);
    assert.equal(titles, 1); assert.equal(urls, 1);
    assert.equal(PP.startup.isLoading(), false);
  }
});
test("late startup completion cannot overwrite an API-started game", () => {
  const PP = { game: { state: "loading" }, courseAPI: { checkURL: () => assert.fail("URL rerun") } };
  load("startup", PP);
  PP.startup.begin(() => assert.fail("title overwrite"));
  PP.startup.ready("editor"); PP.game.state = "playing";
  PP.startup.ready("audio");
  assert.equal(PP.game.state, "playing");
});
test("cleanup stops owned tweens without stopping persistent UI", () => {
  const glow = {}, spark = {}, persistentUI = {};
  const active = new Set([glow, spark, persistentUI]);
  let released = 0;
  const PP = { game: {
    lanes: [{ balls: [{ view: { children: [glow] } }], pendingMatches: [1], recoil: {} }],
    shots: [{ view: { children: [spark] } }]
  }, ball: { releaseView: () => released++ } };
  load("lifecycle", PP, { createjs: { Tween: { removeTweens: view => active.delete(view) } } });
  PP.lifecycle.clearLanes(); PP.lifecycle.clearShots();
  assert.equal(active.size, 1); assert.ok(active.has(persistentUI));
  assert.equal(released, 1); assert.equal(PP.game.lanes[0].balls.length, 0);
  assert.equal(PP.game.shots.length, 0);
});

test("audio timeout ignores late progress and completes only once", () => {
  const elements = [], timers = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.readyState = 0; this.events = {}; elements.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    removeEventListener(name) { delete this.events[name]; }
    load() {}
  }
  const PP = { AUDIO: {} };
  load("audio", PP, { Audio: FakeAudio, URLSearchParams, location: { search: "?se=html" },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  let completed = 0, progress = 0;
  PP.audio.preload(() => progress++, () => completed++);
  assert.equal(completed, 0);
  timers[0]();
  for (const element of elements) if (element.events.error) element.events.error();
  assert.equal(completed, 1);
  assert.equal(progress, 0);
});
