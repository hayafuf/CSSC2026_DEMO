/* =========================================================
 * skull.js — 骸骨玉(通常コースの弾幕ボール)
 *
 * チェーンの一部の玉に骸骨マークが付く(chain.js spawnBalls)。
 * 放置すると予兆(明滅+警告音)のあと、大砲を狙った扇状の妖弾を撃つ。
 * 被弾で停止(freeze)か操作反転(addle)。デバフの種類は予兆の時点で
 * 決まっていて、予兆リングと弾の色、そして弾道で読める(弾幕シューティング
 * の作法。色はボスの妖弾 ATTACKS と同じ言語: freeze=金 / addle=桃)。
 * 弾道も性質と揃える: freeze(錨)は重力で落下加速する重い弾、
 * addle(渦)は直線弾の回転掃射(渦の模様は「回転する発射角」が作る。
 * 弾自体は揺らさない=軌道が直線で読める。パラメータは config.js PP.SKULL)。
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

  // 弾1発の生成(全パターン共通の実弾。基本は直線弾で、freeze だけ重力が乗る)。
  // opts(省略可)で弾幕STG流の「軌道の芸」を持たせる:
  //   wave: { amp, freq, ph } … 進行方向の法線方向にサイン波で蛇行(amp は横向き速度 px/s)
  //   spdCurve: { s0, s1, s2, t1, t2 } … 速度倍率が s0→(t1秒)→s1→(t2秒)→s2 と
  //             区分線形に変わる「呼吸する弾」(減速局面が相殺の狙い目になる)
  //   vx / vy … 速度の直接指定(ロブ弾用。ang/spd の計算を上書き)
  //   grav   … 重力の個別指定(freeze の既定 freezeGravity を上書き)
  function spawnBullet(x, y, ang, spd, type, opts) {
    var view = makeBulletView(type);
    view.x = x; view.y = y;
    cont.addChild(view);
    var b = {
      x: x, y: y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r: PP.SKULL.orbR, type: type, view: view,
      t: Math.random() * 6.28          // 脈動・回転用(初期値ランダムで揃い踏み防止)
    };
    if (opts) {
      if (opts.vx !== undefined) b.vx = opts.vx;
      if (opts.vy !== undefined) b.vy = opts.vy;
      if (opts.grav !== undefined) b.grav = opts.grav;
      if (opts.wave) b.wave = { nx: -Math.sin(ang), ny: Math.cos(ang),
                                amp: opts.wave.amp, freq: opts.wave.freq,
                                ph: opts.wave.ph || 0, t: 0 };
      if (opts.spdCurve) b.spdCurve = { ux: Math.cos(ang), uy: Math.sin(ang),
                                        spd: spd, c: opts.spdCurve, t: 0 };
    }
    bullets.push(b);
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
    // 弾幕STG変種の抽選: 各タイプに A(既存の強化)/B(新パターン)の2種。
    // A: freeze=二連斉射+追い錨 / addle=渦巻き掃射(奇数弾が蛇行)
    // B: freeze=落錨の簾(山なりロブのカーテン) / addle=三連の波紋(呼吸する扇)
    var variant = Math.random() < S.variantChance ? "B" : "A";
    b.skullVolley = {
      type: type,
      variant: variant,
      base: Math.atan2(aimY - tmpPos.y, aimX - tmpPos.x),
      spd: spd,
      step: 0,
      steps: type === "freeze" ? (variant === "B" ? 1 : S.freezeWaves + 1)
                               : (variant === "B" ? S.addlePulses : S.addleCount),
      gap: type === "freeze" ? S.freezeWaveGap
                             : (variant === "B" ? S.addlePulseGap : S.addleEmitGap),
      timer: 0,                              // 0 始まり=最初のステップは即発射
      dir: Math.random() < 0.5 ? 1 : -1,     // 渦の巻き方向(addle)
      // 落錨の簾: 着弾X(大砲を中心に rainSpreadX 間隔)は開始時に固定
      // =横に一歩ずれれば必ず隙間に入れる
      rainCenterX: aimX
    };
    // 号砲はパターン開始の1回だけ(白閃+デバフ色の二重リング)
    PP.fx.flash(tmpPos.x, tmpPos.y, "rgba(255,255,255,0.85)", 40);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 10, 80, 420);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 4, 44, 300);
    PP.audio.darkMagic();   // 暗黒魔法の発射音
  }

  // 弾幕の1ステップぶんを発射(タイプ×変種で4パターン)
  function volleyStep(b, lane) {
    var S = PP.SKULL;
    var v = b.skullVolley;
    var T = TYPES[v.type];
    lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
    var x = tmpPos.x, y = tmpPos.y;
    if (v.type === "freeze" && v.variant === "B") {
      // 落錨の簾: 上向きロブを一斉に放ち、大砲の周囲へ rainSpreadX 間隔の
      // カーテン状に降らせる。着弾Xは開始時固定=隙間に立てば安全
      for (var ri = 0; ri < S.rainCount; ri++) {
        var tx = v.rainCenterX + (ri - (S.rainCount - 1) / 2) * S.rainSpreadX;
        // 放物線: vy0 で打ち上げて grav で落とす。大砲の高さへの到達時間から vx を逆算
        var fallT = (Math.sqrt(S.rainVy0 * S.rainVy0 +
                     2 * S.rainGrav * Math.max(40, PP.cannon.y - 20 - y)) - S.rainVy0) / S.rainGrav;
        spawnBullet(x, y, 0, 0, "freeze",
          { vx: (tx - x) / fallT, vy: S.rainVy0, grav: S.rainGrav });
      }
      PP.fx.ring(x, y, T.color, 8, 64, 360);
      PP.audio.beep(180, 0.16, "sawtooth", 0.09);
      PP.audio.gliss(320, 140, 0.5, "sine", 0.06);   // 打ち上げの重いうねり
    } else if (v.type === "freeze") {
      if (v.step >= S.freezeWaves) {
        // 追い錨: 2波目の後、開始時の狙い角のまま1発だけ重く速く落とす。
        // 「扇をやり過ごした」直後の油断を突く一撃(狙い直しはしない=読める)
        spawnBullet(x, y, v.base, v.spd * S.anchorSpeedMul, "freeze",
          { grav: S.freezeGravity * S.anchorGravMul });
        PP.fx.ring(x, y, T.color, 5, 48, 300);
        PP.audio.gliss(500, 120, 0.4, "sine", 0.07);   // 落下のヒュー音
      } else {
        // 三叉の斉射。2波目は弾間の半分だけ角度をずらす「奇偶弾」:
        // 1波目の隙間に立って避けた場所を塞ぐ(立ち位置を変え続けさせる)。
        // 弾ごとの速度ジッターで扇に奥行きを出す(前後に波打つ錨鎖)
        var spread = S.spreadDeg * Math.PI / 180;
        var off = v.step === 0 ? 0 : spread / (S.fan - 1) / 2;
        for (var i = 0; i < S.fan; i++) {
          var ang = (S.fan > 1 ? v.base - spread / 2 + spread * (i / (S.fan - 1)) : v.base) + off;
          var jit = 1 + (Math.random() * 2 - 1) * S.freezeSpeedJitter;
          spawnBullet(x, y, ang, v.spd * jit, "freeze");
        }
        PP.fx.ring(x, y, T.color, 6, 56, 320);
        if (v.step > 0) PP.audio.beep(150, 0.12, "sawtooth", 0.08);   // 追い波の重い手応え
        // 最終波を撃ったら、追い錨までの間合いを anchorDelay に切り替える
        if (v.step === S.freezeWaves - 1) v.gap = S.anchorDelay;
      }
    } else if (v.variant === "B") {
      // 三連の波紋: 開始時狙いの扇×4発を3パルス。各弾は「1.25倍速で出て
      // 減速→再加速」の呼吸カーブ(止まりかけの弾の間を抜けると加速して追う)
      var pSpread = S.addlePulseSpreadDeg * Math.PI / 180;
      for (var pi = 0; pi < S.addlePulsePer; pi++) {
        var pAng = v.base - pSpread / 2 + pSpread * (S.addlePulsePer > 1 ? pi / (S.addlePulsePer - 1) : 0.5);
        spawnBullet(x, y, pAng, v.spd, "addle", { spdCurve: S.addlePulseCurve });
      }
      PP.fx.ring(x, y, T.color, 5, 50, 300);
      PP.audio.beep(520 + v.step * 60, 0.07, "square", 0.05);   // パルスごとに音程が上がる
    } else {
      // 渦巻きの掃射: 掃射角 addleSweepDeg を弾数で割って1発ずつ回す。
      // 直線弾の連続発射が、結果として螺旋の模様を描く(弾幕STGの渦の作法)。
      // 奇数弾だけサイン波で蛇行=らせんの骨格(偶数弾)は読めるまま網目が揺れる
      var sweep = S.addleSweepDeg * Math.PI / 180;
      var k = v.steps > 1 ? v.step / (v.steps - 1) : 0.5;
      var ang2 = v.base + v.dir * (-sweep / 2 + sweep * k);
      var wob = (v.step & 1) === 1
        ? { wave: { amp: S.addleWave.amp, freq: S.addleWave.freq, ph: Math.random() * 6.28 } }
        : null;
      spawnBullet(x, y, ang2, v.spd, "addle", wob);
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
      // freeze(錨)だけ重力で落下加速(遅く出て速く落ちる。横に逃げて躱す)。
      // b.grav があれば個別指定を優先(落錨の簾のロブ/追い錨の重い落下)
      if (b.type === "freeze") b.vy += (b.grav !== undefined ? b.grav : S.freezeGravity) * dt;
      // 呼吸する弾(addle B): 速度倍率が s0→s1→s2 と区分線形で変わる。
      // 狙い・向きは発射時に固定済み=減速しても曲がらない(理不尽回避)
      if (b.spdCurve) {
        var C = b.spdCurve;
        C.t += dt;
        var sc = C.t < C.c.t1 ? C.c.s0 + (C.c.s1 - C.c.s0) * (C.t / C.c.t1)
               : C.t < C.c.t2 ? C.c.s1 + (C.c.s2 - C.c.s1) * ((C.t - C.c.t1) / (C.c.t2 - C.c.t1))
               : C.c.s2;
        b.vx = C.ux * C.spd * sc;
        b.vy = C.uy * C.spd * sc;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // 蛇行弾(addle A の奇数弾): 進行方向の法線にサイン波を重ねる
      // (boss.js の wave 弾と同方式。振幅は小さめ+残光で軌道は読める)
      if (b.wave) {
        b.wave.t += dt;
        var wob = Math.sin(b.wave.t * b.wave.freq + b.wave.ph) * b.wave.amp * dt;
        b.x += b.wave.nx * wob;
        b.y += b.wave.ny * wob;
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

      // 画面外(重力持ちの上昇中ロブは頂点で戻ってくるので上端では消さない)
      if (b.y > PP.H + 40 || (b.y < -60 && !(b.grav !== undefined && b.vy < 0)) ||
          b.x < -60 || b.x > PP.W + 60) removeBullet(i);
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
