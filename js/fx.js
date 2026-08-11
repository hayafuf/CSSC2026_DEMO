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

  // ---------- パーティクルプール ----------
  // burst/splash/missileTrail は毎フレーム大量に呼ばれる(特にボス戦の弾トレイル)。
  // 都度 Shape+Graphics+Tween を作ると GC と removeChild(indexOf走査)が支配的に
  // なるため、色ごとに一度だけ焼いた円 canvas を Bitmap で使い回し、自前積分で
  // 動かす。定常状態では割り当てゼロ。
  var MAX_P = 300;             // 同時生存の上限。飽和時は超過スポーンを捨てる
  var DOT_R = 4.5;             // 焼き込み円の半径(呼び出し側の最大値)
  var dotCanvas = {};          // CSS色文字列 → 焼き込み済み canvas
  var dotCanvasN = 0;          // 色マップの肥大ガード用
  var pActive = [], pFree = [];
  var pcont = null;            // プール専用 Container(fx レイヤーに一度だけ載せる)

  function bakeDot(color) {
    var s = new createjs.Shape();
    s.graphics.beginFill(color).drawCircle(0, 0, DOT_R);
    s.cache(-DOT_R - 1, -DOT_R - 1, DOT_R * 2 + 2, DOT_R * 2 + 2);
    // 焼き込み canvas に「描画原点が canvas 内のどこか」を持たせ、
    // spawnDot が regX/regY に写す(円は中心、トレイルは上端中央など)
    s.cacheCanvas._rx = DOT_R + 1;
    s.cacheCanvas._ry = DOT_R + 1;
    return s.cacheCanvas;
  }

  function ensureCont() {
    if (!pcont) {
      pcont = new createjs.Container();
      pcont.mouseEnabled = pcont.mouseChildren = false;
      PP.layers.fx.addChild(pcont);
    }
    return pcont;
  }

  // 汎用スポーン: (x0,y0)→(tx,ty) へ quadOut で移動、scale も s0→s1 へ補間、
  // alpha は 1→0。img は焼き込み canvas、comp は合成モード(null で通常)。
  function spawnDot(img, comp, x0, y0, tx, ty, s0x, s0y, s1x, s1y, durMs) {
    if (pActive.length >= MAX_P) return;
    var b = pFree.pop();
    if (!b) {
      b = new createjs.Bitmap(null);
      ensureCont().addChild(b);
    }
    b.image = img;
    b.regX = img._rx; b.regY = img._ry;
    b.compositeOperation = comp;
    b.visible = true; b.alpha = 1;
    b.x = x0; b.y = y0; b.scaleX = s0x; b.scaleY = s0y;
    pActive.push({ bmp: b, age: 0, dur: durMs / 1000,
                   x0: x0, y0: y0, tx: tx, ty: ty,
                   s0x: s0x, s0y: s0y, s1x: s1x, s1y: s1y });
  }

  function updateParticles(dt) {
    for (var i = pActive.length - 1; i >= 0; i--) {
      var p = pActive[i];
      p.age += dt;
      var k = p.age / p.dur;
      if (k >= 1) {
        p.bmp.visible = false;
        pFree.push(p.bmp);
        pActive[i] = pActive[pActive.length - 1];
        pActive.pop();
        continue;
      }
      var e = 1 - (1 - k) * (1 - k);   // quadOut(従来 Tween と同じイージング)
      var b = p.bmp;
      b.x = p.x0 + (p.tx - p.x0) * e;
      b.y = p.y0 + (p.ty - p.y0) * e;
      b.scaleX = p.s0x + (p.s1x - p.s0x) * e;
      b.scaleY = p.s0y + (p.s1y - p.s0y) * e;
      b.alpha = 1 - e;
    }
  }

  function particleLoad() { return pActive.length / MAX_P; }

  function dotFor(color) {
    var img = dotCanvas[color];
    if (img === undefined) {
      // 色は有限のリテラル集合のはずだが、万一動的生成色が流れ込んでも
      // マップが無限に育たないようガードする(超過分は白で代用)
      if (dotCanvasN >= 64) return dotCanvas["#ffffff"] || (dotCanvas["#ffffff"] = bakeDot("#ffffff"));
      img = dotCanvas[color] = bakeDot(color);
      dotCanvasN++;
    }
    return img;
  }

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
    spread = spread || 1;
    var img = dotFor(color);
    for (var i = 0; i < count; i++) {
      var r = 1.5 + Math.random() * 3;
      var sc = r / DOT_R;
      var ang = Math.random() * Math.PI * 2;
      var dist = (22 + Math.random() * 44) * spread;
      spawnDot(img, "lighter", x, y,
        x + Math.cos(ang) * dist, y + Math.sin(ang) * dist + 18,
        sc, sc, sc, sc, 380 + Math.random() * 280);
    }
  }

  // 着弾/割り込みの小さな水しぶき(任意で呼ぶ)
  function splash(x, y, color) {
    ring(x, y, color || "rgba(180,214,236,0.8)", 3, 22, 300);
    var img = dotFor(color || "rgba(200,224,244,0.9)");
    for (var i = 0; i < 5; i++) {
      var r = 1 + Math.random() * 2;
      var sc = r / DOT_R;
      var ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, dist = 10 + Math.random() * 18;
      spawnDot(img, null, x, y,
        x + Math.cos(ang) * dist, y + Math.sin(ang) * dist + 10,
        sc, sc, sc, sc, 300);
    }
  }

  // ミサイルの噴射トレイル(加算合成の縦ストリーク)。毎フレーム呼んで
  // 残像を重ねる。y から下方向に len だけ伸び、すぐフェードして消える。
  // w は破壊回廊の全幅(省略時 6px)。芯の強い光+回廊いっぱいの淡い光の
  // 2層にして、「この幅が薙ぎ払われる」ことが見た目で分かるようにする。
  // 縦グラデ矩形は基準長 TRAIL_LEN0 で一度だけ焼き、scaleY=len/TRAIL_LEN0 で
  // 伸縮する(線形グラデは線形スケールで見た目が一致する)
  var TRAIL_LEN0 = 140, TRAIL_W0 = 40;
  var trailCore = null, trailWide = null;

  function bakeTrail(stops, w) {
    var s = new createjs.Shape();
    s.graphics.beginLinearGradientFill(stops, [0, 0.4, 1], 0, 0, 0, TRAIL_LEN0)
      .drawRect(-w / 2, 0, w, TRAIL_LEN0);
    s.cache(-w / 2 - 1, 0, w + 2, TRAIL_LEN0);
    s.cacheCanvas._rx = w / 2 + 1;
    s.cacheCanvas._ry = 0;
    return s.cacheCanvas;
  }

  function missileTrail(x, y, len, w) {
    if (!trailCore) {
      trailCore = bakeTrail(
        ["rgba(255,244,192,0.85)", "rgba(255,138,42,0.4)", "rgba(255,120,20,0)"], 6);
      trailWide = bakeTrail(
        ["rgba(255,200,120,0.28)", "rgba(255,140,50,0.12)", "rgba(255,120,20,0)"], TRAIL_W0);
    }
    var sy = len / TRAIL_LEN0;
    if (w && w > 12) {
      var sx = w / TRAIL_W0;
      spawnDot(trailWide, "lighter", x, y, x, y, sx, sy, sx * 0.4, sy, 200);
    }
    spawnDot(trailCore, "lighter", x, y, x, y, 1, sy, 0.4, sy, 200);
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
  var shakeRefs = null;   // レイヤー参照は初回に解決して使い回す(毎フレームの名前引き回避)
  var shakePow = 0, shakeT = 0, shakeDur = 0;

  function resolveShakeRefs() {
    shakeRefs = [];
    for (var i = 0; i < SHAKE_LAYERS.length; i++) {
      var L = PP.layers[SHAKE_LAYERS[i]];
      if (L) shakeRefs.push(L);
    }
    return shakeRefs;
  }

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
    var refs = shakeRefs || resolveShakeRefs();
    for (var i = 0; i < refs.length; i++) { refs[i].x = ox; refs[i].y = oy; }
  }
  function resetShake() {
    shakePow = 0; shakeT = 0;
    var refs = shakeRefs || resolveShakeRefs();
    for (var i = 0; i < refs.length; i++) { refs[i].x = 0; refs[i].y = 0; }
  }

  PP.fx = {
    particles: particles, burst: burst, floatText: floatText,
    ring: ring, flash: flash, splash: splash, missileTrail: missileTrail,
    screenFlash: screenFlash,
    updateParticles: updateParticles, particleLoad: particleLoad,
    shake: shake, updateShake: updateShake, resetShake: resetShake
  };
})();
