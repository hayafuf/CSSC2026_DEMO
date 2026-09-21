"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withBrowser } = require("./browser-client");

async function run() {
  await withBrowser(async browser => {
    let baseline;
    for (const query of ["?gl=0", "?gl=1"]) {
      await browser.navigate(query);
      await browser.ready();
      const result = await browser.evaluate(`(${scenarios.toString()})()`);
      assert.equal(result.gl, query === "?gl=1", "requested renderer must be active");
      if (baseline) assert.deepEqual(result.courses, baseline, "renderer must not alter simulation");
      baseline = result.courses;
      console.log(query, JSON.stringify(result));
    }
    // Test the actual controller's death callback, with private setup confined to this test page.
    await browser.evaluate("PP.boss.setActive(false)");
    const source = fs.readFileSync(path.join(__dirname, "../js/boss.js"), "utf8");
    const setup = `
      PP.__lethalTest = function () {
        hp = 1; iFrames = 0; guardT = 0;
        for (var i = 0; i < 2; i++) {
          spawnBullet('freeze', battle.body.x, battle.body.y - 20, 0, 0, 0, 10);
          battle.bullets[battle.bullets.length - 1].reflected = true;
        }
        updateBullets(0);
        return { hp: hp, state: battle.state, bullets: battle.bullets.length };
      };
    `;
    const end = source.lastIndexOf("})();");
    await browser.evaluate(source.slice(0, end) + setup + source.slice(end));
    const death = await browser.evaluate("PP.boss.setActive(true); PP.__lethalTest()");
    assert.deepEqual(death, { hp: 0, state: "dying", bullets: 0 });
    // Deliberately delay the loader past editor attachment, then send duplicate / late callbacks.
    const encoded = await browser.evaluate("PP.courseAPI.fromBuiltin(0).encode()");
    const { identifier } = await browser.command("Page.addScriptToEvaluateOnNewDocument", { source: `
      let root;
      Object.defineProperty(window, 'PP', { configurable: true, get: () => root, set: value => {
        root = value;
        if (Object.getOwnPropertyDescriptor(value, 'audio')) return;
        let audio;
        Object.defineProperty(value, 'audio', { configurable: true, get: () => audio, set: value => {
          audio = value;
          audio.preload = (progress, done) => { window.__lateProgress = progress; window.__lateDone = done; };
        }});
      }});
    ` });
    for (const edit of [false, true]) {
      await browser.navigate((edit ? "?editcourse=1&course=" : "?course=") + encoded);
      await browser.evaluate(`new Promise(resolve => {
        const timer = setInterval(() => {
          if (window.PP && PP.editor && window.__lateDone) { clearInterval(timer); resolve(true); }
        }, 20);
      })`);
      const state = await browser.evaluate(`(() => {
        __lateDone(); const before = PP.game.state;
        PP.hud.hideOverlay(); __lateDone(); __lateProgress(1, 2);
        return { before, after: PP.game.state, editor: PP.editor.active,
          custom: !!PP.game.customCourse, overlay: PP.layers.overlay.visible };
      })()`);
      assert.equal(state.before, edit ? "title" : "intro");
      assert.equal(state.after, state.before);
      assert.equal(state.editor, edit); assert.equal(state.custom, !edit);
      assert.equal(state.overlay, false);
    }
    await browser.command("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    console.log("Lethal reflection and delayed shared-URL startup passed");
    // Chromium touch emulation checks real pointer events; this is not a real-device test.
    await browser.command("Emulation.setDeviceMetricsOverride", {
      width: 1300, height: 900, deviceScaleFactor: 1, mobile: true
    });
    await browser.command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await browser.navigate("?gl=1"); await browser.ready();
    assert.equal(await browser.evaluate(`(() => {
      createjs.Ticker.removeAllEventListeners('tick');
      PP.tut.setEnabled(false); PP.audio.setMuted(true);
      PP.playCourse(PP.COURSES[0]); PP.skipIntro();
      return PP.TOUCH && PP.glActive;
    })()`), true);
    async function touch(id, afterDown) {
      const point = await browser.evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        element.scrollIntoView({ block: 'nearest' });
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) throw Error('Hidden touch control');
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await browser.command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      if (afterDown) await afterDown();
      await browser.command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await touch("tFire");
    assert.ok(await browser.evaluate("PP.game.shots.length > 0"), "touch fire");
    const xBefore = await browser.evaluate("PP.cannon.x");
    await touch("tRight", () => browser.evaluate("PP.input.update(0.1)"));
    const xAfter = await browser.evaluate("PP.cannon.x");
    assert.ok(xAfter > xBefore, "touch movement");
    assert.equal(await browser.evaluate("PP.input.update(0.1); PP.cannon.x"), xAfter, "release stops movement");
    console.log("Chromium touch controls passed");
    assert.deepEqual(browser.errors, [], "uncaught browser exceptions");
  });
}

async function scenarios() {
  function check(condition, message) { if (!condition) throw Error(message); }
  const g = PP.game;
  const listeners = (createjs.Ticker._listeners.tick || []).slice();
  createjs.Ticker.removeAllEventListeners("tick");
  if (PP.tut) PP.tut.setEnabled(false);
  if (PP.pauseCtl.active) PP.pauseCtl.resume();
  PP.audio.setMuted(true);
  let seed = 123456;
  Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const courseResults = [];
  for (let index = 0; index < PP.COURSES.length; index++) {
    g.difficulty = index === 4 ? "gale" : "normal";
    g.level = index + 1; g.customCourse = null;
    PP.session.startLevel(); PP.skipIntro();
    for (let frame = 0; frame < 600 && g.state === "playing"; frame++) {
      if (frame % 12 === 0) { PP.cannon.setX(100 + (frame * 7) % 1100); PP.cannon.fire(); }
      PP.session.updatePlaying(1 / 60);
      PP.chainView.render();
      for (const lane of g.lanes) for (let i = 0; i < lane.balls.length; i++) {
        check(Number.isFinite(lane.balls[i].d), "non-finite distance");
        if (i) check(lane.balls[i - 1].d >= lane.balls[i].d - 0.01, "chain order");
      }
    }
    PP.stage.update();
    courseResults.push({ course: index + 1, state: g.state, score: g.score,
      counts: g.lanes.map(lane => lane.balls.length) });
  }
  // Victory and overflow in the same update must produce exactly one transition.
  const attackKeys = ["ink", "addle", "freeze", "shotSlow", "randomize", "tentacle", "tsunami", "barrage", "cross", "thunder"];
  for (const attack of attackKeys) {
    g.level = 6; g.customCourse = null; g.difficulty = "normal";
    PP.session.startLevel(); PP.skipIntro();
    check(PP.boss.forceAttack(attack), "force attack: " + attack);
    for (let frame = 0; frame < 720; frame++) PP.boss.update(1 / 60);
    check(Number.isFinite(PP.boss.getHp()), "boss HP: " + attack);
    PP.stage.update();
  }
  g.difficulty = "normal"; PP.playCourse(PP.COURSES[2]); PP.skipIntro();
  PP.lifecycle.clearLanes();
  function ball(d, color) { return { d, color, wave: 1, pull: 0, slide: 0, view: PP.ball.acquireView(color) }; }
  g.lanes[0].balls = [ball(300, 1), ball(252, 1), ball(204, 1)];
  g.lanes[1].balls = [ball(300, 2)];
  check(PP.chain.resolveMatchAt(g.lanes[0], 1, false), "three-ball match");
  check(g.lanes[0].balls.length === 0 && g.lanes[1].balls.length === 1, "lane-independent match");
  PP.lifecycle.clearLanes();
  // Two separated ranges in each lane: deleting the first must not shift the second target.
  for (const lane of g.lanes) {
    lane.balls = [ball(300, 0), ball(252, 1), ball(204, 2), ball(156, 3)];
    lane.balls.push({ d: 100, color: null, treasure: true, wave: 1, view: PP.ball.makeTreasureView() });
    lane.rail = { tunnelAt: () => false, posAtInto: (d, out) => {
      out.x = d === 252 || d === 156 ? 900 : 100; out.y = 100; return out;
    }, posAt: d => ({ x: d === 252 || d === 156 ? 900 : 100, y: 100 }) };
  }
  PP.chain.explodeAt(100, 100);
  for (const lane of g.lanes) check(lane.balls.map(b => b.d).join() === "252,156,100", "bomb range removal");
  check(PP.chain.pierceSegment(900, 50, 150) === 4, "missile across lanes");
  for (const lane of g.lanes) check(lane.balls.every(b => b.treasure), "special shots preserve treasure");
  g.builtCourse = null; PP.playCourse(PP.COURSES[0]); PP.skipIntro();
  g.effects.reverse = 2; g.effects.stop = 5;
  PP.powerups.update(0.1);
  check(g.effects.stop === 5 && g.effects.reverse < 2, "reverse preserves stop duration");
  g.effects.reverse = 0; PP.powerups.update(0.1);
  check(g.effects.stop < 5, "stop timer resumes after reverse");
  // Retry preserves the run and removes its veil on a new editor/session transition.
  g.score = 1234; g.coins = 2; g.upgrades.coin = 1;
  PP.retryLevel(); PP.session.updateRetry(PP.RETRY.freeze + 0.01);
  PP.session.updateRetry(PP.RETRY.veilTime + 0.01);
  check(g.state === "playing" && g.score === 1234 && g.coins === 2 && g.upgrades.coin === 1, "retry retention");
  check(Object.values(g.effects).every(value => value === 0), "retry clears temporary effects");
  // Restrict available cards to the two whose displayed values previously diverged.
  PP.UPGRADES.forEach(def => { g.upgrades[def.id] = def.max; });
  g.upgrades.coin = 2; g.upgrades.wildshot = 0; g.wildBonus = 2;
  PP.upgrades.recalcWildMax();
  PP.upgrades.requestChoice(); PP.upgrades.openChoice();
  const cardText = [];
  function collectText(view) {
    if (view.text) cardText.push(view.text);
    if (view.children) view.children.forEach(collectText);
  }
  collectText(PP.stage);
  check(cardText.includes(PP.i18n.t("ug.prev.coin", { a: 3, b: 3 })), "coin preview matches minimum");
  check(cardText.includes(PP.i18n.t("ug.prev.wildshot", {
    a: PP.WILD.baseMax + 2, b: PP.WILD.baseMax + 3 })), "wild preview includes continue bonus");
  PP.upgrades.choose("wildshot");
  check(g.wildMax === PP.WILD.baseMax + 3, "wild preview matches applied capacity");
  PP.upgrades.onRunReset();
  g.level = 6; g.customCourse = null; g.lives = 2; g.score = 0;
  PP.session.startLevel(); PP.skipIntro();
  const lane = g.lanes[0]; PP.chain.update(1 / 60);
  lane.balls[0].d = lane.rail.holeD + PP.D * (PP.barrelCap() + 2);
  const update = PP.boss.update, consume = PP.boss.consumeVictory;
  PP.boss.update = () => {}; PP.boss.consumeVictory = () => true;
  PP.session.updatePlaying(1 / 60);
  PP.boss.update = update; PP.boss.consumeVictory = consume;
  check(g.state === "gameclear" && g.lives === 2 && g.score === 6000, "victory/overflow");

  PP.playCourse(PP.COURSES[0]); PP.skipIntro();
  PP.pauseCtl.pause("manual"); PP.editor.open();
  check(!PP.editor.active, "editor must reject paused entry");
  PP.playCourse(PP.COURSES[0]);
  check(!PP.pauseCtl.active && !createjs.Ticker.paused, "new play must reset pause");
  const view = new createjs.Container(), glow = new createjs.Shape();
  view.glow = glow; view.addChild(glow); PP.layers.ballUnder.addChild(view);
  g.lanes[0].balls.push({ treasure: true, view, d: 0 });
  createjs.Tween.get(glow, { loop: true }).to({ alpha: 0 }, 100);
  PP.editor.open();
  check(!createjs.Tween.hasActiveTweens(glow), "orphan treasure tween");
  check(!view.parent, "orphan treasure view");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const container = PP.stage.getChildAt(PP.stage.numChildren - 1);
  if (PP.glActive) {
    check(!!container.cacheCanvas, "editor must be cached in GL");
    const pixels = container.cacheCanvas.getContext("2d").getImageData(0, 0, PP.W, PP.H).data;
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 70) bright++;
    check(bright > 500, "editor preview must contain visible content");
  }
  const promptBefore = window.prompt, alertBefore = window.alert;
  const specimen = { name: "UI roundtrip", sharp: true, corner: 0, speed: { entry: 123 },
    spawnCluster: 0, dropMult: 0, skullMult: 0,
    lanes: [{ ctrl: [[80, 100], [1000, 100], [1000, 550]], raisedOver: [1] },
      { ctrl: [[80, 250], [900, 250], [900, 500]] }] };
  function click(name) {
    const button = [...document.querySelectorAll("button")].find(b => b.onclick && b.onclick.name === name);
    check(!!button, "editor button: " + name); button.click();
  }
  function exported() {
    let result;
    window.prompt = (message, text) => { result = JSON.parse(text); return null; };
    click("exportJSON"); return result;
  }
  window.alert = message => { throw Error(message); };
  window.prompt = () => JSON.stringify(specimen); click("importJSON");
  const original = exported();
  check(original.name === specimen.name && original.speed.entry === 123 && original.spawnCluster === 0,
    "editor import/export metadata");
  check(original.lanes[0].raisedOver[0] === 1, "editor bridge relationships");
  await new Promise(resolve => requestAnimationFrame(resolve));
  const world = container.getChildAt(1);
  const handle = world.children.find(child => child.hasEventListener("pressmove"));
  check(!!handle, "editor handle");
  const position = handle.localToGlobal(0, 0);
  check(PP.stage.getObjectUnderPoint(position.x, position.y, 2) === handle, "cached editor hit testing");
  handle.dispatchEvent({ type: "mousedown", stageX: position.x, stageY: position.y });
  handle.dispatchEvent({ type: "pressmove", stageX: position.x + 30, stageY: position.y + 25 });
  handle.dispatchEvent({ type: "pressup" });
  check(exported().ctrl[0][0] !== original.ctrl[0][0], "editor drag updates model");
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true }));
  check(JSON.stringify(exported()) === JSON.stringify(original), "editor undo preserves full course");
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", ctrlKey: true }));
  check(exported().ctrl[0][0] !== original.ctrl[0][0], "editor redo");
  window.prompt = () => "regression-slot"; window.alert = () => {};
  click("save");
  check(PP.courseAPI.load("regression-slot").speed.entry === 123, "editor storage roundtrip");
  PP.courseAPI.remove("regression-slot");
  window.prompt = promptBefore; window.alert = alertBefore;
  PP.stage.update(); PP.editor.close();
  // Radius zero describes a sharp right angle, not the default rounded corner.
  const sharp = PP.courseAPI.create({ sharp: true, corner: 0,
    ctrl: [[0, 100], [1000, 100], [1000, 600]] });
  check(Math.abs(PP.rail.measure(sharp.toCourse(), 0).length - 1500) < 0.01, "zero corner radius");
  // Exercise all difficulty profiles and the run/continue retention rules.
  for (const difficulty of PP.DIFFICULTY_ORDER) {
    g.difficulty = difficulty; PP.session.newRun(1); PP.skipIntro();
    PP.session.updatePlaying(1 / 60);
    check(g.nColors > 0 && Number.isFinite(g.timeTotal), "difficulty: " + difficulty);
  }
  g.difficulty = "normal"; g.level = 2; g.score = 123; g.coins = 2; g.upgrades.coin = 1;
  PP.session.continueRun();
  check(g.level === 2 && g.score === 0 && g.coins === 0 && g.upgrades.coin === 1, "continue retention");
  check(g.continues === 1 && g.wildBonus === 1 && g.wildCharges === g.wildMax, "continue bonus");
  PP.returnToTitle();
  check(g.state === "title" && g.score === 0 && g.continues === 0 && !g.customCourse, "return to title");
  // Restore the real main loop and verify several actual ticks after the simulations.
  listeners.forEach(listener => createjs.Ticker.addEventListener("tick", listener));
  PP.session.newRun(1); PP.skipIntro();
  for (let frame = 0; frame < 5; frame++) createjs.Ticker.dispatchEvent({ type: "tick", delta: 1000 / 60 });
  return { gl: PP.glActive, courses: courseResults, regressions: "passed" };
}
run().catch(error => { console.error(error); process.exitCode = 1; });
