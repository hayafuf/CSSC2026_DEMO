/* =========================================================
 * skull.js — 骸骨玉(通常コースの弾幕ボール)
 *
 * チェーンの一部の玉に骸骨マークが付く(chain.js spawnBalls)。
 * 放置すると予兆(明滅+警告音)のあと、大砲を狙った扇状の妖弾を撃つ。
 * 被弾で停止(freeze)か操作反転(addle)。デバフの種類は予兆の時点で
 * 決まっていて、予兆リングと弾の色、そして弾道で読める(弾幕シューティング
 * の作法。色はボスの妖弾 ATTACKS と同じ言語: freeze=金 / addle=桃)。
 * 弾道も性質と揃える: freeze(錨)は重力で落下加速する重い弾、
 * addle(渦)は撃ち出し直後だけ波打ち、減衰して直線に収束する蛇行弾
 * (揺れっぱなしだと軌道が読めず理不尽。パラメータは config.js PP.SKULL)。
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

  // デバフ種類ごとの色と演出の定義。色は boss.js の ATTACKS・applyHit の
  // 着弾リングと同じ言語(freeze=金の錨鎖 / addle=桃の逆潮)。
  // 予兆リング・弾・残光・迎撃の火花まで全部この色で統一し、
  // 「何が飛んでくるか」を発射前から読めるようにする
  var TYPES = {
    freeze: {
      color: "#ffd24a",
      glowIn: "rgba(255,235,170,0.95)", glowMid: "rgba(255,180,40,0.35)",
      coreEdge: "rgba(255,224,140,0.9)",
      label: "⛓ 動けない!",
      teleBeep: 120        // 予兆の警告音の高さ(低い=重い錨)
    },
    addle: {
      color: "#ff5d8f",
      glowIn: "rgba(255,214,230,0.95)", glowMid: "rgba(255,60,130,0.35)",
      coreEdge: "rgba(255,190,215,0.9)",
      label: "🌀 操作が逆に!",
      teleBeep: 175        // 高い=惑わせる渦
    }
  };
  function pickType() { return Math.random() < 0.5 ? "freeze" : "addle"; }

  // 妖弾の見た目: 白熱のコア+色付きグロー+回転が見える衛星粒の光球。
  // boss.js makeOrbView と同じく種類ごとに1回だけ canvas へ焼いて全弾で
  // 共有する(旧実装は弾ごとに radial gradient の Shape を作っていた)
  var orbSprites = {};      // type -> 焼き込み済み canvas
  var ORB_SCALE = 1.25;     // 高解像度で焼いて縮小表示(拡大時のボケ防止)
  function orbSprite(type) {
    if (orbSprites[type]) return orbSprites[type];
    var R = PP.SKULL.orbR;
    var T = TYPES[type];
    var half = Math.ceil(R * 2.4 * ORB_SCALE);
    var cv = document.createElement("canvas");
    cv.width = cv.height = half * 2;
    var ctx = cv.getContext("2d");
    ctx.translate(half, half);
    ctx.scale(ORB_SCALE, ORB_SCALE);
    // 外周のグロー(加算合成で光って見える)
    var glow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.2);
    glow.addColorStop(0, T.glowIn);
    glow.addColorStop(0.55, T.glowMid);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, R * 2.2, 0, 6.2832); ctx.fill();
    // 色付きの外殻リング(弾幕STGの「輪郭で当たりが読める」弾)
    ctx.strokeStyle = T.color;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.stroke();
    // 白熱のコア
    var core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.62);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(0.7, T.coreEdge);
    core.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.62, 0, 6.2832); ctx.fill();
    // 対角4つの衛星粒(回転させたときに「回っている」のが見える)
    ctx.fillStyle = T.color;
    for (var k = 0; k < 4; k++) {
      var a = k * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * R * 1.45, Math.sin(a) * R * 1.45, 2.6, 0, 6.2832);
      ctx.fill();
    }
    orbSprites[type] = cv;
    return cv;
  }
  var BULLET_BASE = 1 / ORB_SCALE;   // 表示上の基準スケール(pulse はこれに掛ける)
  function makeBulletView(type) {
    var bmp = new createjs.Bitmap(orbSprite(type));
    bmp.regX = bmp.regY = bmp.image.width / 2;
    bmp.scaleX = bmp.scaleY = BULLET_BASE;
    bmp.compositeOperation = "lighter";
    return bmp;
  }

  // 弾1発の生成(全パターン共通の実弾)
  function spawnBullet(x, y, ang, spd, type, ph) {
    var view = makeBulletView(type);
    view.x = x; view.y = y;
    cont.addChild(view);
    bullets.push({
      x: x, y: y,
      bx: x, by: y,                    // 蛇行の基準点(直進する芯。addle が使う)
      nx: -Math.sin(ang), ny: Math.cos(ang),   // 進路と直交の単位ベクトル
      ph: ph || 0,                     // 蛇行の位相
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r: PP.SKULL.orbR, type: type, view: view,
      t: Math.random() * 6.28,         // 脈動・回転用(初期値ランダムで揃い踏み防止)
      st: 0                            // 蛇行用の経過秒(0 始まりで発射口から滑らかに振れる)
    });
  }

  // 次の発射までのクールダウンを引き直す
  function nextCd() {
    var S = PP.SKULL;
    return S.cooldownMin + Math.random() * (S.cooldownMax - S.cooldownMin);
  }

  // 予兆明け: 弾幕パターンの開始。狙い(base)と弾速は開始の瞬間に固定する
  // (=横に逃げれば躱せる。boss.js の barrage と同じフェアネスの作法。
  // 発射中に狙い直すとホーミングじみて理不尽になるのでやらない)。
  // 発射口だけは骸骨玉に追従し、撃っている骸骨玉を消せば弾幕は打ち切られる
  // =撃たれ始めてからも迎撃する価値がある
  function startVolley(b, lane, type) {
    var S = PP.SKULL;
    var T = TYPES[type];
    lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
    var aimX = PP.cannon.x, aimY = PP.cannon.y - 20;
    // 弾速は距離から逆算: どこから撃たれても着弾までほぼ travelTime 秒。
    // 近い骸骨の弾は遅く、遠い骸骨の弾は速くなり、回避猶予が一定になる
    var dist = Math.sqrt((aimX - tmpPos.x) * (aimX - tmpPos.x) +
                         (aimY - tmpPos.y) * (aimY - tmpPos.y));
    var spd = Math.min(S.speedMax, Math.max(S.speedMin, dist / S.travelTime));
    // freeze(錨)は重い弾: 出だしを遅くするかわりに重力(updateBullets)で
    // 落下加速する。初速で減らしたぶんは加速で取り返すので到達時間は近い
    if (type === "freeze") spd *= S.freezeSpeedMul;
    b.skullVolley = {
      type: type,
      base: Math.atan2(aimY - tmpPos.y, aimX - tmpPos.x),
      spd: spd,
      step: 0,
      steps: type === "freeze" ? S.freezeWaves : S.addleCount,
      gap: type === "freeze" ? S.freezeWaveGap : S.addleEmitGap,
      timer: 0,                              // 0 始まり=最初のステップは即発射
      dir: Math.random() < 0.5 ? 1 : -1      // 渦の巻き方向(addle)
    };
    // 号砲はパターン開始の1回だけ(白閃+デバフ色の二重リング)
    PP.fx.flash(tmpPos.x, tmpPos.y, "rgba(255,255,255,0.85)", 40);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 10, 80, 420);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 4, 44, 300);
    PP.audio.darkMagic();   // 暗黒魔法の発射音
  }

  // 弾幕の1ステップぶんを発射(freeze=三叉1波 / addle=渦巻きの1発)
  function volleyStep(b, lane) {
    var S = PP.SKULL;
    var v = b.skullVolley;
    var T = TYPES[v.type];
    lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
    var x = tmpPos.x, y = tmpPos.y;
    if (v.type === "freeze") {
      // 三叉の斉射。2波目は弾間の半分だけ角度をずらす「奇偶弾」:
      // 1波目の隙間に立って避けた場所を塞ぐ(立ち位置を変え続けさせる)
      var spread = S.spreadDeg * Math.PI / 180;
      var off = v.step === 0 ? 0 : spread / (S.fan - 1) / 2;
      for (var i = 0; i < S.fan; i++) {
        var ang = (S.fan > 1 ? v.base - spread / 2 + spread * (i / (S.fan - 1)) : v.base) + off;
        spawnBullet(x, y, ang, v.spd, "freeze", 0);
      }
      PP.fx.ring(x, y, T.color, 6, 56, 320);
      if (v.step > 0) PP.audio.beep(150, 0.12, "sawtooth", 0.08);   // 追い波の重い手応え
    } else {
      // 渦巻きの掃射: 掃射角 addleSweepDeg を弾数で割って1発ずつ回す。
      // 位相も1発ずつずらすので、蛇行と合わさって螺旋がうねって見える
      var sweep = S.addleSweepDeg * Math.PI / 180;
      var k = v.steps > 1 ? v.step / (v.steps - 1) : 0.5;
      var ang2 = v.base + v.dir * (-sweep / 2 + sweep * k);
      spawnBullet(x, y, ang2, v.spd, "addle", v.step * 0.9);
      PP.fx.burst(x, y, T.color, 2, 0.9);
      if ((v.step & 1) === 0) PP.audio.beep(560 + v.step * 45, 0.05, "square", 0.045);
    }
    v.step++;
  }

  // 妖弾が大砲に命中: 弾の種類どおりのデバフがかかる(種類は予兆時に決定済み。
  // 弾の色=かかるデバフなので、どれを避けるかの取捨選択ができる)。
  // 直後の無敵(hitIFrames)で扇の残りが多段ヒットしないようにする
  function applyHit(type) {
    var g = PP.game;
    var S = PP.SKULL;
    var T = TYPES[type];
    playerHitCd = S.hitIFrames;
    PP.fx.shake(8, 0.25);
    PP.audio.debuff();   // 状態異常がかかった合図
    if (type === "freeze") g.bossFx.freeze = S.freezeDur;
    else g.bossFx.addle = S.addleDur;
    PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, T.color, 10, 90, 500);
    PP.fx.screenFlash(T.color, 0.1, 220);   // 画面縁も薄く同色に染めて被弾を強調
    PP.fx.floatText(T.label, PP.cannon.x, PP.cannon.y - 70, T.color, 18);
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
        if (b.skullVolley) {
          // 撃っている最中に隠れた/危機が来た: 弾幕は打ち切り(出た弾は残る)
          b.skullVolley = null;
          b.skullCd = nextCd();
        }
        if (fx) fx.ring.alpha = 0.4;
        return;
      }

      if (b.skullVolley) {
        // 発射中: パターンの続きを撃つ(発射口は玉に追従)。マークは最速で明滅。
        // 処理落ちフレームでは while で複数ステップまとめて撃つ
        var v = b.skullVolley;
        if (fx) fx.ring.alpha = 0.7 + 0.3 * Math.sin(t * 24);
        v.timer -= dt;
        while (v.timer <= 0 && v.step < v.steps) {
          volleyStep(b, lane);
          v.timer += v.gap;
        }
        if (v.step >= v.steps) {
          b.skullVolley = null;
          b.skullCd = nextCd();
          if (fx) fx.ring.alpha = 0.4;
        }
        return;
      }

      if (b.skullTele > 0) {
        // 予兆中: マークのリングを速く強く明滅させて「来るぞ」を伝える
        b.skullTele -= dt;
        if (fx) fx.ring.alpha = 0.55 + 0.45 * Math.sin(t * 18);
        if (b.skullTele <= 0) {
          startVolley(b, lane, b.skullType || pickType());
        }
        return;
      }

      // 通常時: ゆっくり脈動しつつクールダウンを消化
      if (fx) fx.ring.alpha = 0.3 + 0.15 * Math.sin(t * 3);
      b.skullCd = (b.skullCd === undefined ? S.firstDelay : b.skullCd) - dt;
      if (b.skullCd <= 0) {
        // どのデバフを撃つかは予兆の時点で決め、予兆リングをその色で出す
        // (=飛んでくる前から種類が読める)。警告音の高さも種類で変える
        b.skullType = pickType();
        var T = TYPES[b.skullType];
        b.skullTele = S.telegraph;
        lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
        PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 8, 50, S.telegraph * 1000);
        PP.audio.beep(T.teleBeep, 0.3, "sawtooth", 0.08);
      }
    });
  }

  // 妖弾の進行: 移動 → 自弾との迎撃 → 大砲への命中 → 画面外の後始末
  // (boss.js updateBullets の直進弾のみの縮小版)
  function updateBullets(dt) {
    if (bullets.length === 0) return;
    var g = PP.game;
    var S = PP.SKULL;
    var O = PP.BOSS.orb;    // 大砲へのヒット箱はボスの妖弾と同じ寸法感
    var cx = PP.cannon.x, cy = PP.cannon.y;
    for (var i = bullets.length - 1; i >= 0; i--) {
      var b = bullets[i];
      b.t += dt;
      b.st += dt;
      if (b.type === "freeze") {
        // 錨の弾: 重力で落下加速しながら直進(遅く出て速く落ちる。横に逃げて躱す)
        b.vy += S.freezeGravity * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      } else {
        // 渦の弾: 直進する芯(bx, by)の周りを進路と直交に正弦で蛇行。
        // 発射時の位相ぶんを引いて、発射口からは必ず滑らかに振れ始める。
        // 蛇行は addleSwayFade 秒かけて減衰し、以降は直線に収束する
        // (渦巻きの本体は回転する発射角。弾まで揺れ続けると軌道が読めない)。
        // 当たり判定も見た目どおり蛇行後の位置(x, y)で取る
        b.bx += b.vx * dt;
        b.by += b.vy * dt;
        var fade = Math.max(0, 1 - b.st / S.addleSwayFade);
        var w = 6.2832 * S.addleWaveHz;
        var sway = (Math.sin(b.st * w + b.ph) - Math.sin(b.ph)) * S.addleWaveAmp * fade;
        b.x = b.bx + b.nx * sway;
        b.y = b.by + b.ny * sway;
      }
      b.view.x = b.x; b.view.y = b.y;
      // 脈動 + 衛星粒の回転(弾幕STGらしい「生きてる弾」。回転は見た目だけで
      // 当たり判定 r は不変)。基準スケールは焼き込み解像度ぶんの縮小
      var pulse = 1 + 0.14 * Math.sin(b.t * 10);
      b.view.scaleX = b.view.scaleY = BULLET_BASE * pulse;
      b.view.rotation = b.t * 160;
      // 尾を引く残光をデバフ色で(軌道が色の線で読める=何が来るか分かる)
      if (Math.random() < dt * 26) PP.fx.burst(b.x, b.y, TYPES[b.type].color, 1, 0.5);

      // 迎撃: 自分の弾をぶつけると相殺して消せる(通常弾は1発と交換、
      // ミサイルは貫通なので消費せずに薙ぎ払える)
      var blocked = false;
      for (var s = g.shots.length - 1; s >= 0; s--) {
        var sh = g.shots[s];
        var dx = sh.x - b.x, dy = sh.y - b.y;
        var rr = b.r + PP.R * 0.9;
        if (dx * dx + dy * dy < rr * rr) {
          PP.fx.burst(b.x, b.y, TYPES[b.type].color, 10, 1.2);
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
        applyHit(b.type);
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
