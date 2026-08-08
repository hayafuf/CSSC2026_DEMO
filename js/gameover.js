/* =========================================================
 * gameover.js — ゲームオーバーの演出
 *
 * 怖さは「音を足すこと」ではなく「奪うこと」で作る。
 * 鳴り続けていた BGM をその瞬間にぶつ切りにして、無音の底に
 * 心音だけを残す。プレイヤーは自分のチェーンが樽に呑まれていく音を
 * 何もできずに聞かされる。
 *
 *   0) 静止  … 音楽が消え、盤面が凍りつく。色が抜け落ちていく
 *   1) 吸込  … 玉が加速しながら樽へ吸い込まれる。渦が回り、心音が速まる
 *   2) 呑込  … 最後の1個が消えた瞬間に渦が閉じ、画面が暗黒に落ちる
 *   3) 暗黒  … 巨大なドクロが闇からこちらへ迫り、ゲームオーバー BGM が
 *              立ち上がってから文字が出る
 *
 * マルチレーン: 各レーンの玉はそのレーンの樽の口へ吸い込まれ、渦も樽ごと。
 * 全レーンの玉が尽きた瞬間に暗黒へ落ちる。1本コースなら樽1つで従来と同一。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var built = false;
  var desat, vignette, dark, bigSkull, flash;
  var st = null;      // 進行中の状態(null なら演出していない)
  var onFinish = null;
  var desatMax = 0.95;
  var vortexes = [];  // 樽ごとの渦 { shape, mouth }

  function canBlend(mode) {
    try {
      var c = document.createElement("canvas").getContext("2d");
      c.globalCompositeOperation = mode;
      return c.globalCompositeOperation === mode;
    } catch (e) { return false; }
  }

  // 樽の口で回る渦。同心の弧をずらして重ね、回すと渦に見える
  function drawVortex(g) {
    for (var i = 0; i < 6; i++) {
      var r = 20 + i * 12;
      var dim = 0.8 - i * 0.11;
      g.setStrokeStyle(7 - i * 0.9, "round")
        .beginStroke("rgba(" + (i % 2 ? "150,12,12" : "8,4,4") + "," + dim + ")")
        .arc(0, 0, r, i * 0.85, i * 0.85 + Math.PI * 1.5)
        .endStroke();
    }
  }

  // 樽ごとの渦を、いまのレーン構成に合わせて作り直す
  function buildVortexes() {
    var L = PP.layers.doom;
    for (var k = 0; k < vortexes.length; k++) {
      if (vortexes[k].shape.parent) L.removeChild(vortexes[k].shape);
    }
    vortexes = [];
    var lanes = PP.game.lanes || [];
    for (var li = 0; li < lanes.length; li++) {
      var mouth = lanes[li].rail.posAt(lanes[li].rail.length - 1);
      var v = new createjs.Shape();
      drawVortex(v.graphics);
      v.x = mouth.x; v.y = mouth.y;
      v.alpha = 0;
      v.scaleX = v.scaleY = 0.25;
      L.addChild(v);
      vortexes.push({ shape: v, mouth: mouth });
    }
  }

  function build() {
    var L = PP.layers.doom;

    // 彩度を抜く: canvas の合成モードで下のレイヤーの色をそのまま殺す。
    desat = new createjs.Shape();
    if (canBlend("saturation")) {
      desat.graphics.beginFill("#707070").drawRect(0, 0, PP.W, PP.H);
      desat.compositeOperation = "saturation";
      desatMax = 0.95;
    } else {
      desat.graphics.beginFill("#0a0a10").drawRect(0, 0, PP.W, PP.H);
      desatMax = 0.4;
    }
    desat.alpha = 0;
    L.addChild(desat);

    // 樽ごとの渦(脱色の"上"に置くので、ここだけが血の色で残る)
    buildVortexes();

    // 血の帳(周辺減光)。心音に合わせて脈打たせる
    vignette = new createjs.Shape();
    vignette.graphics.beginRadialGradientFill(
      ["rgba(120,0,0,0)", "rgba(74,0,0,0.55)", "rgba(24,0,0,0.97)"], [0, 0.5, 1],
      PP.W / 2, PP.H / 2, 60, PP.W / 2, PP.H / 2, 580)
      .drawRect(0, 0, PP.W, PP.H);
    vignette.alpha = 0;
    L.addChild(vignette);

    dark = new createjs.Shape();
    dark.graphics.beginFill("#000").drawRect(0, 0, PP.W, PP.H);
    dark.alpha = 0;
    L.addChild(dark);

    // 闇の奥からこちらへ迫ってくるドクロ
    bigSkull = new createjs.Text("☠", "bold 300px serif", "#8c0f0f");
    bigSkull.textAlign = "center";
    bigSkull.textBaseline = "middle";
    bigSkull.x = PP.W / 2; bigSkull.y = PP.H / 2 - 8;
    bigSkull.alpha = 0;
    bigSkull.scaleX = bigSkull.scaleY = 0.5;
    L.addChild(bigSkull);

    // 一瞬だけ視界を焼く血の色
    flash = new createjs.Shape();
    flash.graphics.beginFill("#7d0000").drawRect(0, 0, PP.W, PP.H);
    flash.alpha = 0;
    L.addChild(flash);

    built = true;
  }

  // 心音の波形(ドッ…ドッ という二拍)
  function heart(t) {
    var p = (t % PP.OVER.beat) / PP.OVER.beat;
    return Math.exp(-p * 11) + 0.55 * Math.exp(-Math.abs(p - 0.2) * 16);
  }

  // 全樽のドクロを操作するユーティリティ
  function forEachSkull(fn) {
    if (!PP.barrels) return;
    for (var i = 0; i < PP.barrels.length; i++) {
      if (PP.barrels[i] && PP.barrels[i].skull) fn(PP.barrels[i].skull);
    }
  }

  function start(finishCb) {
    if (!built) return;
    onFinish = finishCb || null;
    st = { phase: 0, t: 0, speed: PP.OVER.suckSpeed, beat: 0, vig: 0,
           ash: 0, lunged: false, done: false };

    PP.audio.overCut();          // ここで音楽が消える。これが一番怖い
    PP.fx.shake(15, 0.5);
    PP.powerups.clear();         // 落下中のご褒美も道連れ

    flash.alpha = 0.75;
    createjs.Tween.get(flash).to({ alpha: 0 }, 420);
    createjs.Tween.get(desat).to({ alpha: desatMax }, 900);
    for (var i = 0; i < vortexes.length; i++) {
      createjs.Tween.get(vortexes[i].shape)
        .to({ alpha: 1, scaleX: 1, scaleY: 1 }, 700, createjs.Ease.quadOut);
    }

    // 樽の脇のドクロが血の色に膨れ上がる
    forEachSkull(function (sk) {
      createjs.Tween.removeTweens(sk);
      sk.color = "#ff1414";
      createjs.Tween.get(sk).to({ scaleX: 2.4, scaleY: 2.4 }, 300, createjs.Ease.backOut);
    });
  }

  // --- 1) 吸い込み: 玉が加速しながら各レーンの樽へ流れ込み、列は縮んでいく ---
  function suck(dt) {
    var g = PP.game;
    st.speed = Math.min(st.speed * Math.exp(PP.OVER.suckAccel * dt), PP.OVER.suckMax);
    var remaining = 0;
    for (var li = 0; li < g.lanes.length; li++) {
      var lane = g.lanes[li];
      var balls = lane.balls;
      var end = lane.rail.length - 4;
      for (var i = balls.length - 1; i >= 0; i--) {
        var b = balls[i];
        b.d += st.speed * (1 + i * PP.OVER.tailPull) * dt;
        if (b.d < end) continue;
        // 呑まれた: 玉は闇の中で潰れる
        var p = lane.rail.posAt(end);
        PP.fx.burst(p.x, p.y, "#1a0505", 5);
        if (b.view.parent) b.view.parent.removeChild(b.view);
        balls.splice(i, 1);
        if (i % 3 === 0) {
          PP.audio.swallow(st.speed / PP.OVER.suckMax);
          PP.fx.shake(3, 0.12);
        }
      }
      remaining += balls.length;
    }
    // 渦は残りが減るほど速く回る
    for (var vi = 0; vi < vortexes.length; vi++) {
      vortexes[vi].shape.rotation += (260 + st.speed * 0.35) * dt;
    }
    if (remaining === 0) swallowed();
  }

  // --- 2) 呑込: 最後の1個が消えた瞬間 ---
  function swallowed() {
    st.phase = 2;
    st.t = 0;
    PP.audio.overSnap();
    PP.fx.shake(22, 0.7);
    for (var vi = 0; vi < vortexes.length; vi++) {
      createjs.Tween.get(vortexes[vi].shape)
        .to({ scaleX: 0.04, scaleY: 0.04, alpha: 0 }, 420, createjs.Ease.backIn);
    }
    createjs.Tween.get(dark).to({ alpha: 0.9 }, 1100);
    st.vig = 0.85;
    // 樽の脇のドクロは玉ごと闇に溶ける
    forEachSkull(function (sk) {
      createjs.Tween.removeTweens(sk);
      createjs.Tween.get(sk).to({ alpha: 0, scaleX: 4.5, scaleY: 4.5 }, 600);
    });
  }

  // --- 3) 暗黒: 闇からドクロが迫り、BGM が立ち上がる ---
  function doom() {
    st.phase = 3;
    st.t = 0;
    PP.audio.overBgm();
    createjs.Tween.get(bigSkull)
      .to({ alpha: 0.9, scaleX: 1.55, scaleY: 1.55 }, 2600, createjs.Ease.quadOut);
  }

  function lunge() {
    createjs.Tween.get(bigSkull, { override: true })
      .to({ alpha: 1, scaleX: 3.2, scaleY: 3.2 }, 130, createjs.Ease.quadIn)
      .to({ scaleX: 2.1, scaleY: 2.1, alpha: 0.82 }, 420, createjs.Ease.quadOut);
    flash.alpha = 0.5;
    createjs.Tween.get(flash, { override: true }).to({ alpha: 0 }, 260);
    PP.fx.shake(26, 0.6);
    PP.audio.sting();
  }

  function ash() {
    var L = PP.layers.doom;
    var s = new createjs.Shape();
    var r = 1 + Math.random() * 2.2;
    s.graphics.beginFill("rgba(150,140,135,0.5)").drawCircle(0, 0, r);
    s.x = Math.random() * PP.W;
    s.y = -10;
    L.addChild(s);
    createjs.Tween.get(s)
      .to({ y: PP.H + 10, x: s.x + (Math.random() * 90 - 45), alpha: 0 },
          4000 + Math.random() * 4000)
      .call(function () { L.removeChild(s); });
  }

  function update(dt) {
    if (!st) return;
    st.t += dt;

    if (st.phase < 3) {
      st.beat -= dt;
      if (st.beat <= 0) {
        st.beat = PP.OVER.beat * (st.phase === 1 ? 0.62 : 1);
        PP.audio.heartbeat();
      }
    }

    var beatT = st.phase === 1 ? st.t * 1.6 : st.t;
    vignette.alpha = st.vig * (0.82 + 0.3 * heart(beatT));

    if (st.phase === 0) {
      st.vig += (0.62 - st.vig) * Math.min(1, dt * 2.2);
      if (st.t >= PP.OVER.freeze) {
        st.phase = 1;
        st.t = 0;
        PP.audio.overSuck();
        PP.fx.shake(7, 0.4);
      }
    } else if (st.phase === 1) {
      st.vig += (0.72 - st.vig) * Math.min(1, dt * 2);
      suck(dt);
    } else if (st.phase === 2) {
      if (st.t >= PP.OVER.snap) doom();
    } else {
      bigSkull.x = PP.W / 2 + Math.sin(st.t * 7.3) * 2.5 * heart(st.t);
      bigSkull.y = PP.H / 2 - 8 + Math.cos(st.t * 5.1) * 2 * heart(st.t);
      st.ash -= dt;
      if (st.ash <= 0) { st.ash = 0.12; ash(); }
      if (!st.lunged && st.t >= PP.OVER.reveal - PP.OVER.lunge) {
        st.lunged = true;
        lunge();
      }
      if (!st.done && st.t >= PP.OVER.reveal) {
        st.done = true;
        if (onFinish) onFinish();
      }
    }
  }

  // レベル開始時: 演出を跡形もなく片付ける
  function reset() {
    st = null;
    onFinish = null;
    if (!built) return;
    [desat, vignette, dark, bigSkull, flash].forEach(function (o) {
      createjs.Tween.removeTweens(o);
      o.alpha = 0;
    });
    for (var vi = 0; vi < vortexes.length; vi++) {
      createjs.Tween.removeTweens(vortexes[vi].shape);
      vortexes[vi].shape.alpha = 0;
      vortexes[vi].shape.rotation = 0;
      vortexes[vi].shape.scaleX = vortexes[vi].shape.scaleY = 0.25;
    }
    bigSkull.scaleX = bigSkull.scaleY = 0.5;
    bigSkull.x = PP.W / 2; bigSkull.y = PP.H / 2 - 8;
    forEachSkull(function (sk) {
      createjs.Tween.removeTweens(sk);
      sk.alpha = 1;
      sk.scaleX = sk.scaleY = 1;
      sk.color = "#f0e6c8";
    });
    PP.fx.resetShake();
  }

  // コース(レール)が差し替わったとき、樽ごとの渦を新しい構成へ組み直す
  function relocate() {
    if (!built) return;
    buildVortexes();
  }

  PP.gameover = {
    build: build,
    start: start,
    update: update,
    reset: reset,
    relocate: relocate,
    active: function () { return !!st; }
  };
})();
