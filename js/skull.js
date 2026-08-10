/* =========================================================
 * skull.js — 骸骨玉(通常コースの弾幕ボール)
 *
 * チェーンの一部の玉に骸骨マークが付く(chain.js spawnBalls)。
 * 放置すると予兆(赤い明滅+警告音)のあと、大砲を狙った扇状の
 * 妖弾を撃つ。被弾で停止(freeze)か操作反転(addle)。
 * 破壊すればパワーアップ確定ドロップ+ボーナススコア(chain.js)。
 *
 * 弾の動き・迎撃・大砲ヒットの作法は boss.js の妖弾に合わせてある
 * (直進弾のみの縮小版)。状態異常タイマー(PP.game.bossFx)の減算は
 * powerups.js の update に一本化されているので、ここでは値を入れるだけ。
 * ボス戦ではこのモジュールは動かない(main.js が呼ばない)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var cont = null;        // 弾と墨を入れる自前レイヤー(fx レイヤーの最下段)
  var bullets = [];       // {x, y, vx, vy, r, view, t}
  var inkBlobs = [];      // {sh, bx, by, ph, life}(パワーダウン🦑の墨だまり)
  var playerHitCd = 0;    // 被弾後の無敵残り秒(扇の多段ヒット=スタンロック防止)
  var t = 0;              // 明滅・墨の揺らぎ用の通し時間
  var tmpPos = {};        // rail.posAtInto 用の使い回しオブジェクト

  // レイヤーは main.js の init 後でないと存在しないので、初回に遅延生成
  function ensureCont() {
    if (cont || !PP.layers) return;
    cont = new createjs.Container();
    PP.layers.fx.addChildAt(cont, 0);   // 玉より上・大砲/HUD より下(ボス弾と同じ)
  }

  // 盤面にいる骸骨玉の数(spawnBalls が同時存在上限の判定に使う)
  function countActive() {
    var n = 0;
    PP.game.eachLaneBall(function (b) { if (b.skull) n++; });
    return n;
  }

  // 骸骨玉が「撃ってよい」状態か: 洞窟から出ていて、樽際の発射禁止帯
  // (レール終盤 quietZone 割合。至近距離の確定被弾を防ぐ)より手前で、
  // トンネルの中でもない(見えない場所からの弾は理不尽なので撃たせない)
  function canFire(b, lane) {
    return b.d >= PP.R &&
           b.d <= lane.rail.holeD * (1 - PP.SKULL.quietZone) &&
           !lane.rail.tunnelAt(b.d) && b.view.visible;
  }

  // 妖弾の見た目: 暗紅色の光球(ボスの妖弾と同じ radial gradient の作法)
  function makeBulletView() {
    var S = PP.SKULL;
    var sh = new createjs.Shape();
    sh.graphics
      .beginRadialGradientFill(["#ffffff", "#ff4d4d", "rgba(0,0,0,0)"], [0, 0.45, 1],
        0, 0, 0, 0, 0, S.orbR * 1.7)
      .drawCircle(0, 0, S.orbR * 1.7)
      .setStrokeStyle(2).beginStroke("#ff4d4d").drawCircle(0, 0, S.orbR);
    return sh;
  }

  // 扇状に発射。狙いは「発射した瞬間の大砲の位置」で固定(=横に逃げれば躱せる。
  // boss.js の barrage と同じフェアネスの作法)
  function fireFan(x, y) {
    var S = PP.SKULL;
    var aimX = PP.cannon.x, aimY = PP.cannon.y - 20;
    var base = Math.atan2(aimY - y, aimX - x);
    var spread = S.spreadDeg * Math.PI / 180;
    // 弾速は距離から逆算: どこから撃たれても着弾までほぼ travelTime 秒。
    // 近い骸骨の弾は遅く、遠い骸骨の弾は速くなり、回避猶予が一定になる
    var dist = Math.sqrt((aimX - x) * (aimX - x) + (aimY - y) * (aimY - y));
    var spd = Math.min(S.speedMax, Math.max(S.speedMin, dist / S.travelTime));
    for (var i = 0; i < S.fan; i++) {
      var ang = S.fan > 1 ? base - spread / 2 + spread * (i / (S.fan - 1)) : base;
      var view = makeBulletView();
      view.x = x; view.y = y;
      cont.addChild(view);
      bullets.push({
        x: x, y: y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        r: S.orbR, view: view, t: Math.random() * 6.28
      });
    }
    PP.fx.ring(x, y, "#ff4d4d", 10, 70, 400);
    PP.audio.darkMagic();   // 暗黒魔法の発射音
  }

  // 妖弾が大砲に命中: 停止か操作反転のどちらかがかかる(50/50)。
  // 直後の無敵(hitIFrames)で扇の残りが多段ヒットしないようにする
  function applyHit() {
    var g = PP.game;
    var S = PP.SKULL;
    playerHitCd = S.hitIFrames;
    PP.fx.shake(8, 0.25);
    PP.audio.debuff();   // 状態異常がかかった合図
    if (Math.random() < 0.5) {
      g.bossFx.freeze = S.freezeDur;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffd24a", 10, 90, 500);
      PP.fx.floatText("⛓ 動けない!", PP.cannon.x, PP.cannon.y - 70, "#ffd24a", 18);
    } else {
      g.bossFx.addle = S.addleDur;
      PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ff5d8f", 10, 90, 500);
      PP.fx.floatText("🌀 操作が逆に!", PP.cannon.x, PP.cannon.y - 70, "#ff5d8f", 18);
    }
  }

  function removeBullet(i) {
    var b = bullets[i];
    if (b.view.parent) b.view.parent.removeChild(b.view);
    bullets.splice(i, 1);
  }

  // 骸骨玉ごとの発射管理: クールダウン → 予兆(マークが赤く明滅)→ 発射。
  // 予兆中に消された・トンネルに入った等は黙ってキャンセル(次の機会へ)
  function updateSkullBalls(dt) {
    var S = PP.SKULL;
    // 危機(赤い帳)の最中は全骸骨が沈黙する: チェーンが樽に迫っている間は
    // 「列との勝負」に集中させ、弾幕とのリスク二重取りを起こさない(樽際の
    // 発射禁止帯と同じ思想の全体版)。クールダウンも凍結するので、危機が
    // 明けた瞬間に溜まった骸骨が一斉発射することもない
    var crisisNow = PP.crisis && PP.crisis.level && PP.crisis.level() > 0.05;
    PP.game.eachLaneBall(function (b, lane) {
      if (!b.skull) return;
      var fx = b.skullFx;   // ball.js makeSkullOverlay(chain.js が付ける)

      if (crisisNow || !canFire(b, lane)) {
        b.skullTele = 0;    // 隠れたら予兆は仕切り直し
        if (fx) fx.ring.alpha = 0.4;
        return;
      }

      if (b.skullTele > 0) {
        // 予兆中: マークのリングを速く強く明滅させて「来るぞ」を伝える
        b.skullTele -= dt;
        if (fx) fx.ring.alpha = 0.55 + 0.45 * Math.sin(t * 18);
        if (b.skullTele <= 0) {
          lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
          fireFan(tmpPos.x, tmpPos.y);
          b.skullCd = S.cooldownMin + Math.random() * (S.cooldownMax - S.cooldownMin);
          if (fx) fx.ring.alpha = 0.4;
        }
        return;
      }

      // 通常時: ゆっくり脈動しつつクールダウンを消化
      if (fx) fx.ring.alpha = 0.3 + 0.15 * Math.sin(t * 3);
      b.skullCd = (b.skullCd === undefined ? S.firstDelay : b.skullCd) - dt;
      if (b.skullCd <= 0) {
        b.skullTele = S.telegraph;
        lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
        PP.fx.ring(tmpPos.x, tmpPos.y, "#ff4d4d", 8, 50, S.telegraph * 1000);
        PP.audio.beep(140, 0.3, "sawtooth", 0.08);
      }
    });
  }

  // 妖弾の進行: 移動 → 自弾との迎撃 → 大砲への命中 → 画面外の後始末
  // (boss.js updateBullets の直進弾のみの縮小版)
  function updateBullets(dt) {
    if (bullets.length === 0) return;
    var g = PP.game;
    var O = PP.BOSS.orb;    // 大砲へのヒット箱はボスの妖弾と同じ寸法感
    var cx = PP.cannon.x, cy = PP.cannon.y;
    for (var i = bullets.length - 1; i >= 0; i--) {
      var b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.t += dt;
      b.view.x = b.x; b.view.y = b.y;
      var pulse = 1 + 0.12 * Math.sin(b.t * 10);
      b.view.scaleX = b.view.scaleY = pulse;
      // 尾を引く残光(軌道が線で読める=避けやすい)
      if (Math.random() < dt * 20) PP.fx.burst(b.x, b.y, "#ff4d4d", 1, 0.5);

      // 迎撃: 自分の弾をぶつけると相殺して消せる(通常弾は1発と交換、
      // ミサイルは貫通なので消費せずに薙ぎ払える)
      var blocked = false;
      for (var s = g.shots.length - 1; s >= 0; s--) {
        var sh = g.shots[s];
        var dx = sh.x - b.x, dy = sh.y - b.y;
        var rr = b.r + PP.R * 0.9;
        if (dx * dx + dy * dy < rr * rr) {
          PP.fx.burst(b.x, b.y, "#ff4d4d", 10, 1.2);
          PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 34);
          PP.fx.floatText("迎撃!", b.x, b.y - 26, "#8ef0d0", 18);
          PP.audio.beep(720, 0.1, "square", 0.08);
          if (sh.special !== "missile") {
            if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
            PP.layers.shot.removeChild(sh.view);
            g.shots.splice(s, 1);
          }
          blocked = true;
          break;
        }
      }
      if (blocked) { removeBullet(i); continue; }

      // 大砲への命中(無敵中は素通り=多段ヒット防止)
      if (playerHitCd <= 0 &&
          Math.abs(b.x - cx) <= O.catchW &&
          b.y >= cy - O.catchTop && b.y <= cy + O.catchBottom) {
        applyHit();
        removeBullet(i);
        continue;
      }

      // 画面外
      if (b.y > PP.H + 40 || b.y < -60 || b.x < -60 || b.x > PP.W + 60) removeBullet(i);
    }
  }

  // ---------- 墨だまり(パワーダウン🦑を取ってしまったときの目つぶし) ----------
  // boss.js splatInk と同じ描き方。効果時間は取ったアイテムの dur に合わせる
  function splatInk(count, dur) {
    ensureCont();
    if (!cont) return;
    var B = PP.BOSS.ink;   // 墨の半径レンジはボスの定義を借りる
    for (var i = 0; i < count; i++) {
      var r = (B.rMin + Math.random() * (B.rMax - B.rMin)) * 1.25;
      var bx = 120 + Math.random() * (PP.W - 240);
      var by = 140 + Math.random() * (PP.H - 260);
      var sh = new createjs.Shape();
      // ボスの墨(ほぼ真っ黒)より薄めにする: 「見づらいが、うっすら透けて見える」
      // 程度に留めて、理不尽さより駆け引き(避けそこねのペナルティ)に寄せる
      sh.graphics.beginRadialGradientFill(
        ["rgba(10,8,14,0.72)", "rgba(10,8,14,0.66)", "rgba(10,8,14,0.5)", "rgba(10,8,14,0)"],
        [0, 0.55, 0.82, 1],
        0, 0, 0, 0, 0, r).drawCircle(0, 0, r);
      sh.x = bx; sh.y = by;
      sh.alpha = 0;
      createjs.Tween.get(sh).to({ alpha: 1 }, 220);
      cont.addChild(sh);
      inkBlobs.push({ sh: sh, bx: bx, by: by, ph: Math.random() * 6.28, life: dur });
    }
    PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, "rgba(20,14,26,0.9)", 14, 1.5);
    PP.audio.inkSplat();
  }

  function updateInk(dt) {
    for (var i = inkBlobs.length - 1; i >= 0; i--) {
      var b = inkBlobs[i];
      b.life -= dt;
      if (b.life <= 0) {
        createjs.Tween.removeTweens(b.sh);
        if (b.sh.parent) b.sh.parent.removeChild(b.sh);
        inkBlobs.splice(i, 1);
        continue;
      }
      b.sh.x = b.bx + Math.sin(t * 0.7 + b.ph) * 10;
      b.sh.y = b.by + Math.cos(t * 0.5 + b.ph) * 6;
      if (b.life < 0.8) b.sh.alpha = b.life / 0.8;   // 「晴れていく」フェード
    }
  }

  // ---------- 毎フレーム(main.js の tick、playing かつ非ボス戦のみ) ----------
  function update(dt) {
    ensureCont();
    if (!cont) return;
    t += dt;
    if (playerHitCd > 0) playerHitCd -= dt;
    updateSkullBalls(dt);
    updateBullets(dt);
    updateInk(dt);
  }

  // レベル開始・リトライ・ゲームオーバー時の後始末
  function clear() {
    for (var i = 0; i < bullets.length; i++) {
      if (bullets[i].view.parent) bullets[i].view.parent.removeChild(bullets[i].view);
    }
    bullets.length = 0;
    for (var j = 0; j < inkBlobs.length; j++) {
      createjs.Tween.removeTweens(inkBlobs[j].sh);
      if (inkBlobs[j].sh.parent) inkBlobs[j].sh.parent.removeChild(inkBlobs[j].sh);
    }
    inkBlobs.length = 0;
    playerHitCd = 0;
  }

  // デバッグ用: 最初の骸骨玉のクールダウンを飛ばして即予兆に入れる
  // (コンソールから PP.skull.debugForceFire() で動作確認できる)
  function debugForceFire() {
    PP.game.eachLaneBall(function (b) {
      if (b.skull) { b.skullCd = 0.01; return false; }
    });
  }

  PP.skull = {
    update: update,
    clear: clear,
    countActive: countActive,
    splatInk: splatInk,
    debugForceFire: debugForceFire
  };
})();
