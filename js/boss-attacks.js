/* boss-attacks.js — 各攻撃の発射パターンと継続発射のタイマー。
 * 予兆・攻撃選択・回復状態はboss.js、弾の移動はboss-projectiles.js。 */
(function () {
  "use strict";
  var PP = window.PP;
  PP.createBossAttacks = function (battle, hooks) {
    var ATTACKS = hooks.attacks;
    var spdMul = hooks.spdMul;
    var spawnBullet = hooks.spawnBullet;
    var spawnStrike = hooks.spawnStrike;
    var tentGapTime = hooks.tentGapTime;
    var startWave = hooks.startWave;
    var clearCrossTele = hooks.clearCrossTele;
    var fillThunderPass = hooks.fillThunderPass;
    function fireAttack(key) {
      var B = PP.BOSS;
      battle.lastAttack = key;
      battle.attackCount++;
      var sx = battle.body.x, sy = battle.body.y + 38;
      var tx = PP.cannon.x, ty = PP.cannon.y - 20;
      // 発射の共通演出: 口元の閃光+攻撃色の全画面フラッシュ+シェイク+重い発砲音
      PP.audio.beep(200, 0.15, "square", 0.12);
      PP.audio.beep(90, 0.35, "sawtooth", 0.12);
      PP.fx.flash(sx, sy, "rgba(120,220,180,0.7)", 40);
      PP.fx.ring(sx, sy, ATTACKS[key].color, 14, 120, 380);
      PP.fx.screenFlash(ATTACKS[key].color, 0.10, 280);
      PP.fx.shake(5, 0.18);   // 攻撃の発射は毎回ドンと響く
      if (key === "ink") {
        // 漆黒の墨獄: 等間隔の弧を描いて降り注ぐ墨玉のカーテン(中央は大砲狙い)
        var K = B.ink;
        var lobs = K.lobs + (battle.phase2 ? 2 : 0);
        for (var i = 0; i < lobs; i++) {
          var lobT = tx + (i - (lobs - 1) / 2) * 190;
          // 放物線: vy0 で軽く浮かせ、grav で落とす。到達時間から vx を逆算
          var fallT = (Math.sqrt(K.vy0 * K.vy0 + 2 * K.grav * (ty - sy)) - K.vy0) / K.grav;
          spawnBullet("ink", sx, sy, (lobT - sx) / fallT * spdMul(), K.vy0, K.grav, 18);
        }
        // 重い墨壺を吐き出す音+体を震わせる反動+口元の黒い飛沫。空が一瞬暗くなる
        PP.audio.gliss(340, 80, 0.6, "sine", 0.13);
        PP.fx.shake(8, 0.25);
        PP.fx.burst(sx, sy, "rgba(20,14,26,0.9)", 10, 1.6);
        PP.fx.screenFlash("rgba(10,8,20,0.18)", 0.18, 400);
      } else if (key === "freeze") {
        // 深淵の錨鎖: ボスを中心に直線で広がる同心二重の錨のリング。
        // 外環(速)と内環(遅・半歩ずれ)が時間差で押し寄せ、全弾が中玉として
        // 多段分裂する(下の burst 構築を参照)
        var F = B.freeze;
        var FB = F.burst;
        PP.audio.rings();   // 同心リング展開の専用SE
        // 錨鎖の展開は鎖が軋む重低音+二重の衝撃波リングで「重さ」を出す
        PP.audio.beep(70, 0.5, "sawtooth", 0.18);
        PP.fx.ring(sx, sy, "#ffd24a", 24, 180, 520);
        PP.fx.ring(sx, sy, "#ffd24a", 10, 110, 420);
        PP.fx.shake(9, 0.25);
        // 全リングの弾が中玉(撃ち落とし可)になり、splitDelay 秒後に一斉に
        // 小弾の同心円リングへ割れる。怒りフェーズは addle と同じ三段
        // (中玉→第二世代の中玉→小弾)なので、初段のリングは細めに絞る
        var fSmall = { t: FB.split2Delay, count: battle.phase2 ? FB.smallsP2 : FB.smalls,
                       speed: FB.smallSpeed * spdMul(), r: FB.smallR };
        var fSplit = battle.phase2
          ? { t: FB.splitDelay, count: FB.mid2Count, speed: FB.mid2Speed * spdMul(),
              r: FB.mid2R, hp: FB.mid2Hp, spin: FB.midSpin, child: fSmall }
          : { t: FB.splitDelay, count: FB.smalls, speed: FB.smallSpeed * spdMul(), r: FB.smallR };
        var ringDefs = battle.phase2
          ? [{ n: 8, v: F.speed }, { n: 6, v: F.speed * 0.7 }]
          : [{ n: 12, v: F.speed }, { n: 8, v: F.speed * 0.68 }];
        var fIdx = 0;   // 全リング通しの番号(時間差ポップと音程上昇に使う)
        for (var rl = 0; rl < ringDefs.length; rl++) {
          var rd = ringDefs[rl];
          var shift = rl * (Math.PI / rd.n);         // 環ごとに半歩ずらす
          for (var f = 0; f < rd.n; f++) {
            var angF = (Math.PI * 2 / rd.n) * f + shift;
            spawnBullet("freeze", sx, sy,
              Math.cos(angF) * rd.v * spdMul(), Math.sin(angF) * rd.v * spdMul(), 0, FB.midR,
              { spin: FB.midSpin, hp: FB.midHp, viewScale: FB.midR / B.orb.r,
                split: FB.splitStep
                  ? { t: fSplit.t + fIdx * FB.splitStep, count: fSplit.count,
                      speed: fSplit.speed, r: fSplit.r, hp: fSplit.hp,
                      spin: fSplit.spin, idx: fIdx, child: fSplit.child }
                  : fSplit });
            fIdx++;
          }
        }
      } else if (key === "addle") {
        // 惑乱の逆潮: 惑わしの大珠が盤面中央まで降りてホバリングし、
        // 「二段分裂」する: 中央から割れて中玉がらせん状に拡散し、
        // 各中玉が時間差でさらに小弾のリングへ割れる。
        // 大玉を削り切る(hp5) / 中玉を撃ち落とす(hp2) / 避けに徹する、の三択
        var AB = B.addle.burst;
        // 中玉の分裂スペック: 通常は「中玉→小弾」の二段。
        // 怒りフェーズは「中玉→第二世代の中玉(回転)→小弾(直線)」の三段(初段の数は絞る)
        var aSmall = { t: AB.split2Delay, count: battle.phase2 ? AB.smallsP2 : AB.smalls,
                       speed: AB.smallSpeed * spdMul(), r: AB.smallR };
        var aSplit = battle.phase2
          ? { t: AB.splitBase, count: AB.mid2Count, speed: AB.mid2Speed * spdMul(),
              r: AB.mid2R, hp: AB.mid2Hp, spin: AB.midSpin, child: aSmall }
          : { t: AB.splitBase, count: AB.smalls, speed: AB.smallSpeed * spdMul(), r: AB.smallR };
        var ddxA = tx - sx, ddyA = ty - sy;
        var dlenA = Math.sqrt(ddxA * ddxA + ddyA * ddyA) || 1;
        spawnBullet("addle", sx, sy,
          ddxA / dlenA * 360 * spdMul(), Math.abs(ddyA) / dlenA * 360 * spdMul(), 0, B.shotSlow.r,
          { hp: 5,   // 大玉は5発当てないと消せない(分裂前に削り切るかの判断)
            hover: { y: 380, time: 0.8,
                     burst: { mids: battle.phase2 ? AB.midsP2 : AB.mids,
                              midR: AB.midR, midHp: AB.midHp,
                              midVr: AB.midVr * spdMul(),
                              splitStep: AB.splitStep, split: aSplit } } });
        // 惑わしの大珠の射出音(不穏な上昇うねり)
        PP.audio.gliss(180, 420, 0.7, "triangle", 0.1);
      } else if (key === "shotSlow") {
        // 時凪の呪縛: 大弾のカーテンを五重(怒り時は六重)、時間差で1枚ずつ落とす。
        // 実際の発生は updateCurtain(奇数枚と偶数枚で隙間が互い違い)
        battle.curtainTotal = battle.phase2 ? 6 : 5;
        battle.curtainLeft = battle.curtainTotal;
        battle.curtainT = 0;                                 // 1枚目はすぐ
        PP.audio.bossBallSlow();   // 時凪の呪縛(大弾カーテン)の専用SE
      } else if (key === "randomize") {
        // 運命のルーレット: 左右から交差する2本の「回転する腕」が
        // 弧を掃くように弾を置いていく(ルーレットの針の回転)
        battle.sweepTotal = 16 + (battle.phase2 ? 6 : 0);
        battle.sweepLeft = battle.sweepTotal;
        battle.sweepT = 0;
        PP.audio.bossSweep();   // 水色の掃射の専用SE
        PP.fx.shake(6, 0.2);
      } else if (key === "tentacle") {
        // ⚠地点へ画面下から触手が突き上げる(範囲内ならランダムなデバフ)。
        // ここは第1波。以降は updateTentacleWaves が「間→⚠→突き上げ」の
        // 追撃波を刻む(波状のドラム。常に⚠2個分しか塞がない=必ず逃げ場がある)
        var KT = B.tentacle;
        battle.tentWaveIdx = 0;
        PP.audio.bossDangerStop();   // 触手が出たら警報(⚠のSE)は断ち切る
        for (var z = 0; z < battle.pendingZones.length; z++) spawnStrike(battle.pendingZones[z], 0);
        battle.pendingZones.length = 0;
        battle.tentWavesLeft = battle.phase2 ? KT.extraWavesP2 : KT.extraWaves;
        battle.tentPhase = "gap";
        battle.tentTimer = tentGapTime(0);
        PP.fx.shake(10, 0.25);
        PP.audio.beep(90, 0.4, "sawtooth", 0.14);
        PP.audio.bossTentacle();   // 触手突き上げの専用SE
      } else if (key === "tsunami") {
        PP.audio.tsunami();   // 水壁が走り出す轟音
        startWave();
      } else if (key === "barrage") {
        // 隕石: ボレー発射は update 側のタイマーで刻む(1発目はすぐ)
        battle.barrageLeft = B.barrage.volleys + (battle.phase2 ? 1 : 0);
        battle.barrageT = 0;
        PP.audio.meteorStart();   // 降り始めの雨音(2 レイヤー同時)
      } else if (key === "cross") {
        // 両舷斉射: 予兆線を消して振り子掃引開始(実際の発射は updateCross が刻む)
        clearCrossTele();
        battle.crossActive = true;
        battle.crossT = 0;
        battle.crossEmitAcc = 0;
        PP.audio.bossWaveAttack();   // 両舷斉射の専用SE(bossSweep はルーレット専用に戻した)
      } else if (key === "thunder") {
        // 裁きの雷霆: 始点側の端から反対側へ等間隔の落雷X を用意し、updateThunder が
        // interval 秒おきに「⚠を置く→warn 秒後に落とす」を順に刻む
        fillThunderPass();
        battle.thunderTimer = 0;   // 1本目の⚠はすぐ
        PP.audio.darkMagic();
        PP.fx.screenFlash("rgba(255,250,200,1)", 0.12, 160);
      } else {
        // 単発の狙い撃ち(addle=速い / shotSlow=大きく遅い / randomize=中速)
        var spec = B[key];
        var r = (key === "shotSlow") ? B.shotSlow.r : B.orb.r;
        var ddx = tx - sx, ddy = ty - sy;
        var dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        spawnBullet(key, sx, sy, ddx / dlen * spec.speed * spdMul(), ddy / dlen * spec.speed * spdMul(), 0, r);
      }
    }

    function updateBarrage(dt) {
      if (battle.barrageLeft <= 0) return;
      battle.barrageT -= dt;
      if (battle.barrageT > 0) return;
      var Q = PP.BOSS.barrage;
      battle.barrageT = Q.interval;
      battle.barrageLeft--;
      var n = Q.perVolley + (battle.phase2 ? 1 : 0);
      for (var i = 0; i < n; i++) {
        var mx = 80 + Math.random() * (PP.W - 160);
        var my = -30 - Math.random() * 60;
        var mvx = Math.max(-120, Math.min(120, (PP.cannon.x - mx) * 0.15)) * spdMul();
        spawnBullet("barrage", mx, my, mvx, Q.vy0 * spdMul(), Q.grav, Q.meteorR,
          { viewScale: Q.viewScale, meteor: true });
      }
      PP.audio.meteorFall();   // 落下ホイッスル(ボレーごと)
    }

    function emitCrossDot(ex, ey, txx, tyy, C) {
      var dx = txx - ex, dy = tyy - ey;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      spawnBullet("cross", ex, ey,
        dx / len * C.speed, dy / len * C.speed, 0, C.r,
        { viewScale: C.r / PP.BOSS.orb.r });
    }

    function updateCross(dt) {
      if (!battle.crossActive) return;
      var C = PP.BOSS.cross;
      var period = C.period * (battle.phase2 ? C.p2PeriodMul : 1);
      var dur = C.swings * period;
      battle.crossT += dt;
      var amp = PP.W / 2 - C.ampMargin;
      var iy = PP.CANNON_Y - 20;
      var eL = { x: battle.body.x - C.emitDX, y: battle.body.y + C.emitDY };
      var eR = { x: battle.body.x + C.emitDX, y: battle.body.y + C.emitDY };
      // 照準は「発射時点」の振り子位置。弾は地上まで約1秒かけて飛ぶので、
      // 着弾の掃引は発射より約1秒遅れて同じ振り子を描く=最初の着弾は必ず
      // 予兆どおり中央から始まり、そこから右→左…と振れていく。
      // (「着弾時刻の位置」を先読みすると、撃ち始めの弾がいきなり右端を
      //  狙ってしまい予兆とズレる。先読みはしないこと)
      var aimX = PP.W / 2 + amp * Math.sin(Math.PI * 2 * battle.crossT / period);
      battle.crossEmitAcc += dt * C.emitHz;
      while (battle.crossEmitAcc >= 1) {
        battle.crossEmitAcc--;
        emitCrossDot(eL.x, eL.y, aimX + C.aimCrossGap, iy, C);   // 左舷 → 掃引点の右側
        emitCrossDot(eR.x, eR.y, aimX - C.aimCrossGap, iy, C);   // 右舷 → 掃引点の左側
      }
      if (battle.crossT >= dur) battle.crossActive = false;
    }

    function updateCurtain(dt) {
      if (battle.curtainLeft <= 0) return;
      battle.curtainT -= dt;
      if (battle.curtainT > 0) return;
      battle.curtainT = 0.45;
      var row = battle.curtainTotal - battle.curtainLeft;
      battle.curtainLeft--;
      var B = PP.BOSS;
      var odd = row % 2;                          // 0=7発の段 / 1=6発の段
      var nS = 7 - odd;
      // ゆっくり垂れ下がる(急加速は全段出揃ってからの一斉落下で行う)
      var vS = B.shotSlow.fallSpeed * spdMul();
      var pitchS = PP.W / 8;                      // 両方の段で共通のピッチ
      for (var c2 = 0; c2 < nS; c2++) {
        var gxS = pitchS * (c2 + 1 + odd * 0.5);  // 6発の段は 7発の段の中間に
        spawnBullet("shotSlow", gxS, battle.body.y + 20, 0, vS, 0, B.shotSlow.r,
          { wave: { amp: 12, freq: 1.6, ph: row * 1.3 + c2 * 0.4 }, curtain: true });
      }
      // 最終段を撃ち終えたら、一斉落下までのカウントダウンを開始
      if (battle.curtainLeft <= 0) battle.curtainDropT = B.shotSlow.dropDelay;
      // 段ごとに「ズン」と落ちる圧(音程は段が進むほど上がる=残りが読める)
      PP.audio.beep(180 + row * 30, 0.1, "sine", 0.09);
      PP.audio.gliss(420, 160, 0.4, "sine", 0.06);
      PP.fx.shake(3, 0.12);
    }

    function updateSweep(dt) {
      if (battle.sweepLeft <= 0) return;
      battle.sweepT -= dt;
      if (battle.sweepT > 0) return;
      battle.sweepT = 0.05;
      battle.sweepLeft--;
      var sx = battle.body.x, sy = battle.body.y + 38;
      var k = 1 - battle.sweepLeft / battle.sweepTotal;                    // 0→1 で掃引
      var ang = Math.PI * (0.12 + 0.76 * k);                 // 左→右へ掃く腕
      var v = 390 * spdMul();
      spawnBullet("randomize", sx, sy, Math.cos(ang) * v, Math.sin(ang) * v, 0, PP.BOSS.orb.r,
        { wave: { amp: 30, freq: 2.5, ph: k * 6 } });
      var ang2 = Math.PI - ang;                              // 右→左へ掃く腕(鏡像)
      spawnBullet("randomize", sx, sy, Math.cos(ang2) * v, Math.sin(ang2) * v, 0, PP.BOSS.orb.r,
        { wave: { amp: 30, freq: 2.5, ph: 3 + k * 6 } });
      // 0.05秒刻み(20回/秒)で毎回鳴らすと Oscillator+Gain の生成が積み上がるので
      // 3 tick に 1 回に間引く(上昇ジッパー音の聴感はほぼ同一)
      if (battle.sweepLeft % 3 === 0) PP.audio.beep(500 + k * 500, 0.04, "square", 0.05);
    }
    return {
      fireAttack: fireAttack,
      updateBarrage: updateBarrage,
      emitCrossDot: emitCrossDot,
      updateCross: updateCross,
      updateCurtain: updateCurtain,
      updateSweep: updateSweep
    };
  };
})();
