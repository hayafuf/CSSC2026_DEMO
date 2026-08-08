/* =========================================================
 * fx.js — パーティクル・フロートテキスト・画面の揺れ
 *
 * 消去は「リング衝撃波 + 飛び散るシャード + きらめき + 瞬間フラッシュ」の
 * 重ね合わせで、当たった手応えを出す。API(particles/burst/floatText/shake/
 * updateShake/resetShake)は従来互換で、中身だけ強化してある。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // リング衝撃波(加算合成で光る輪が広がって消える)
  function ring(x, y, color, r0, r1, dur) {
    var fx = PP.layers.fx;
    var s = new createjs.Shape();
    s.x = x; s.y = y;
    s.compositeOperation = "lighter";
    s.graphics.setStrokeStyle(2.4).beginStroke(color).drawCircle(0, 0, 10);
    s.scaleX = s.scaleY = (r0 || 4) / 10;
    fx.addChild(s);
    createjs.Tween.get(s)
      .to({ scaleX: (r1 || 34) / 10, scaleY: (r1 || 34) / 10, alpha: 0 }, dur || 360, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(s); });
  }

  // 瞬間フラッシュ(着弾点の光)
  function flash(x, y, color, rad) {
    var fx = PP.layers.fx;
    var s = new createjs.Shape();
    s.x = x; s.y = y; s.compositeOperation = "lighter";
    s.graphics.beginRadialGradientFill([color, "rgba(255,255,255,0)"], [0, 1], 0, 0, 1, 0, 0, rad || 22)
      .drawCircle(0, 0, rad || 22);
    fx.addChild(s);
    createjs.Tween.get(s)
      .to({ scaleX: 1.6, scaleY: 1.6, alpha: 0 }, 260, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(s); });
  }

  // 消去の華やかな破裂(色シャード + きらめき + リング + フラッシュ)
  function particles(x, y, colorIndex, delay) {
    var fx = PP.layers.fx;
    var pal = PP.PALETTE[colorIndex] || { light: "#fff", main: "#ffd27a" };
    var color = pal.main, light = pal.light;
    delay = delay || 0;

    // リング + フラッシュは1回だけ(遅延に合わせて出す)
    var trigger = new createjs.Shape();
    fx.addChild(trigger);
    createjs.Tween.get(trigger).wait(delay).call(function () {
      fx.removeChild(trigger);
      ring(x, y, light, 4, 30, 340);
      flash(x, y, light, 20);
    });

    // 飛び散る色シャード(重力付き・回転しながら消える)
    // TODO【課題4】玉が消えるときの破片の数。7 を増やすと派手になる
    // (増やしすぎると重くなるので 30 以下がおすすめ)
    for (var i = 0; i < 7; i++) {
      (function () {
        var p = new createjs.Shape();
        var sz = 2 + Math.random() * 3.5;
        p.graphics.beginFill(Math.random() < 0.4 ? light : color).drawRect(-sz, -sz * 0.5, sz * 2, sz);
        p.x = x; p.y = y; p.rotation = Math.random() * 360; p.visible = false;
        fx.addChild(p);
        var ang = Math.random() * Math.PI * 2;
        var dist = 20 + Math.random() * 34;
        createjs.Tween.get(p).wait(delay).call(function () { p.visible = true; })
          .to({
            x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist + 16,
            rotation: p.rotation + (Math.random() - 0.5) * 300, alpha: 0
          }, 360 + Math.random() * 240, createjs.Ease.quadOut)
          .call(function () { fx.removeChild(p); });
      })();
    }
    // 白いきらめき(加算)
    // TODO【課題4】きらめきの数。破片(上)とセットで増減させるとよい
    for (var j = 0; j < 3; j++) {
      (function () {
        var s = new createjs.Shape();
        s.compositeOperation = "lighter";
        s.graphics.beginFill("rgba(255,252,240,0.95)").drawCircle(0, 0, 1.4 + Math.random() * 1.6);
        s.x = x; s.y = y; s.visible = false;
        fx.addChild(s);
        var ang = Math.random() * Math.PI * 2, dist = 10 + Math.random() * 22;
        createjs.Tween.get(s).wait(delay).call(function () { s.visible = true; })
          .to({ x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, alpha: 0 },
            300 + Math.random() * 200, createjs.Ease.quadOut)
          .call(function () { fx.removeChild(s); });
      })();
    }
  }

  // 汎用バースト(CSS色指定・粉砕/解放演出用)。glow 付きで少し重力。
  // spread(省略時1)で飛距離を倍率で広げられる(爆弾の大爆発などで使う)
  function burst(x, y, color, count, spread) {
    var fx = PP.layers.fx;
    spread = spread || 1;
    for (var i = 0; i < count; i++) {
      (function () {
        var p = new createjs.Shape();
        p.compositeOperation = "lighter";
        p.graphics.beginFill(color).drawCircle(0, 0, 1.5 + Math.random() * 3);
        p.x = x; p.y = y;
        fx.addChild(p);
        var ang = Math.random() * Math.PI * 2;
        var dist = (22 + Math.random() * 44) * spread;
        createjs.Tween.get(p)
          .to({ x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist + 18, alpha: 0 },
            380 + Math.random() * 280, createjs.Ease.quadOut)
          .call(function () { fx.removeChild(p); });
      })();
    }
  }

  // 着弾/割り込みの小さな水しぶき(任意で呼ぶ)
  function splash(x, y, color) {
    ring(x, y, color || "rgba(180,214,236,0.8)", 3, 22, 300);
    for (var i = 0; i < 5; i++) {
      (function () {
        var p = new createjs.Shape();
        p.graphics.beginFill(color || "rgba(200,224,244,0.9)").drawCircle(0, 0, 1 + Math.random() * 2);
        p.x = x; p.y = y;
        PP.layers.fx.addChild(p);
        var ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, dist = 10 + Math.random() * 18;
        createjs.Tween.get(p)
          .to({ x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist + 10, alpha: 0 }, 300, createjs.Ease.quadOut)
          .call(function () { PP.layers.fx.removeChild(p); });
      })();
    }
  }

  // ミサイルの噴射トレイル(加算合成の縦ストリーク)。毎フレーム呼んで
  // 残像を重ねる。y から下方向に len だけ伸び、すぐフェードして消える。
  // w は破壊回廊の全幅(省略時 6px)。芯の強い光+回廊いっぱいの淡い光の
  // 2層にして、「この幅が薙ぎ払われる」ことが見た目で分かるようにする。
  function missileTrail(x, y, len, w) {
    var fx = PP.layers.fx;
    var s = new createjs.Shape();
    s.compositeOperation = "lighter";
    if (w && w > 12) {
      s.graphics.beginLinearGradientFill(
        ["rgba(255,200,120,0.28)", "rgba(255,140,50,0.12)", "rgba(255,120,20,0)"],
        [0, 0.4, 1], 0, 0, 0, len)
        .drawRect(-w / 2, 0, w, len);
    }
    s.graphics.beginLinearGradientFill(
      ["rgba(255,244,192,0.85)", "rgba(255,138,42,0.4)", "rgba(255,120,20,0)"],
      [0, 0.4, 1], 0, 0, 0, len)
      .drawRect(-3, 0, 6, len);
    s.x = x; s.y = y;
    fx.addChild(s);
    createjs.Tween.get(s)
      .to({ alpha: 0, scaleX: 0.4 }, 200, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(s); });
  }

  // 全画面フラッシュ(特殊攻撃の「発動した!」を画面全体で伝える)。
  // color は CSS 色、alpha は最大の明るさ、dur はフェード時間(ms)
  function screenFlash(color, alpha, dur) {
    var fx = PP.layers.fx;
    var s = new createjs.Shape();
    s.compositeOperation = "lighter";
    s.graphics.beginFill(color).drawRect(0, 0, PP.W, PP.H);
    s.alpha = alpha || 0.3;
    fx.addChild(s);
    createjs.Tween.get(s)
      .to({ alpha: 0 }, dur || 260, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(s); });
  }

  // 浮かび上がる数字/文言。輪郭付き + 出現ポップ
  function floatText(str, x, y, color, size) {
    var fx = PP.layers.fx;
    var t = new createjs.Text(str, "700 " + (size || 18) + 'px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', color);
    t.textAlign = "center"; t.textBaseline = "middle";
    t.x = x; t.y = y;
    t.shadow = new createjs.Shadow("rgba(0,0,0,0.85)", 0, 2, 4);
    t.scaleX = t.scaleY = 0.4;
    fx.addChild(t);
    createjs.Tween.get(t)
      .to({ scaleX: 1.12, scaleY: 1.12 }, 130, createjs.Ease.backOut)
      .to({ scaleX: 1, scaleY: 1 }, 90);
    createjs.Tween.get(t)
      .to({ y: y - 42, alpha: 0 }, 960, createjs.Ease.quadOut)
      .call(function () { fx.removeChild(t); });
  }

  // ---------- 画面の揺れ ----------
  var SHAKE_LAYERS = ["path", "railFlow", "bridgeUnder", "ballUnder", "bridge", "ballOver",
    "barrel", "shot", "item", "fx", "cannon"];
  var shakePow = 0, shakeT = 0, shakeDur = 0;

  // TODO【課題4】画面の揺れ。power=揺れ幅(px)、dur=揺れる時間(秒)。
  // 呼び出し側(例: chain.js の爆発 shake(80, 2))の数値を変えると迫力が変わる
  function shake(power, dur) {
    if (power >= shakePow || shakeT <= 0) {
      shakePow = power; shakeDur = dur || 0.35; shakeT = shakeDur;
    }
  }
  function updateShake(dt) {
    if (shakeT <= 0) return;
    shakeT -= dt;
    var k = Math.max(0, shakeT / shakeDur);
    var amp = shakePow * k * k;
    var ox = (Math.random() * 2 - 1) * amp;
    var oy = (Math.random() * 2 - 1) * amp;
    if (shakeT <= 0) { ox = 0; oy = 0; shakePow = 0; }
    SHAKE_LAYERS.forEach(function (name) {
      var L = PP.layers[name];
      if (L) { L.x = ox; L.y = oy; }
    });
  }
  function resetShake() {
    shakePow = 0; shakeT = 0;
    SHAKE_LAYERS.forEach(function (name) {
      var L = PP.layers[name];
      if (L) { L.x = 0; L.y = 0; }
    });
  }

  PP.fx = {
    particles: particles, burst: burst, floatText: floatText,
    ring: ring, flash: flash, splash: splash, missileTrail: missileTrail,
    screenFlash: screenFlash,
    shake: shake, updateShake: updateShake, resetShake: resetShake
  };
})();
