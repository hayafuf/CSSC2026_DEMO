/* boss-projectiles.js — 妖弾の生成・移動・反射・命中・破棄。
 * battleはboss.jsが所有する状態。撃破などの制御処理はhooksで受け取る。 */
(function () {
  "use strict";
  var PP = window.PP;
  PP.createBossProjectiles = function (battle, hooks) {
    var ATTACKS = hooks.attacks, NO_PARRY = hooks.noParry;
    var Kb2Scale = hooks.Kb2Scale;
    var splatInk = hooks.splatInk;
    var spdMul = hooks.spdMul;
    var onHit = hooks.onHit;
    var hitTest = hooks.hitTest;
    var orbCanvas = {};
    function makeOrbView(type) {
      var c = orbCanvas[type];
      if (!c) {
        var sh = new createjs.Shape();
        var pad;
        if (type === "ink") {
          sh.graphics
            .beginRadialGradientFill(["#3a2a48", "#16101e", "rgba(10,8,14,0.4)"], [0, 0.7, 1],
              -4, -4, 2, 0, 0, 20)
            .drawCircle(0, 0, 18)
            .beginFill("rgba(210,160,235,0.25)").drawCircle(-6, -7, 5);
          pad = 24;
        } else {
          var col = ATTACKS[type].color;
          var r = (type === "shotSlow") ? PP.BOSS.shotSlow.r : PP.BOSS.orb.r;
          sh.graphics
            .beginRadialGradientFill(["#ffffff", col, "rgba(0,0,0,0)"], [0, 0.45, 1],
              0, 0, 0, 0, 0, r * 1.7)
            .drawCircle(0, 0, r * 1.7)
            .setStrokeStyle(2).beginStroke(col).drawCircle(0, 0, r);
          pad = r * 1.7 + 3;
        }
        var S = 1.25;
        sh.cache(-pad, -pad, pad * 2, pad * 2, S);
        c = orbCanvas[type] = { img: sh.cacheCanvas, reg: pad * S, base: 1 / S };
      }
      var bmp = new createjs.Bitmap(c.img);
      bmp.regX = bmp.regY = c.reg;
      bmp.scaleX = bmp.scaleY = c.base;
      bmp.baseScale = c.base;
      return bmp;
    }

    // 妖弾 view のプール(ball.js の acquireView/releaseView と同型)。
    // 三段分裂は一瞬で数十発を生む=Bitmap の生成/破棄が GC スパイクになるため、
    // 使い終わった Bitmap を type 別に取り置いて使い回す。
    // 注意: viewScale(spawnBullet)が baseScale を破壊的に乗算するので、
    // 再利用時は必ず焼き込み時の素の倍率(orbCanvas[type].base)へ戻す
    var orbFree = {};             // type → Bitmap[]
    var ORB_POOL_MAX = 48;        // type 別の取り置き上限(小弾ラッシュのピーク分)
    function acquireOrbView(type) {
      var pool = orbFree[type];
      var bmp = pool && pool.pop();
      if (!bmp) return makeOrbView(type);
      bmp.baseScale = orbCanvas[type].base;
      bmp.scaleX = bmp.scaleY = bmp.baseScale;
      bmp.alpha = 1; bmp.visible = true; bmp.rotation = 0;
      return bmp;
    }
    function releaseOrbView(type, bmp) {
      if (bmp.parent) bmp.parent.removeChild(bmp);
      var pool = orbFree[type] || (orbFree[type] = []);
      if (pool.length < ORB_POOL_MAX) pool.push(bmp);
    }

    // opts(省略可)で弾に「軌道の芸」を持たせる:
    //   wave:  { amp, freq, ph } … 左右に蛇行しながら進む(snake 弾)
    //   spin:  rad/s … 速度ベクトルを毎フレーム回す=弧を描いて曲がる(渦巻き弾)
    //   hover: { y, time, rings: [{ count, speed, spin }, …] }
    //          … 指定の高さまで降りたら停止してホバリングし、time 秒後に
    //            全方位リングを段階的に展開(rings を順に 0.45 秒間隔で放つ)、
    //            最後のリングと同時に自分は弾ける(ホバリング爆裂弾)
    //   hover.burst: { mids, midR, midHp, midVr, midSpin, splitBase, splitStep,
    //                  smalls, smallSpeed, smallR }
    //          … rings の代わりに「二段分裂」: 中玉がらせん状に拡散し、
    //            各中玉が時間差で小弾リングへさらに割れる
    //   split: { t, count, speed, r, idx } … t 秒後に小弾リングへ割れる時限分裂
    //   viewScale: 見た目の倍率(判定半径と見た目を揃える)
    function spawnBullet(type, x, y, vx, vy, grav, r, opts) {
      // 同時数の上限。分裂の連鎖で弾数が伸びると迎撃判定 O(弾×自弾) と描画の
      // 両方が膨らむため、超過スポーンは静かに捨てる(分裂の末端=小弾から
      // 削られるので、被弾判定の主役である初段・二段には影響しない)
      var cap = (PP.quality === 0 && PP.PERF.LOW.bulletMax) || PP.BOSS.bulletMax;
      if (battle.bullets.length >= cap) return;
      var view = acquireOrbView(type);
      view.x = x; view.y = y;
      battle.bulletCont.addChild(view);
      var hitR = r + PP.R * 0.9;   // 自弾との迎撃半径(毎フレーム再計算しない)
      var b = { type: type, x: x, y: y, vx: vx, vy: vy, grav: grav || 0,
                r: r, hitR2: hitR * hitR, view: view, t: Math.random() * 6.28 };
      if (opts) {
        if (opts.wave) b.wave = { amp: opts.wave.amp, freq: opts.wave.freq, ph: opts.wave.ph || 0 };
        if (opts.spin) {
          // 回転弾は極座標で動かす: 発射点を中心に、半径は radial 速度で単調増加、
          // 角度は spin で回る。「回転しながら必ず外へ広がる」ことを保証する
          // (速度ベクトルを回す方式だと一周して内側へ戻ってきてしまう)
          b.orbit = { cx: x, cy: y, r: 0, ang: Math.atan2(vy, vx),
                      vr: Math.sqrt(vx * vx + vy * vy), w: opts.spin };
        }
        if (opts.hover) b.hover = { y: opts.hover.y, t: opts.hover.time,
                                    rings: opts.hover.rings ? opts.hover.rings.slice() : null,
                                    burst: opts.hover.burst || null, done: false };
        if (opts.hp) b.hitsLeft = opts.hp;   // 迎撃に複数発が必要な大玉(耐久値)
        if (opts.meteor) b.meteor = true;    // 隕石: 炎トレイル+地面着弾で爆発
        if (opts.inkGen) b.inkGen = opts.inkGen;   // 墨の飛沫(世代): 着弾しても再分裂しない
        if (opts.curtain) b.curtain = true;  // 時凪のカーテン弾(一斉落下の対象)
        // 急加速(ダッシュ弾): y がしきい値を越えた瞬間、速度が mul 倍に跳ね上がる
        if (opts.dash) b.dash = { y: opts.dash.y, mul: opts.dash.mul, done: false };
        // 時限分裂(多段分裂の中玉): t 秒後に count 発の同心円リングへ割れる。
        // hp=子の耐久 / spin=子のらせん回転(中玉の証) / child=子がさらに
        // 割れるときの分裂スペック(入れ子)。
        // t はここでコピーするので、config の共有オブジェクトを直接渡してよい
        if (opts.split) b.split = { t: opts.split.t, count: opts.split.count,
                                    speed: opts.split.speed, r: opts.split.r,
                                    hp: opts.split.hp || 0,
                                    spin: opts.split.spin || 0,
                                    idx: opts.split.idx || 0,
                                    child: opts.split.child || null };
        // 見た目の拡縮(焼き込みスプライトはタイプごと固定サイズなので、
        // 中玉>通常>小弾 の大きさの違いはここで付ける)
        if (opts.viewScale) {
          view.baseScale *= opts.viewScale;
          view.scaleX = view.scaleY = view.baseScale;
        }
      }
      battle.bullets.push(b);
    }

    function clearBullets() {
      for (var i = 0; i < battle.bullets.length; i++) {
        releaseOrbView(battle.bullets[i].type, battle.bullets[i].view);
      }
      battle.bullets.length = 0;
    }

    // 妖弾の進行: 移動 → 自弾との迎撃 → 大砲への命中 → 着弾/画面外の後始末
    function updateBullets(dt) {
      if (battle.bullets.length === 0) return;
      var g = PP.game;
      var O = PP.BOSS.orb;
      var cx = PP.cannon.x, cy = PP.cannon.y;
      // トレイル粒子の予算: 弾数に比例して粒子が増えると FPS が崩壊するので、
      // 全弾合計で 1 フレーム 8 個まで(60fps で約480個/秒=従来の見え方と同等)。
      // さらにプールが混んでいる時は発生自体を止める
      // 墨で画面が覆われている間はトレイルがほぼ見えないので予算を絞る
      var trailBudget = (PP.fx.particleLoad() < 0.75) ? (battle.inkBlobs.length > 0 ? 5 : 8) : 0;
      // 一斉分裂(split)のフレーム内演出予算: 音は1回、リング演出は3個まで
      var splitFxBudget = 3, splitBeeped = false;
      for (var i = battle.bullets.length - 1; i >= 0; i--) {
        var b = battle.bullets[i];
        // 【強化】パリィの弾き返し弾: ボスの頭部へ追尾して戻る味方の弾。
        // 以降の敵弾ロジック(分裂・迎撃・大砲命中・着弾)には一切乗らない
        if (b.reflected) {
          b.t += dt;
          if (battle.state === "dying" || battle.state === "dead") {
            removeBullet(i);   // 撃破後は目標を失うので霧散(clearBullets の保険)
            continue;
          }
          var rtx = battle.body.x, rty = battle.body.y - 20;   // hitTest の楕円中心と同じ
          var rdx = rtx - b.x, rdy = rty - b.y;
          var rd = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
          b.vx = rdx / rd * PP.PARRY.reflectSpeed;
          b.vy = rdy / rd * PP.PARRY.reflectSpeed;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.view.x = b.x; b.view.y = b.y;
          // トレイルは味方色(敵弾との見分け)
          if (trailBudget > 0 && Math.random() < dt * 26) {
            trailBudget--;
            PP.fx.burst(b.x, b.y, "#8ef0d0", 1, 0.5);
          }
          if (hitTest(b.x, b.y)) {
            // シールド/無敵で通らなくても弾は消す(貼り付き連打の防止)。
            // 予兆中に届けば onHit 側の攻撃キャンセルが自然に発生する
            removeBullet(i);
            onHit(1, b.x, b.y);
            // 撃破は残りの弾も破棄する。古い添字でループを続けない。
            if (battle.state === "dying" || battle.state === "dead") return;
          }
          continue;
        }
        // ホバリング爆裂弾: 指定の高さで静止 → 溜め → 全方位リングを段階展開。
        // リングごとに半歩ずらして放つので、二段目は一段目の隙間を通ってくる
        if (b.hover && !b.hover.done && b.y >= b.hover.y) {
          b.vx = 0; b.vy = 0;
          b.hover.t -= dt;
          if (trailBudget > 0 && Math.random() < dt * 30) {
            trailBudget--;
            PP.fx.burst(b.x + (Math.random() - 0.5) * 30, b.y + (Math.random() - 0.5) * 30,
                        ATTACKS[b.type].color, 1, 0.6);
          }
          if (b.hover.t <= 0 && b.hover.burst) {
            // 多段分裂の一段目: 大玉が中央から割れ、中玉のリングが直線で放射状に
            // 広がる(midSpin>0 ならせん回転にもできる)。各中玉は
            // burst.split のスペックどおりに一斉に割れる(怒り時は孫の中玉を挟む三段)
            var BB = b.hover.burst;
            var baseAng = Math.random() * Math.PI * 2;
            for (var mi = 0; mi < BB.mids; mi++) {
              var mang = baseAng + (Math.PI * 2 / BB.mids) * mi;
              spawnBullet(b.type, b.x, b.y,
                Math.cos(mang) * BB.midVr, Math.sin(mang) * BB.midVr, 0, BB.midR,
                { spin: BB.midSpin,
                  hp: BB.midHp,
                  viewScale: BB.midR / PP.BOSS.orb.r,
                  split: BB.splitStep
                    ? { t: BB.split.t + mi * BB.splitStep, count: BB.split.count,
                        speed: BB.split.speed, r: BB.split.r, hp: BB.split.hp,
                        spin: BB.split.spin, idx: mi, child: BB.split.child }
                    : BB.split });
            }
            PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 14, 120, 460);
            PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 16, 1.8);
            PP.fx.screenFlash(ATTACKS[b.type].color, 0.12, 220);   // 炸裂の閃光
            PP.fx.shake(9, 0.3);                                    // 盤面中央の爆発は体で感じる
            PP.audio.gliss(700, 180, 0.3, "square", 0.12);   // パキッと割れる音
            PP.audio.beep(60, 0.4, "sawtooth", 0.16);        // 腹に来る炸裂の低音
            PP.audio.bossAddle();
            b.hover.done = true;
            removeBullet(i);
            continue;
          }
          if (b.hover.t <= 0) {
            var bc = b.hover.rings.shift();
            var half = (b.hover.rings.length % 2) * (Math.PI / bc.count);   // 段ごとに半歩ずらす
            for (var bk = 0; bk < bc.count; bk++) {
              var bang = (Math.PI * 2 / bc.count) * bk + half;
              spawnBullet(b.type, b.x, b.y,
                Math.cos(bang) * bc.speed, Math.sin(bang) * bc.speed, 0, PP.BOSS.orb.r * 0.72,
                bc.spin ? { spin: bc.spin } : null);
            }
            PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 12, 110, 450);
            PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 14, 1.6);
            PP.audio.beep(340, 0.12, "square", 0.1);
            // 同心円リング展開の専用SE(約3秒)。0.45秒間隔の多段リングで
            // 重なりすぎないよう、最初の展開の1回だけ鳴らす
            if (!b.hover.seDone) { b.hover.seDone = true; PP.audio.bossAddle(); }
            if (b.hover.rings.length > 0) {
              b.hover.t = 0.45;          // 次のリングまでの溜め
            } else {
              b.hover.done = true;
              removeBullet(i);
              continue;
            }
          }
        }
        b.lastY = b.y;   // 移動前の高さ(cross の「線を横切った瞬間」判定に使う)
        // 渦巻き弾: 極座標スパイラル。半径は増える一方なので必ず外へ広がる
        if (b.orbit) {
          b.orbit.r += b.orbit.vr * dt;
          b.orbit.ang += b.orbit.w * dt;
          b.x = b.orbit.cx + Math.cos(b.orbit.ang) * b.orbit.r;
          b.y = b.orbit.cy + Math.sin(b.orbit.ang) * b.orbit.r;
        } else {
          b.vy += b.grav * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          // 蛇行弾: 進行に左右の揺れを重ねる(網のような弾幕を作る)
          if (b.wave) b.x += Math.sin(b.t * b.wave.freq + b.wave.ph) * b.wave.amp * dt;
        }
        // 多段分裂の後段: 中玉が時限で同心円リングへ割れる。子が hp/child を
        // 持てば、その子も撃ち落とせる中玉で、さらにもう一段割れる(怒りの三段)。
        // リングの位相は進行方向を引き継ぐ=中玉ごとに隙間の向きが変わって見える。
        // 全中玉が同一フレームで一斉に割れるので、音は1回・リング演出は数個に
        // 絞る(10個ぶん重ねると音割れ+粒子まみれになる)
        if (b.split) {
          b.split.t -= dt;
          if (b.split.t <= 0) {
            var ph0 = b.orbit ? b.orbit.ang : Math.atan2(b.vy, b.vx);
            for (var sk = 0; sk < b.split.count; sk++) {
              var sang = ph0 + (Math.PI * 2 / b.split.count) * sk;
              spawnBullet(b.type, b.x, b.y,
                Math.cos(sang) * b.split.speed, Math.sin(sang) * b.split.speed, 0, b.split.r,
                { viewScale: b.split.r / PP.BOSS.orb.r,
                  hp: b.split.hp || undefined,
                  spin: b.split.spin || undefined,   // 中玉の子は回転、小弾は直線
                  split: b.split.child || undefined });
            }
            if (splitFxBudget > 0) {
              splitFxBudget--;
              PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 8, 70, 380);
              PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 8, 1.2);
            }
            if (!splitBeeped) {
              splitBeeped = true;
              // 時間差ポップ: 順番に音程が上がる(idx)。同一フレームで複数割れても1回だけ
              PP.audio.beep(380 + b.split.idx * 25, 0.12, "square", 0.1);
              PP.audio.beep(190 + b.split.idx * 12, 0.18, "sawtooth", 0.07);  // 下支えの低音
            }
            removeBullet(i);
            continue;
          }
        }
        // 急加速(ダッシュ弾): しきい値を越えた瞬間に1回だけ速度を跳ね上げる。
        // 白閃+風切り音で「今、加速した」ことをはっきり見せる(同フレームで
        // カーテン1段ぶんが一斉に加速するので、音は1回・閃光は数発に絞る)
        if (b.dash && !b.dash.done && b.y >= b.dash.y) {
          b.dash.done = true;
          b.vx *= b.dash.mul;
          b.vy *= b.dash.mul;
          if (splitFxBudget > 0) {
            splitFxBudget--;
            PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 30);
          }
          if (!splitBeeped) {
            splitBeeped = true;
            PP.audio.gliss(300, 900, 0.18, "square", 0.09);   // ヒュンッという風切り
          }
        }
        b.t += dt;
        b.view.x = b.x; b.view.y = b.y;
        var pulse = 1 + 0.12 * Math.sin(b.t * 10);
        b.view.scaleX = b.view.scaleY = pulse * b.view.baseScale;
        // 尾を引く残光(妖弾の軌道が線で読める=避けやすく、画面も華やぐ)。
        // 隕石は炎の尾を濃く引く(橙と黄をちらつかせる)
        if (b.meteor) {
          if (trailBudget > 0 && Math.random() < dt * 40) {
            trailBudget--;
            PP.fx.burst(b.x - b.vx * 0.02, b.y - b.vy * 0.02,
                        Math.random() < 0.5 ? "#ffa040" : "#ffd24a", 2, 1.1);
          }
        } else if (trailBudget > 0 && Math.random() < dt * 26) {
          trailBudget--;
          PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 1, 0.5);
        }

        // 迎撃: 自分の弾(通常弾・爆弾)をぶつけると相殺して消せる。
        // ミサイルは貫通なので消費せずに薙ぎ払える。
        // 耐久値(hitsLeft)を持つ大玉は削り切るまで消えない(残り数を表示)
        var blocked = false;
        if (b.hitCd > 0) b.hitCd -= dt;
        // 弾幕中は弾×ショットの総当たりになるので、縦距離だけで先に棄却する
        // (cannon.js stepShots の SKIP_R2 と同じパターン。ほとんどのペアは
        //  dy チェックだけで抜け、平方距離の計算までたどり着かない)
        for (var s = g.shots.length - 1; s >= 0; s--) {
          var sh = g.shots[s];
          var dy = sh.y - b.y;
          if (dy * dy >= b.hitR2) continue;
          var dx = sh.x - b.x;
          if (dx * dx + dy * dy < b.hitR2) {
            if (b.hitsLeft > 1) {
              // まだ耐える: 1発ぶん削って怯ませる(ミサイルは多段ヒット防止の間を置く)
              if (!(b.hitCd > 0)) {
                b.hitCd = 0.12;
                b.hitsLeft--;
                PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 6, 0.9);
                PP.fx.floatText(PP.i18n.t("boss.hitsLeft", { n: b.hitsLeft }), b.x, b.y - 30, "#a0dcff", 16);
                PP.audio.beep(500, 0.06, "square", 0.07);
              }
              if (sh.special !== "missile") {   // 通常弾は1発と交換
                if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
                PP.layers.shot.removeChild(sh.view);
                g.shots.splice(s, 1);
              }
              continue;                          // 大玉は消えない
            }
            PP.fx.burst(b.x, b.y, ATTACKS[b.type].color, 10, 1.2);
            PP.fx.flash(b.x, b.y, "rgba(255,255,255,0.8)", 34);
            PP.fx.floatText(PP.i18n.t("fx.intercept"), b.x, b.y - 26, "#8ef0d0", 18);
            PP.audio.beep(720, 0.1, "square", 0.08);
            if (sh.special !== "missile") {   // 通常弾は1発と交換
              if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
              PP.layers.shot.removeChild(sh.view);
              g.shots.splice(s, 1);
            }
            blocked = true;
            break;
          }
        }
        if (blocked) { removeBullet(i); continue; }

        // 大砲への命中(powerups のキャッチ箱と同じ寸法感)。
        // cross 弾は被弾直後(crossHitCd)の間だけ当たらない: 密度線なので
        // スタン中に毎フレーム多段ヒットして抜けられなくなるのを防ぐ。
        // また cross の小ドットは「見た目どおりの細さ」で判定する: 通常オーブ用の
        // 広いキャッチ箱(±50)だと、見た目は避けているのに当たる=2本の線の
        // 間の空間が実際より 60px 以上狭くなってしまう
        // orbHitCd(被弾後の無敵)の間は素通りさせず、バリアで「弾いて」消す
        // (激しい弾幕での連続被弾=ハメを防ぎつつ、無敵が目に見える。
        //  骸骨玉の hitIFrames と同じ思想)。
        // cross の判定は縦60pxの箱ではなく「大砲の高さの線を横切った瞬間」の
        // 1回だけ: 箱判定だと、掃引が左右端で線が斜めになったとき箱の縦幅の
        // 中で線が横に~90px も動き、線が実際より太く判定されて通路が狭くなる
        // (=中央で広く端で狭い、が起きる)。線交差なら通路幅は常に 2×gap で一定
        var hitNow;
        if (b.type === "cross") {
          var crossLine = cy - 20;
          hitNow = b.lastY < crossLine && b.y >= crossLine &&
                   Math.abs(b.x - cx) <= b.r + 16;
        } else {
          hitNow = Math.abs(b.x - cx) <= O.catchW &&
                   b.y >= cy - O.catchTop && b.y <= cy + O.catchBottom;
        }
        if (hitNow) {
          // パリィの無敵(parryCd)は cross には効かせない: パリィ不可の技が
          // 「パリィ直後だけ抜けられる」と例外の意味が壊れるため
          var invuln = battle.orbHitCd > 0 || (b.type === "cross" ? battle.crossHitCd > 0 : battle.parryCd > 0);
          if (!invuln) {
            // 【強化】パリィ: 大技(NO_PARRY)以外の妖弾は、構え(Shift/🛡)の
            // 受付窓が開いていればガード(Lv1)/弾き返し(Lv2+)
            var pr = (NO_PARRY[b.type] || !PP.upgrades) ? 0 : PP.upgrades.tryParry();
            if (pr === 2) {
              startReflect(b);
              continue;            // 弾は消さず、次フレームからボスへ戻る追尾弾
            }
            if (pr === 1) {
              battle.parryCd = PP.PARRY.guardIFrames;
              fxParry(b, "parry.guard");
            } else {
              applyOrbHit(b);
            }
          } else if (b.type === "ink" && b.inkGen) {
            // 無敵中でも墨の飛沫はバリアの上で「ベチャッ」と潰れて視界を汚す:
            // 初段の直撃で入る 2 秒の無敵の間に飛沫が降ってくるので、ここを
            // 火花だけにすると飛沫が音しか残さない。仰け反り・無敵の更新は
            // しない(多段ハメ防止はそのまま)が、足元に墨だまり+視界不良を
            // addDur 秒だけ延長する(上限は dur)
            var Kb0 = PP.BOSS.ink.bounce;
            splatInk(b.x, b.y, false, Kb0.puddleMul);
            g.bossFx.ink = Math.max(g.bossFx.ink, Math.min(PP.BOSS.ink.dur, g.bossFx.ink + Kb0.addDur));
          } else {
            // 無敵中: 弾はバリアに弾かれて消える(小さな火花+軽い音)。
            // cross は密度線なので音だけ parryBeepCd で間引く(火花は残す)
            PP.fx.burst(b.x, b.y, "#9fd8ff", 4, 0.9);
            if (battle.parryBeepCd <= 0) {
              PP.audio.beep(980, 0.05, "triangle", 0.05);
              battle.parryBeepCd = 0.12;
            }
          }
          removeBullet(i);
          continue;
        }

        // 墨玉は大砲の高さまで落ちたら着弾(外れても足元に墨だまりが残る)。
        // 初段の墨玉は着弾で割れ、飛沫(小さな墨玉)が左右へ跳ね上がってもう一度
        // 降ってくる(分裂バウンド)。怒り時は飛沫の着弾でさらにもう一段割れる
        // (二段分裂)。世代は inkGen で数え、splits 世代まで割れたら墨だまりで終わり。
        // 飛沫も普通の ink 弾なので迎撃・パリィ・被弾判定は初段と同じ経路を通る
        // (被弾時の重さだけ applyOrbHit で軽くしている)
        if (b.type === "ink" && b.y >= cy - 30) {
          var ly = cy - 30;
          var Kb = PP.BOSS.ink.bounce;
          var gen = b.inkGen || 0;
          var maxS = battle.phase2 ? Kb.splitsP2 : Kb.splits;   // 何段割れるか(通常 1 / 怒り 2)
          if (gen < maxS) {
            // 着弾で割れて飛沫が左右へ跳ね上がる。初段は count(怒り countP2)発、
            // 二段目以降は count2 発で、勢いと粒は世代ごとに genMul 倍に落とす
            var nb = gen === 0 ? (battle.phase2 ? Kb.countP2 : Kb.count) : Kb.count2;
            var gm = Math.pow(Kb.genMul, gen);
            var rr = gen === 0 ? Kb.r : Kb.r2;
            if (gen === 0) splatInk(b.x, ly, false);     // 初段の着弾だけ墨だまり(枚数抑制)
            for (var q = 0; q < nb; q++) {
              // 左右交互に散らし、外側の飛沫ほど遠くへ跳ねる(扇形に割れる)。
              // 二段目も着地点から左右対称に割れる(親の進行方向へは流さない)
              var bdir = (q & 1) ? -1 : 1;
              var bspread = 0.8 + (q >> 1) * 0.6;
              var bvx = bdir * (Kb.vx[0] + Math.random() * (Kb.vx[1] - Kb.vx[0])) * bspread * gm;
              var bvy = (Kb.vy[0] + Math.random() * (Kb.vy[1] - Kb.vy[0])) * gm;
              spawnBullet("ink", b.x, ly - 4, bvx * spdMul(), bvy, PP.BOSS.ink.grav, rr,
                          { viewScale: rr / 18, inkGen: gen + 1 });
            }
            PP.fx.ring(b.x, ly, "#8a97a8", 6, gen === 0 ? 60 : 44, 300);
            PP.fx.burst(b.x, ly - 10, "rgba(20,14,26,0.9)", gen === 0 ? 8 : 4, 1.6);
            PP.audio.beep(70 + gen * 30, 0.2, "sawtooth", gen === 0 ? 0.1 : 0.07);   // 割れる低い「ボッ」
          } else {
            // 最後の着弾: 小さな墨だまりで終わり(潰れる輪+黒い飛び散りで着弾を見せる)
            splatInk(b.x, ly, false, Kb2Scale());
            PP.fx.ring(b.x, ly, "rgba(40,30,50,0.8)", 4, 48, 260);
          }
          removeBullet(i);
          continue;
        }
        // 隕石は地面(大砲の高さ)で爆発する(大砲キャッチ判定が先に走るので
        // 直撃はちゃんと被弾になる)。隕石なので着弾は地面をガッツリ揺らす
        if (b.meteor && b.y >= cy - 20) {
          PP.fx.ring(b.x, cy - 20, "#ffa040", 20, 150, 460);
          PP.fx.ring(b.x, cy - 20, "#ff5030", 8, 90, 380);
          PP.fx.burst(b.x, cy - 20, "#ffd24a", 16, 2.2);
          PP.fx.shake(PP.BOSS.barrage.impactShake, 0.28);
          PP.audio.meteorBoom();
          removeBullet(i);
          continue;
        }
        // 画面外(ホバリング爆裂の上向き小弾があるので上方向too)
        if (b.y > PP.H + 40 || b.y < -60 || b.x < -60 || b.x > PP.W + 60) removeBullet(i);
      }
    }

    function removeBullet(i) {
      var b = battle.bullets[i];
      releaseOrbView(b.type, b.view);
      battle.bullets.splice(i, 1);
    }

    // ---------- 【強化】パリィ(構えと成否判定は upgrades.js pressParry/tryParry) ----------
    // 成功の合図。汎用の光輪ではなく「真鍮の盾で受けた」絵にする:
    // 砲口の前に真鍮色(HUD の縁と同じ #f0c040)の三日月形の盾の弧が一瞬立って
    // 消え、当たった点から暖色の金属片が散る。音は甲高い金属音。
    // 被弾ではないので shake は使わない
    function fxParry(b, labelKey) {
      var cx = PP.cannon.x, cy = PP.cannon.y - 46;
      var arc = new createjs.Shape();
      arc.graphics.setStrokeStyle(5, "round").beginStroke("#f0c040")
        .arc(0, 0, 44, -Math.PI * 0.85, -Math.PI * 0.15).endStroke();
      arc.graphics.setStrokeStyle(2, "round").beginStroke("#fff3c0")
        .arc(0, 0, 44, -Math.PI * 0.8, -Math.PI * 0.2).endStroke();
      arc.cache(-52, -52, 104, 60);
      arc.x = cx; arc.y = cy;
      arc.scaleX = arc.scaleY = 0.6;
      PP.layers.fx.addChild(arc);
      createjs.Tween.get(arc)
        .to({ scaleX: 1.1, scaleY: 1.1 }, 90, createjs.Ease.quadOut)
        .to({ alpha: 0 }, 180)
        .call(function () { if (arc.parent) arc.parent.removeChild(arc); });
      PP.fx.burst(b.x, b.y, "#ffd27a", 10, 1.4);
      PP.fx.burst(b.x, b.y, "#ffffff", 4, 1.0);
      PP.fx.floatText(PP.i18n.t(labelKey), cx, cy - 34, "#ffdf8a", 18);
      PP.audio.beep(1760, 0.05, "triangle", 0.09);
      PP.audio.beep(2350, 0.12, "sine", 0.05);
    }

    // 弾き返し開始(Lv2+): 妖弾を消さずに「ボスへ戻る味方の追尾弾」に作り替える。
    // 軌道の芸(蛇行・回転・ホバリング・分裂・ダッシュ・カーテン・隕石)は全部
    // 没収して素直な直進追尾に純化する(カーテンの一斉落下や分裂に巻き込ませない)
    function startReflect(b) {
      b.reflected = true;
      b.grav = 0;
      b.wave = null; b.orbit = null; b.hover = null; b.split = null; b.dash = null;
      b.curtain = false; b.meteor = false; b.hitsLeft = 0;
      fxParry(b, "parry.reflect");
      PP.fx.ring(b.x, b.y, ATTACKS[b.type].color, 8, 60, 320);
      PP.audio.gliss(600, 1200, 0.18, "square", 0.09);   // 上昇グリス=「返した」
    }

    // デバフの付与(妖弾の直撃・触手突き上げの双方から呼ぶ)。
    // 通知は HUD の状態異常チップ(updateChips)に一本化し、文字は飛ばさない
    function applyDebuff(type, durMul) {
      var g = PP.game;
      var B = PP.BOSS;
      var mul = durMul || 1;
      PP.audio.debuff();   // 状態異常がかかった合図(妖弾直撃・触手の双方から来る)
      if (type === "addle") {
        g.bossFx.addle = B.addle.dur * mul;
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ff5d8f", 10, 90, 500);
      } else if (type === "freeze") {
        g.bossFx.freeze = B.freeze.dur * mul;
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffd24a", 10, 90, 500);
      } else if (type === "shotSlow") {
        g.bossFx.shotSlow = B.shotSlow.dur * mul;
        PP.fx.screenFlash("rgba(138,32,216,0.22)", 0.22, 600);
      } else if (type === "blackout") {
        // 暗闇: 手札(今の玉・次の玉)が真っ黒になり交換不能(cannon.js)。
        // 手札の描き直しは refreshBalls の一本道を通す
        g.bossFx.blackout = B.thunder.dur * mul;
        PP.cannon.refreshBalls();
        PP.fx.screenFlash("rgba(20,10,40,1)", 0.35, 500);
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#b9a3ff", 10, 90, 500);
      }
    }

    // 妖弾が大砲に当たった: ここで初めて状態異常がかかる
    function applyOrbHit(b) {
      var g = PP.game;
      var B = PP.BOSS;
      // 被弾の共通リアクション: 仰け反りスタン+無敵時間+赤い被弾フラッシュ。
      // 攻撃が激しいぶん、「当たった」ことを体で分からせ、多段ヒットからは守る
      battle.orbHitCd = B.orb.hitIFrames;
      PP.cannon.setHurt(B.orb.hitIFrames);   // 無敵の残り時間だけ大砲が点滅する
      g.bossFx.freeze = Math.max(g.bossFx.freeze, B.orb.hitStagger);
      PP.fx.screenFlash("rgba(200,20,20,0.22)", 0.22, 300);
      PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, "#ff5030", 10, 1.5);
      PP.fx.shake(10, 0.3);
      PP.audio.beep(150, 0.25, "sawtooth", 0.12);
      if (b.type === "ink") {
        if (b.inkGen) {
          // 飛沫の直撃は初段より軽い: 足元+画面内に hitBlobs 枚の墨だまり、
          // 視界不良は dur×durMul 秒(既にかかっていれば長い方)
          splatInk(b.x, b.y, true, Kb2Scale() * 1.3, B.ink.bounce.hitBlobs);
          g.bossFx.ink = Math.max(g.bossFx.ink, B.ink.dur * B.ink.bounce.durMul);
        } else {
          splatInk(b.x, b.y, true);   // 直撃は大きな目つぶし
          g.bossFx.ink = B.ink.dur;
        }
        PP.audio.debuff();            // ink は applyDebuff を通らないのでここで鳴らす
      } else if (b.type === "addle" || b.type === "freeze" || b.type === "shotSlow") {
        applyDebuff(b.type, 1);
      } else if (b.type === "barrage") {
        // 隕石の直撃は「爆風ノックバック+色ルーレット」の二重妨害:
        // 着弾点から遠ざかる向きへ大砲ごと吹き飛ばされ(位置が崩れる)、
        // さらにチェーン全体の色がシャッフルされる(狙いの計画も崩れる)。
        // スタン系の妨害が多すぎたので、時間を奪うのではなく体勢を奪う
        var KN = B.barrage.knock;
        var kdir = (PP.cannon.x >= b.x) ? 1 : -1;
        var toX = Math.max(PP.CANNON_MARGIN + 20,
                  Math.min(PP.W - PP.CANNON_MARGIN - 20, PP.cannon.x + kdir * KN.dist));
        battle.meteorKnock = { t: 0, dur: KN.time, fromX: PP.cannon.x, toX: toX };
        // 色ルーレット(randomize と同じ仕組み): 吹き飛ばされて戻ってきたら盤面の色が違う
        battle.rndSpinT = B.randomize.spin;
        battle.rndStepT = 0;
        battle.rndOrig = g.currentColor;
        g.rouletteSpin = true;
        PP.audio.debuff();
        PP.audio.beep(60, 0.4, "sawtooth", 0.18);
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#ffa040", 16, 130, 480);
        PP.fx.burst(PP.cannon.x, PP.cannon.y - 30, "#ffd24a", 14, 2.0);
        PP.fx.shake(14, 0.3);
      } else if (b.type === "cross") {
        // 両舷斉射の被弾もスタン。hitCd の間は cross 弾に当たらない(スタンロック防止)。
        // シールドはスタン(5秒)より長く張る必要があるため、点滅(見た目)も
        // 共通の hitIFrames(2秒)ではなく hitCd に合わせて延長する
        g.bossFx.freeze = Math.max(g.bossFx.freeze, B.cross.stun);
        battle.crossHitCd = B.cross.hitCd;
        PP.cannon.setHurt(B.cross.hitCd);
        PP.audio.debuff();
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#9fd8ff", 12, 100, 500);
      } else if (b.type === "randomize") {
        battle.rndSpinT = B.randomize.spin;
        battle.rndStepT = 0;
        battle.rndOrig = g.currentColor;
        g.rouletteSpin = true;   // 回転中は磁石を止める(chain.js applyMagnet)
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 10, 70, 400);
      }
    }

    // ---------- 墨だまり(タコスミの着弾跡) ----------
    // direct=true(大砲に直撃)は大量の濃い墨が画面のほぼ全域を覆う本気の目つぶし。
    // 外れた墨玉も着弾点に墨だまりを残す(避けても足元の視界は少し悪くなる)
    // 巨大な放射グラデを毎フレーム再ラスタライズすると重いので、
    // 単位サイズ(半径256)で一度だけ焼いた canvas を全ブロブで共有し、
    // scale=r/256 の Bitmap として置く(放射グラデは線形スケールで見た目が一致)
    // さらに、生きている墨ブロブ(最大10個超の巨大半透明 Bitmap)を毎フレーム
    // 60Hz でステージに直接合成するとフィルレートで FPS が崩壊するので、
    // inkCont ごと画面サイズで cache し、12Hz でだけ再合成する。
    // 毎フレームのコストは「キャッシュ済み1枚の全画面ブリット」だけになる。
    // フェードイン(220ms)・晴れフェード(0.8s)・遅いドリフトは 12Hz でも滑らかに見える

    return {
      makeOrbView: makeOrbView,
      acquireOrbView: acquireOrbView,
      releaseOrbView: releaseOrbView,
      spawnBullet: spawnBullet,
      clearBullets: clearBullets,
      updateBullets: updateBullets,
      removeBullet: removeBullet,
      fxParry: fxParry,
      startReflect: startReflect,
      applyDebuff: applyDebuff,
      applyOrbHit: applyOrbHit
    };
  };
})();
