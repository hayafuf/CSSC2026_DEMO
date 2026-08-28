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
  var parryBeepCd = 0;    // 無敵中の「弾いた」音の間引き(火花は毎回、音は0.12秒に1回)
  var t = 0;              // 明滅・墨の揺らぎ用の通し時間
  var tmpPos = {};        // rail.posAtInto 用の使い回しオブジェクト
  // 直近に予兆を開始した時刻(通し時間 t 基準)。予兆開始どうしの最小間隔
  // (PP.SKULL.teleSpacing)を全骸骨で共有し、攻撃開始を階段状にばらす
  var lastTeleAt = -Infinity;

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
      labelKey: "skull.freeze",   // 表示文言は i18n 辞書(表示の瞬間に t() で引く)
      teleBeep: 120        // 予兆の警告音の高さ(低い=重い錨)
    },
    addle: {
      color: "#ff5d8f",
      glowIn: "rgba(255,214,230,0.95)", glowMid: "rgba(255,60,130,0.35)",
      coreEdge: "rgba(255,190,215,0.9)",
      labelKey: "skull.addle",
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
      t: Math.random() * 6.28,         // 脈動・回転用(初期値ランダムで揃い踏み防止)
      // 【強化】パリィの弾き返し先(発射元の髑髏玉)。volleyStep がモジュール
      // 変数で受け渡す(stepDt と同じ流儀。opts 全呼び出しの書き換えを避ける)
      srcBall: volleySrc, srcLane: volleySrcLane
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
    // 弾幕STG変種の抽選: 各タイプに A(既存の強化)/B(新パターン)の2種。
    // A: freeze=二連斉射+追い錨 / addle=渦巻き掃射(奇数弾が蛇行)
    // B: freeze=連環の錨輪(回転する抜け穴リング) / addle=三連の波紋(呼吸する扇)
    var variant = Math.random() < S.variantChance ? "B" : "A";
    // freeze A(錨)は重い弾: 出だしを遅くするかわりに重力(updateBullets)で
    // 落下加速する。初速で減らしたぶんは加速で取り返すので到達時間は近い。
    // B(錨輪)は無重力(grav:0)なので初速をそのまま使う
    if (type === "freeze" && variant === "A") spd *= S.freezeSpeedMul;
    b.skullVolley = {
      type: type,
      variant: variant,
      base: Math.atan2(aimY - tmpPos.y, aimX - tmpPos.x),
      spd: spd,
      step: 0,
      steps: type === "freeze" ? (variant === "B" ? S.ringCount : S.freezeWaves + 1)
                               : (variant === "B" ? S.addlePulses : S.addleCount),
      gap: type === "freeze" ? (variant === "B" ? S.ringInterval : S.freezeWaveGap)
                             : (variant === "B" ? S.addlePulseGap : S.addleEmitGap),
      timer: 0,                              // 0 始まり=最初のステップは即発射
      dir: Math.random() < 0.5 ? 1 : -1      // 渦の巻き方向(addle)
    };
    // 号砲はパターン開始の1回だけ(白閃+デバフ色の二重リング)
    PP.fx.flash(tmpPos.x, tmpPos.y, "rgba(255,255,255,0.85)", 40);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 10, 80, 420);
    PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 4, 44, 300);
    PP.audio.darkMagic();   // 暗黒魔法の発射音
  }

  // 弾幕の1ステップぶんを発射(タイプ×変種で4パターン)。
  // 発射元(パリィの弾き返し先)は spawnBullet がモジュール変数経由で弾に写す
  var volleySrc = null, volleySrcLane = null;
  function volleyStep(b, lane) {
    var S = PP.SKULL;
    var v = b.skullVolley;
    var T = TYPES[v.type];
    volleySrc = b; volleySrcLane = lane;
    lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
    var x = tmpPos.x, y = tmpPos.y;
    if (v.type === "freeze" && v.variant === "B") {
      // 連環の錨輪: 弾幕STGの定番「回転する抜け穴リング」。
      // 全周リングを1環ずつ撃つ。抜け穴(ringGapBullets 個ぶんの欠け)は
      // 「その環を撃つ瞬間の大砲の位置」を基準に開ける: 発射開始時の狙いを
      // 置き去りにすると、2環目以降の穴がプレイヤーの届かない場所に出て
      // 理不尽になるため。そこから環ごとに ringGapStepDeg ずつ位相を
      // 少しずつずらす=穴は必ず手の届く距離から逃げ始め、追って動き続ける
      // ことになる。環ごとに速度も変える(遅い環を速い環が追い抜いて交差)
      // ので、穴の中で居座ると前後から挟まれる。
      // grav:0 の明示で freeze 既定の重力を殺す=真円のまま広がる
      var n = S.ringBullets;
      var aimNow = Math.atan2(PP.CANNON_Y - y, PP.cannon.x - x);
      var gapCenter = aimNow + v.step * S.ringGapStepDeg * Math.PI / 180 * v.dir;
      var halfGap = Math.PI * S.ringGapBullets / n;   // 穴の半幅(rad)
      var spdR = v.spd * S.ringSpeedMuls[Math.min(v.step, S.ringSpeedMuls.length - 1)];
      for (var bi = 0; bi < n; bi++) {
        var angR = (Math.PI * 2 / n) * bi;
        // 穴との角度差を [-π, π] に正規化して、穴の中は撃たない
        var dAng = angR - gapCenter;
        dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
        if (Math.abs(dAng) < halfGap) continue;
        // 二段速度(緩急): t1 秒までじわっと広がり(読める)、そこから一気に
        // 加速する(確認してから避け始めると追いつかれる)。数値と設計意図は
        // config.js の ringCurve。機構は addle B と同じ spdCurve(updateBullets)
        spawnBullet(x, y, angR, spdR, "freeze", { grav: 0, spdCurve: S.ringCurve });
      }
      PP.fx.ring(x, y, T.color, 8, 70, 380);
      PP.fx.ring(x, y, T.color, 4, 44, 300);
      PP.audio.beep(160 - v.step * 25, 0.14, "sawtooth", 0.1);   // 環ごとに音程が沈む
      PP.audio.gliss(500, 200, 0.25, "square", 0.05);
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
    PP.cannon.setHurt(S.hitIFrames);   // 無敵の残り時間だけ大砲が点滅する
    PP.fx.shake(8, 0.25);
    PP.audio.debuff();   // 状態異常がかかった合図
    if (type === "freeze") g.bossFx.freeze = S.freezeDur;
    else g.bossFx.addle = S.addleDur;
    PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, T.color, 10, 90, 500);
    PP.fx.screenFlash(T.color, 0.1, 220);   // 画面縁も薄く同色に染めて被弾を強調
    PP.fx.floatText(PP.i18n.t(T.labelKey), PP.cannon.x, PP.cannon.y - 70, T.color, 18);
  }

  function removeBullet(i) {
    var b = bullets[i];
    if (b.view.parent) b.view.parent.removeChild(b.view);
    bullets.splice(i, 1);
  }

  // ---------- 【強化】パリィ(構えと成否判定は upgrades.js pressParry/tryParry) ----------
  // 成功の合図。被弾ではないので shake は使わない(揺れは「食らった」の合図)。
  // 音は上昇二連: 無敵バリアの既存 980 単発と聞き分けられるように
  function fxParry(b, labelKey) {
    PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 8, 70, 350);
    PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.85)", 30);
    PP.fx.floatText(PP.i18n.t(labelKey), PP.cannon.x, PP.cannon.y - 70, "#8ef0d0", 18);
    PP.audio.beep(880, 0.06, "triangle", 0.08);
    PP.audio.beep(1480, 0.09, "square", 0.06);
  }

  // 弾き返し開始(Lv2+): 弾を消さずに「撃った本人へ戻る味方の追尾弾」に作り替える。
  // 軌道の芸(重力・蛇行・呼吸)は没収して素直な直進追尾に純化する
  function startReflect(b) {
    b.reflected = true;
    b.grav = 0;
    b.wave = null;
    b.spdCurve = null;
    fxParry(b, "parry.reflect");
    PP.fx.ring(b.x, b.y, TYPES[b.type].color, 8, 60, 320);
    PP.audio.gliss(600, 1200, 0.18, "square", 0.09);   // 上昇グリス=「返した」
  }

  // 骸骨玉ごとの発射管理: クールダウン → 予兆(マークが赤く明滅)→ 発射。
  // 予兆中に消された・トンネルに入った等は黙ってキャンセル(次の機会へ)
  //
  // eachLaneBall のループ本体は無名関数のまま渡すと毎フレーム(全玉2周ぶん)
  // クロージャの確保が起きるので、モジュールスコープへ巻き上げる。フレーム毎の
  // 入力(dt・危機中か・攻撃中の個体数)はモジュール変数で受け渡す
  var stepDt = 0, stepCrisis = false, stepAttacking = 0;
  function countAttacking(b) {
    if (b.skull && (b.skullTele > 0 || b.skullVolley)) stepAttacking++;
  }
  function stepSkullBall(b, lane) {
    var S = PP.SKULL;
    var dt = stepDt;
    if (!b.skull) return;
    var fx = b.skullFx;   // ball.js makeSkullOverlay(chain.js が付ける)

    if (stepCrisis || !canFire(b, lane)) {
      b.skullTele = 0;    // 隠れたら予兆は仕切り直し
      if (b.skullVolley) {
        // 撃っている最中に隠れた/危機が来た: 弾幕は打ち切り(出た弾は残る)
        b.skullVolley = null;
        b.skullCd = nextCd();
      }
      // 沈黙中に CD を使い切っていたら、短めの個別 CD を引き直す。
      // 負のまま放置すると「危機が明けた最初のフレームで、待っていた全個体が
      // 同時に skullCd <= 0 を満たして一斉に予兆入りする」束が生まれる
      // (冒頭コメントの『一斉発射しない』の抜け穴だった)
      if (b.skullCd !== undefined && b.skullCd <= 0) {
        b.skullCd = S.gateRecoverMin +
          Math.random() * (S.gateRecoverMax - S.gateRecoverMin);
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
      // 同時攻撃の全体ゲート: 予兆〜発射中が teleMaxActive 体いる、または
      // 直前の予兆開始から teleSpacing 秒経っていないなら、少し待って
      // 再挑戦する(=攻撃開始が階段状にばらけ、常に「どこかが撃ち、
      // どこかが黙る」波になる。全員一斉は構造的に起きない)
      if (stepAttacking >= S.teleMaxActive || t - lastTeleAt < S.teleSpacing) {
        b.skullCd = S.teleRetryMin +
          Math.random() * (S.teleRetryMax - S.teleRetryMin);
        return;
      }
      stepAttacking++;
      lastTeleAt = t;
      // どのデバフを撃つかは予兆の時点で決め、予兆リングをその色で出す
      // (=飛んでくる前から種類が読める)。警告音の高さも種類で変える
      b.skullType = pickType();
      var T = TYPES[b.skullType];
      b.skullTele = S.telegraph;
      lane.rail.posAtInto(b.d + (b.slide || 0), tmpPos);
      PP.fx.ring(tmpPos.x, tmpPos.y, T.color, 8, 50, S.telegraph * 1000);
      PP.audio.beep(T.teleBeep, 0.3, "sawtooth", 0.08);
    }
  }
  function updateSkullBalls(dt) {
    // チュートリアル中は「障害物」ステップの実演のとき以外、骸骨は沈黙する
    // (クールダウンも凍結。練習中に妖弾が飛んできては説明が読めない)
    if (PP.tut && PP.tut.suppressSkulls()) { stepAttacking = 0; return; }
    // 骸骨玉が1体もいなければ何もすることがない。eachLaneBall の2周
    // (150玉×2=毎フレーム300回のコールバック呼び出し)を素の二重ループ
    // 1周の走査だけで打ち切る。骸骨がいるときだけ従来の処理に入る
    var lanes = PP.game.lanes, any = false;
    for (var li = 0; li < lanes.length && !any; li++) {
      var balls = lanes[li].balls;
      for (var bi = 0; bi < balls.length; bi++) {
        if (balls[bi].skull) { any = true; break; }
      }
    }
    if (!any) { stepAttacking = 0; return; }
    // 危機(赤い帳)の最中は全骸骨が沈黙する: チェーンが樽に迫っている間は
    // 「列との勝負」に集中させ、弾幕とのリスク二重取りを起こさない(樽際の
    // 発射禁止帯と同じ思想の全体版)。クールダウンも凍結するので、危機が
    // 明けた瞬間に溜まった骸骨が一斉発射することもない
    stepCrisis = !!(PP.crisis && PP.crisis.level && PP.crisis.level() > 0.05);
    stepDt = dt;
    // 同時攻撃の全体制限のため、予兆〜発射中の個体数を先に数える
    // (骸骨は最大5体=毎フレームの走査コストは無視できる)
    stepAttacking = 0;
    PP.game.eachLaneBall(countAttacking);
    PP.game.eachLaneBall(stepSkullBall);
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
      // 【強化】パリィの弾き返し弾: 撃った本人(髑髏玉)へ追尾して戻る味方の弾。
      // 以降の敵弾ロジック(迎撃・大砲命中)には乗らない
      if (b.reflected) {
        var srcIdx = b.srcBall ? b.srcLane.balls.indexOf(b.srcBall) : -1;
        if (srcIdx < 0) {
          // 目標が先に消えていた: その場で霧散(空振り。直進を続けるより状態が単純)
          PP.fx.burst(b.x, b.y, "#8ef0d0", 6, 1.0);
          removeBullet(i);
          continue;
        }
        b.srcLane.rail.posAtInto(b.srcBall.d + (b.srcBall.slide || 0), tmpPos);
        var rdx = tmpPos.x - b.x, rdy = tmpPos.y - b.y;
        var rd = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
        if (rd < b.r + PP.R) {
          // 命中: destroyRange 経路なので撃破報酬(+400・ドロップ)も自動で付く
          PP.fx.flash(tmpPos.x, tmpPos.y, "rgba(255,255,255,0.85)", 40);
          PP.chain.destroySingle(b.srcLane, srcIdx);
          removeBullet(i);
          continue;
        }
        b.vx = rdx / rd * PP.PARRY.reflectSpeed;
        b.vy = rdy / rd * PP.PARRY.reflectSpeed;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.view.x = b.x; b.view.y = b.y;
        b.view.scaleX = b.view.scaleY = BULLET_BASE * (1 + 0.14 * Math.sin(b.t * 10));
        b.view.rotation = b.t * 160;
        // トレイルは味方色(敵弾との見分け)
        if (Math.random() < dt * 26) PP.fx.burst(b.x, b.y, "#8ef0d0", 1, 0.5);
        continue;
      }
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
          PP.fx.floatText(PP.i18n.t("fx.intercept"), b.x, b.y - 26, "#8ef0d0", 18);
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

      // 大砲への命中。無敵中(playerHitCd)は素通りさせず、バリアで
      // 「弾いて」消す(多段ヒット防止+無敵が目に見える。boss.js と同じ作法)
      if (Math.abs(b.x - cx) <= O.catchW &&
          b.y >= cy - O.catchTop && b.y <= cy + O.catchBottom) {
        if (playerHitCd <= 0) {
          // 【強化】パリィ: 構え(Shift/🛡)の受付窓が開いていればガード(Lv1)/
          // 弾き返し(Lv2+)。発射元の髑髏玉が既に消えていたらガードへ降格
          var pr = PP.upgrades ? PP.upgrades.tryParry() : 0;
          if (pr === 2 && b.srcBall && b.srcLane.balls.indexOf(b.srcBall) >= 0) {
            startReflect(b);
            continue;            // 弾は消さず、次フレームから追尾弾として飛ぶ
          }
          if (pr > 0) {
            playerHitCd = PP.PARRY.guardIFrames;   // 扇の続きは既存のバリア演出が弾く
            fxParry(b, "parry.guard");
          } else {
            applyHit(b.type);
          }
        } else {
          PP.fx.burst(b.x, b.y, "#9fd8ff", 4, 0.9);
          if (parryBeepCd <= 0) {
            PP.audio.beep(980, 0.05, "triangle", 0.05);
            parryBeepCd = 0.12;
          }
        }
        removeBullet(i);
        continue;
      }

      // 画面外(重力持ちの上昇中ロブは頂点で戻ってくるので上端では消さない。
      // grav:0 の無重力弾(連環の錨輪の上向き成分)は戻ってこないので消してよい)
      if (b.y > PP.H + 40 || (b.y < -60 && !(b.grav > 0 && b.vy < 0)) ||
          b.x < -60 || b.x > PP.W + 60) removeBullet(i);
    }
  }

  // ---------- 墨だまり(パワーダウン🦑を取ってしまったときの目つぶし) ----------
  // boss.js splatInk と同じ方式: 巨大な放射グラデを毎回描かず、単位サイズ
  // (半径256)で一度だけ焼いた canvas を全ブロブで共有し、scale で伸縮する
  // (放射グラデは線形スケールで見た目が一致する)。効果時間は取った
  // アイテムの dur に合わせる
  var INK_UR = 256, inkCanvas = null;
  function bakeInk() {
    var sh = new createjs.Shape();
    // ボスの墨(ほぼ真っ黒)より薄めにする: 「見づらいが、うっすら透けて見える」
    // 程度に留めて、理不尽さより駆け引き(避けそこねのペナルティ)に寄せる
    sh.graphics.beginRadialGradientFill(
      ["rgba(10,8,14,0.72)", "rgba(10,8,14,0.66)", "rgba(10,8,14,0.5)", "rgba(10,8,14,0)"],
      [0, 0.55, 0.82, 1],
      0, 0, 0, 0, 0, INK_UR).drawCircle(0, 0, INK_UR);
    sh.cache(-INK_UR, -INK_UR, INK_UR * 2, INK_UR * 2);
    return sh.cacheCanvas;
  }
  function splatInk(count, dur) {
    ensureCont();
    if (!cont) return;
    var B = PP.BOSS.ink;   // 墨の半径レンジはボスの定義を借りる
    if (!inkCanvas) inkCanvas = bakeInk();
    for (var i = 0; i < count; i++) {
      // WebGL 時はボスの墨と同じ同時数上限(config の glMax、古い墨から晴らす)
      if (PP.glActive && B.glMax > 0) {
        while (inkBlobs.length >= B.glMax) {
          var old = inkBlobs.shift();
          createjs.Tween.removeTweens(old.sh);
          if (old.sh.parent) old.sh.parent.removeChild(old.sh);
        }
      }
      var r = (B.rMin + Math.random() * (B.rMax - B.rMin)) * 1.25;
      var bx = 120 + Math.random() * (PP.W - 240);
      var by = 140 + Math.random() * (PP.H - 260);
      var sh = new createjs.Bitmap(inkCanvas);
      sh.regX = sh.regY = INK_UR;
      sh.scaleX = sh.scaleY = r / INK_UR;
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
    if (parryBeepCd > 0) parryBeepCd -= dt;
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
    parryBeepCd = 0;
    lastTeleAt = -Infinity;   // 予兆間隔の共有記憶も仕切り直す
    PP.cannon.clearHurt();   // リトライ・レベル切替で点滅を残留させない
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
    bulletCount: function () { return bullets.length; },   // チュートリアルが実演の弾幕の終わりを見張る
    splatInk: splatInk,
    debugForceFire: debugForceFire
  };
})();
