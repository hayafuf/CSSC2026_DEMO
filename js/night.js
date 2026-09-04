/* =========================================================
 * night.js — 夜(難易度「深海の悪魔+風+夜」の「夜」の側)
 *
 * 盤面が深い藍の闇に沈み、玉の色が読めなくなる。読めるのは「光だまり」の中だけ:
 *   ・レールに PP.NIGHT.spacing おきに掛けた灯り(真鍮のランタン)。燃料(fuel 0〜1)を
 *     持ち、時間で減って光だまりが縮み、空になると消える。玉を消すと燃料が戻る
 *     (消した場所の近くは大きく、全体には少し = onPop)
 *   ・自分が撃った玉、大砲の砲口、🔭 羅針の眼の照準は常に光る
 * 「消し続けないと視界を失う」= 守りに入った瞬間に盤面が見えなくなる、が設計の芯。
 * 風(gale.js)と組み合わさって最後の腕試しになる。
 *
 * ---- 絵の作り(3 枚重ね) ----
 *  1) 闇: 1 枚のオフスクリーン canvas。全面を深い藍で塗り、光源ごとに柔らかい
 *     グラデ(holeImg)を destination-out で drawImage して穴を開ける。ランタンの穴は
 *     レールの進行方向に伸ばした楕円にして「溝が照らされている」形にする。
 *     出来た canvas を Bitmap として盤面の上(玉より上・弾より下)に置く。
 *  2) 光だまり: 穴の上に加算合成(lighter)で暖色のグローを重ねる。穴だけだと
 *     「そこだけ昼」に見えるが、琥珀色の光を足すと灯りに照らされた玉に見える。
 *     大砲の光は月明かり寄りの青白、自弾は暖色。
 *  3) 灯体: 小さな真鍮のランタン(炎入り)をレールの法線方向へずらして溝の外に掛ける
 *     (玉の段にものを被せないのが UI 規約)。燃料が尽きても薄く残る。
 *
 * ---- なぜ「闇の canvas に穴を開ける」のか ----
 * StageGL(WebGL 描画。gl-patch.js)が持つ合成モードは「通常」と「lighter(加算)」の
 * 2 つだけで、表示オブジェクトに destination-out を付けても通常合成として描かれる。
 * つまり「暗幕の一部を抜く」は表示ツリー側では表現できない。石橋の舷窓
 * (course-view.js)が cache canvas に同じ手で穴を開けている前例に倣い、自前 canvas に
 * 描く。GL では canvas をテクスチャとして送り直す必要があり、BitmapCache.updateCache が
 * cacheCanvas._invalid = true を立てて StageGL の _updateTextureImageData に拾わせる
 * 仕組みを、自前 canvas でも同じフラグで使う(redraw の末尾)。全画面ぶんの転送に
 * なるので、解像度(PP.PERF.NIGHT_SCALE)を落として頻度(NIGHT_HZ)も間引く。
 * ぼんやりした光だまりは半分の解像度で描いて伸ばしても見分けがつかない。
 *
 * 光の絵はすべて焼き置き canvas を Bitmap で共有し、毎フレームは alpha / scale /
 * 座標を書くだけ。加算合成は専用 Container に 1 回だけ付ける(GL の flush 境界を
 * 増やさない)。数値はすべて config.js の PP.NIGHT。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var N = PP.NIGHT;
  var HOLE_UR = 64;   // 穴のグラデを焼く単位半径(実際の半径は drawImage の拡縮で付ける)

  // ---- 状態 ----
  var lanterns = [];          // { d, x, y, ang, fuel, phase, glow, body }
  var pool = [];              // 使い回す Bitmap の組 { glow, body }
  var built = false;
  var darkCanvas = null, darkCtx = null, darkBmp = null, darkScale = 1, darkFill = null;
  var glowCont = null, holeImg = null, warmImg = null, coolImg = null, lampImg = null;
  var muzzleGlow = null, shotGlows = [];
  var ghostCont = null, ghostImg = null, ghosts = [], ghostsUsed = 0;   // 玉の位置を示すゴースト
  var mouths = [];                  // 樽の口の常夜灯 { x, y, glow }(レーンごと。燃料なし)
  var mouthPool = [];
  var hits = [];                    // 着弾点に残る光 { x, y, t, glow }(固定長プール、古い順に使い回す)
  var HIT_MAX = 6;
  var redrawAcc = 0, redraws = 0, clock = 0, fade = 1;
  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };

  // この難易度に夜があるか(config.js の DIFFICULTY[...].night)。
  // 他モジュールの分岐はすべてここに閉じる(gale.active と同じ流儀)
  function active() { return !!PP.diff().night; }

  // ---- 焼き置き ----
  // 穴のグラデ。中心は完全に抜け、縁へ向けて S 字で柔らかく残る(段が見えない)。
  // destination-out は「元の alpha × (1 − 描く alpha)」なので色は関係ない
  function bakeHole() {
    var c = document.createElement("canvas");
    c.width = c.height = HOLE_UR * 2;
    var ctx = c.getContext("2d");
    var g = ctx.createRadialGradient(HOLE_UR, HOLE_UR, 0, HOLE_UR, HOLE_UR, HOLE_UR);
    g.addColorStop(0.00, "rgba(255,255,255,1)");
    g.addColorStop(0.30, "rgba(255,255,255,0.97)");
    g.addColorStop(0.50, "rgba(255,255,255,0.78)");
    g.addColorStop(0.70, "rgba(255,255,255,0.40)");
    g.addColorStop(0.88, "rgba(255,255,255,0.10)");
    g.addColorStop(1.00, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // 光だまり(加算)。stops で色味を変えて焼く(暖色=ランタン・自弾、青白=大砲)
  function bakeGlow(stops) {
    var r = PP.R * 2;
    var s = new createjs.Shape();
    s.graphics.beginRadialGradientFill(stops, [0, 0.35, 0.7, 1], 0, 0, 0, 0, 0, r).drawCircle(0, 0, r);
    s.cache(-r, -r, r * 2, r * 2);
    var img = s.cacheCanvas;
    img._r = r;
    return img;
  }
  // 灯体: 小さな真鍮のランタン。上の吊り輪、琥珀の硝子、中の炎、下の台座。
  // 硝子と炎は灯体自体の alpha(燃料)で暗くなるので、消えると真鍮の輪郭だけ薄く残る
  function bakeLamp() {
    var s = new createjs.Shape();
    var g = s.graphics;
    var w = 9, h = 12;
    g.setStrokeStyle(1.2).beginStroke("#c8a24a").drawCircle(0, -h / 2 - 2.5, 2);     // 吊り輪
    g.beginFill("#8a6a24").drawRoundRect(-w / 2 - 1, -h / 2 - 1, w + 2, 2.5, 1);        // 笠
    g.beginRadialGradientFill(["#fff3c4", "#ffb648", "rgba(200,110,20,0.55)"], [0, 0.45, 1],
      0, 1, 0, 0, 1, w * 0.8).drawRoundRect(-w / 2, -h / 2 + 1, w, h - 2, 2);          // 硝子と炎
    g.setStrokeStyle(1).beginStroke("rgba(240,192,64,0.9)").drawRoundRect(-w / 2, -h / 2 + 1, w, h - 2, 2); // 真鍮の枠
    g.beginFill("#8a6a24").drawRoundRect(-w / 2 - 1, h / 2 - 1.5, w + 2, 2.5, 1);       // 台座
    s.cache(-w, -h, w * 2, h * 2);
    var img = s.cacheCanvas;
    img._rx = w; img._ry = h;
    return img;
  }

  // 玉の位置を示すゴースト: 彩度のない灰色の柔らかい円。闇(不透明)の上に加算で
  // 薄く乗せるので「そこに玉がある」ことだけ分かり、色は一切分からない。
  // 光だまりの中では玉が本来の色で見えていて、その上にわずかに乗るだけ
  function bakeGhost() {
    var r = PP.R;
    var s = new createjs.Shape();
    s.graphics.beginRadialGradientFill(
      ["rgba(170,182,210,0.75)", "rgba(140,152,185,0.45)", "rgba(120,132,165,0)"], [0, 0.62, 1],
      0, 0, 0, 0, 0, r).drawCircle(0, 0, r);
    s.cache(-r, -r, r * 2, r * 2);
    var img = s.cacheCanvas;
    img._r = r;
    return img;
  }
  function takeGhost(i) {
    var b = ghosts[i];
    if (!b) {
      b = new createjs.Bitmap(ghostImg);
      b.regX = b.regY = ghostImg._r;
      b.alpha = 0;
      ghostCont.addChild(b);
      ghosts.push(b);
    }
    return b;
  }

  // 初回だけ: 闇の canvas と Bitmap、光の Container を層に置く
  function ensure() {
    if (built) return;
    built = true;
    var L = PP.layers.night;
    darkScale = PP.PERF.NIGHT_SCALE;
    darkCanvas = document.createElement("canvas");
    darkCanvas.width = Math.ceil(PP.W * darkScale);
    darkCanvas.height = Math.ceil(PP.H * darkScale);
    darkCtx = darkCanvas.getContext("2d");
    // 闇の色: 上は深い藍、下(甲板側)はわずかに紫がかる。単色より奥行きが出る
    darkFill = darkCtx.createLinearGradient(0, 0, 0, darkCanvas.height);
    darkFill.addColorStop(0, "rgb(3,5,18)");
    darkFill.addColorStop(1, "rgb(8,6,22)");
    darkBmp = new createjs.Bitmap(darkCanvas);
    darkBmp.scaleX = darkBmp.scaleY = 1 / darkScale;
    // ゴーストと光は両方 lighter。隣り合わせに置けば GL の flush 境界は 1 つで済む
    ghostCont = new createjs.Container();
    ghostCont.mouseEnabled = ghostCont.mouseChildren = false;
    ghostCont.compositeOperation = "lighter";
    glowCont = new createjs.Container();
    glowCont.mouseEnabled = glowCont.mouseChildren = false;
    glowCont.compositeOperation = "lighter";
    L.addChild(darkBmp, ghostCont, glowCont);
    ghostImg = bakeGhost();
    holeImg = bakeHole();
    warmImg = bakeGlow(["rgba(255,226,160,0.50)", "rgba(255,180,80,0.28)", "rgba(255,130,40,0.10)", "rgba(255,120,30,0)"]);
    coolImg = bakeGlow(["rgba(220,236,255,0.40)", "rgba(170,205,255,0.20)", "rgba(120,160,240,0.07)", "rgba(100,140,230,0)"]);
    lampImg = bakeLamp();
    for (var hi = 0; hi < HIT_MAX; hi++) {
      var hg = new createjs.Bitmap(warmImg);
      hg.regX = hg.regY = warmImg._r;
      hg.scaleX = hg.scaleY = N.hitR / warmImg._r;
      hg.alpha = 0;
      glowCont.addChild(hg);
      hits.push({ x: 0, y: 0, t: 1e9, glow: hg });
    }
    muzzleGlow = new createjs.Bitmap(coolImg);
    muzzleGlow.regX = muzzleGlow.regY = coolImg._r;
    muzzleGlow.scaleX = muzzleGlow.scaleY = N.cannonR / coolImg._r;
    muzzleGlow.alpha = 0.55;
    glowCont.addChild(muzzleGlow);
  }
  function shotGlow(i) {
    var b = shotGlows[i];
    if (!b) {
      b = new createjs.Bitmap(warmImg);
      b.regX = b.regY = warmImg._r;
      b.scaleX = b.scaleY = N.shotR / warmImg._r;
      b.alpha = 0;
      glowCont.addChild(b);
      shotGlows.push(b);
    }
    return b;
  }

  // 燃料が満タン→空になる秒数(レベルが上がるほど短い)
  function decaySec() {
    return Math.max(N.decayMin, N.decaySec - (PP.game.level - 1) * N.decayLevelStep);
  }

  // レベル開始・リトライで仕切り直す(main.js の startLevel が呼ぶ)。
  // レールを spacing おきに歩いて灯りを掛け直し、燃料は startFuel、闇は fadeIn 秒かけて降りる
  function reset() {
    ensure();
    var L = PP.layers.night;
    L.visible = active();
    for (var i = 0; i < lanterns.length; i++) {
      pool.push({ glow: lanterns[i].glow, body: lanterns[i].body });
      glowCont.removeChild(lanterns[i].glow);
      glowCont.removeChild(lanterns[i].body);
    }
    lanterns = [];
    redrawAcc = 0;
    fade = 0;
    for (var gi = 0; gi < ghostsUsed; gi++) ghosts[gi].alpha = 0;   // 前のコースの位置に残さない
    ghostsUsed = 0;
    for (var hi = 0; hi < hits.length; hi++) { hits[hi].t = 1e9; hits[hi].glow.alpha = 0; }
    for (var mi = 0; mi < mouths.length; mi++) { mouthPool.push(mouths[mi].glow); glowCont.removeChild(mouths[mi].glow); }
    mouths = [];
    if (!L.visible) return;

    var R = PP.R, W = PP.W, H = PP.H;
    var lanes = PP.game.lanes || [];
    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li], rail = lane.rail;
      // 樽の口の常夜灯(月明かり寄りの青白。呑まれかけの玉を数えられる最低限の公平さ)
      rail.posAtInto(rail.holeD, _pos);
      var mg = mouthPool.pop() || new createjs.Bitmap(coolImg);
      mg.regX = mg.regY = coolImg._r;
      mg.scaleX = mg.scaleY = N.barrelR / coolImg._r;
      mg.x = _pos.x; mg.y = _pos.y; mg.alpha = 0.5;
      glowCont.addChild(mg);
      mouths.push({ x: _pos.x, y: _pos.y, glow: mg });
      // 最初の灯りは半間隔先(洞窟の口ではなく列が見え始める所)、樽の直前は置かない
      for (var d = N.spacing * 0.5; d < rail.holeD - R * 2; d += N.spacing) {
        if (rail.tunnelAt(d)) continue;          // トンネルの中は玉も見えないので無意味
        rail.posAtInto(d, _pos);
        if (_pos.x < -R || _pos.x > W + R || _pos.y < 0 || _pos.y > H) continue;   // 画面外
        var pair = pool.pop() || { glow: new createjs.Bitmap(warmImg), body: new createjs.Bitmap(lampImg) };
        var ang = Math.atan2(_pos.ty, _pos.tx);
        pair.glow.regX = pair.glow.regY = warmImg._r;
        pair.glow.x = _pos.x; pair.glow.y = _pos.y;
        pair.glow.rotation = ang * 180 / Math.PI;   // 光だまりも溝に沿って伸ばす
        pair.body.regX = lampImg._rx; pair.body.regY = lampImg._ry;
        // 灯体は法線方向へ玉 1.5 個ぶんずらして溝の外へ(course-view.js の normalAlong と同じ式)
        pair.body.x = _pos.x + _pos.ty * R * 1.5;
        pair.body.y = _pos.y - _pos.tx * R * 1.5;
        glowCont.addChild(pair.glow, pair.body);
        lanterns.push({
          lane: lane, d: d, x: _pos.x, y: _pos.y, ang: ang, fuel: N.startFuel,
          phase: Math.random() * Math.PI * 2, glow: pair.glow, body: pair.body
        });
      }
    }
    update(0, false);
    redraw();
  }

  // 毎フレーム(main.js の tick)。playing 中だけ燃料が減る(イントロ・3択・
  // リトライ暗転・ポーズ・チュートリアル中は見えたまま凍る)。描き直しは Hz で間引く
  function update(dt, playing) {
    if (!built || !PP.layers.night.visible) return;
    clock += dt;
    if (fade < 1) { fade = Math.min(1, fade + dt / N.fadeIn); darkBmp.alpha = fade; }
    var decay = playing ? dt / decaySec() : 0;
    var fl = N.flicker;
    var sx = N.lanternStretch, sy = 1 / Math.sqrt(N.lanternStretch);
    for (var i = 0; i < lanterns.length; i++) {
      var l = lanterns[i];
      if (decay > 0 && l.fuel > 0) l.fuel = Math.max(0, l.fuel - decay);
      // 炎のゆらぎ: 速いうねりと遅いうねりを重ねる(単一の sin だと機械的)
      var wob = 1 - fl + fl * (0.6 * Math.sin(clock * 9 + l.phase) + 0.4 * Math.sin(clock * 2.3 + l.phase * 1.7));
      var a = l.fuel * N.glowAlpha * wob;
      l.glow.alpha = a > 0.01 ? a : 0;   // 減衰 alpha は 0 にクランプ(gl-patch ★5 の描画スキップ規約)
      // 光の絵の大きさは glowR 基準(穴の lanternR とは別。重なりの白飛びを防ぐ)
      var k = N.glowR / warmImg._r * (0.35 + 0.65 * l.fuel);
      l.glow.scaleX = k * sx; l.glow.scaleY = k * sy;
      l.body.alpha = 0.25 + 0.75 * l.fuel * wob;
    }
    // 着弾点の光: hitSec 秒で直線に消える
    for (var hi = 0; hi < hits.length; hi++) {
      var h = hits[hi];
      if (h.t >= N.hitSec) { if (h.glow.alpha !== 0) h.glow.alpha = 0; continue; }
      h.t += dt;
      var ha = 0.7 * (1 - h.t / N.hitSec);
      h.glow.x = h.x; h.glow.y = h.y;
      h.glow.alpha = ha > 0.01 ? ha : 0;
    }
    muzzleGlow.x = PP.cannon.x;
    muzzleGlow.y = PP.cannon.muzzleY();
    var shots = PP.game.shots, si;
    for (si = 0; si < shots.length; si++) {
      var sg = shotGlow(si);
      sg.x = shots[si].x; sg.y = shots[si].y;
      sg.alpha = 0.6;
    }
    for (; si < shotGlows.length; si++) if (shotGlows[si].alpha !== 0) shotGlows[si].alpha = 0;
    redrawAcc += dt;
    var hz = PP.quality === 0 ? PP.PERF.LOW.nightHz : PP.PERF.NIGHT_HZ;
    if (redrawAcc >= 1 / hz) {
      redrawAcc = 0;
      redraw();
    }
  }

  // 闇を描き直す: 全面を藍で塗り、光源ごとに destination-out で穴を開ける
  function hole(x, y, r) {
    var s = darkScale;
    darkCtx.drawImage(holeImg, (x - r) * s, (y - r) * s, r * 2 * s, r * 2 * s);
  }
  // 溝に沿って伸びた穴(ランタン用)。進行方向に stretch 倍、法線方向は縮める
  function holeAlong(x, y, ang, r) {
    var s = darkScale, ctx = darkCtx;
    var rx = r * N.lanternStretch, ry = r / Math.sqrt(N.lanternStretch);
    ctx.save();
    ctx.translate(x * s, y * s);
    ctx.rotate(ang);
    ctx.drawImage(holeImg, -rx * s, -ry * s, rx * 2 * s, ry * 2 * s);
    ctx.restore();
  }
  function treasureHole(b) {
    if (b.treasure && b.view.visible) hole(b.view.x, b.view.y, N.treasureR);
  }
  function bulletHole(x, y) { hole(x, y, N.bulletR); }

  // 自弾がチェーンに当たった(cannon.js の stepShots)。着弾点に hitSec 秒だけ光を残す
  // = 当たった周りの玉が読める。撃つこと自体が偵察になる
  function onHit(x, y) {
    if (!built) return;
    var oldest = hits[0];
    for (var i = 1; i < hits.length; i++) if (hits[i].t > oldest.t) oldest = hits[i];
    oldest.x = x; oldest.y = y; oldest.t = 0;
  }
  function redraw() {
    var ctx = darkCtx, w = darkCanvas.width, h = darkCanvas.height;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);    // 前回の穴が残ったまま重ね塗りすると濃度が積み上がる
    ctx.globalAlpha = N.darkAlpha * (PP.game.bossMode ? N.bossDarkMul : 1);
    ctx.fillStyle = darkFill;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    // 1) ランタン: 燃料で穴が縮む(lanternPow=1 で燃料に比例)。炎のゆらぎで半径もわずかに揺れる
    for (var i = 0; i < lanterns.length; i++) {
      var l = lanterns[i];
      if (l.fuel <= 0) continue;
      var r = N.lanternR * (N.lanternPow === 1 ? l.fuel : Math.pow(l.fuel, N.lanternPow));
      r *= 1 + 0.04 * Math.sin(clock * 9 + l.phase);
      holeAlong(l.x, l.y, l.ang, r);
    }
    // 2) 大砲の砲口(プレイヤーの位置。手前の段が読める)
    hole(PP.cannon.x, PP.cannon.muzzleY(), N.cannonR);
    // 3) 飛んでいる自弾
    var shots = PP.game.shots;
    for (var si = 0; si < shots.length; si++) hole(shots[si].x, shots[si].y, N.shotR);
    // 4) 🔭 羅針の眼: 照準線に沿った点列(風で曲がる予測もそのまま光る)と着弾点
    if (PP.game.effects.spyglass > 0) {
      var ap = PP.cannon.aimLightPoints();
      for (var pi = 0; pi < ap.n; pi++) hole(ap.xs[pi], ap.ys[pi], pi === ap.n - 1 ? N.spyHitR : N.spyR);
    }
    // 5) 💎 宝玉は自ら光る(列の中の宝玉の周りだけ小さく開く)
    PP.game.eachLaneBall(treasureHole);
    // 6) 樽の口の常夜灯
    for (var mi = 0; mi < mouths.length; mi++) hole(mouths[mi].x, mouths[mi].y, N.barrelR);
    // 7) 着弾点に残る光(hitSec 秒で縮んで消える)
    for (var hi = 0; hi < hits.length; hi++) {
      var h = hits[hi];
      if (h.t < N.hitSec) hole(h.x, h.y, N.hitR * (1 - h.t / N.hitSec));
    }
    // 8) 妖弾は自ら光る(骸骨玉の弾幕・ボスの弾幕)
    if (PP.skull) PP.skull.eachBullet(bulletHole);
    if (PP.game.bossMode && PP.boss && PP.boss.eachBullet) PP.boss.eachBullet(bulletHole);
    ctx.globalCompositeOperation = "source-over";
    darkCanvas._invalid = true;   // StageGL にテクスチャの送り直しを頼む(cache と同じ印)
    redraws++;
  }

  // 玉ごとのゴーストを置く(main.js の tick が renderChains の直後に呼ぶ: 玉の座標が
  // 確定してから)。毎フレーム座標を書くだけ(生成はプールが温まった後はゼロ)。
  // トンネルの中の玉は覆いより上の層に乗るゴーストが覆いを突き抜けるので出さない
  function render() {
    if (!built || !PP.layers.night.visible) return;
    var g = PP.game, lanes = g.lanes;
    var a0 = N.ghostAlpha, used = 0;
    if (a0 > 0) {
      for (var li = 0; li < lanes.length; li++) {
        var lane = lanes[li], balls = lane.balls, rail = lane.rail;
        for (var bi = 0; bi < balls.length; bi++) {
          var b = balls[bi], v = b.view;
          if (!v.visible || b.treasure) continue;
          if (rail.tunnelAt(b.d + (b.slide || 0))) continue;
          var gh = takeGhost(used++);
          gh.x = v.x; gh.y = v.y;
          gh.scaleX = gh.scaleY = v.scaleX;
          gh.alpha = a0 * v.alpha;
        }
      }
    }
    for (var i = used; i < ghostsUsed; i++) ghosts[i].alpha = 0;   // 余った分だけ寝かせる
    ghostsUsed = used;
  }

  // 玉が消えた(chain.js の destroyRange: マッチ・爆弾・ミサイル・機銃の唯一の通り道)。
  // lane のレール距離 d を中心に n 個消えた。近くの灯りは大きく、全灯りは少し戻る。
  // コンボ中は戻りが増える(連鎖は闇を大きく押し返す=攻めの報酬)
  function onPop(lane, d, n) {
    if (!active() || !lanterns.length) return;
    var combo = PP.game.combo || 1;
    var mul = 1 + N.comboMul * Math.max(0, combo - 1);
    var local = n * N.gainPerBall * mul;
    var global = n * N.gainGlobal * mul;
    for (var i = 0; i < lanterns.length; i++) {
      var l = lanterns[i];
      var add = global;
      if (l.lane === lane) {
        var k = 1 - Math.abs(l.d - d) / N.gainSpread;
        if (k > 0) add += local * k;
      }
      if (add > 0) l.fuel = Math.min(1, l.fuel + add);
    }
  }

  // タイトルへ戻るとき(main.js の showTitle)。次の startLevel の reset が出し直す
  function hide() {
    if (PP.layers && PP.layers.night) PP.layers.night.visible = false;
  }

  // 検証用: 全灯りの燃料を固定する(PP.gale.force と同じ流儀)
  function force(fuel) {
    for (var i = 0; i < lanterns.length; i++) lanterns[i].fuel = Math.max(0, Math.min(1, fuel));
  }
  // 検証用の観測口
  function info() {
    var sum = 0, min = 1;
    for (var i = 0; i < lanterns.length; i++) {
      sum += lanterns[i].fuel;
      if (lanterns[i].fuel < min) min = lanterns[i].fuel;
    }
    return {
      count: lanterns.length,
      avgFuel: lanterns.length ? sum / lanterns.length : 0,
      minFuel: lanterns.length ? min : 0,
      redraws: redraws,
      decaySec: decaySec(),
      fade: fade,
      ghosts: ghostsUsed,
      fuels: lanterns.map(function (l) { return l.fuel; }),
      ds: lanterns.map(function (l) { return l.d; }),
      laneIdx: lanterns.map(function (l) { return PP.game.lanes.indexOf(l.lane); }),
      canvas: darkCanvas, scale: darkScale
    };
  }

  PP.night = { active: active, reset: reset, update: update, render: render, onPop: onPop, onHit: onHit, hide: hide, force: force, info: info };
})();
