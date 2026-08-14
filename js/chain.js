/* =========================================================
 * chain.js — チェーン(玉の列)の物理とマッチ判定
 *
 * マルチレーン対応: チェーンはレーンごとに独立している。各レーンは自分の
 *   rail・balls・recoil・波の状態(wave/pending/needTreasure/waveFresh/
 *   waveTimer)・pendingMatches を持つ。update(dt) は全レーンを順に処理する。
 *   処理対象のレーンは各ヘルパへ引数 lane で明示的に渡す(以前はモジュール変数 L
 *   に置いて暗黙参照していたが、読み手が「どのレーンを触っているか」を追いやすい
 *   よう引数化した)。1本コースのときはレーン1つを回すだけ=従来と同一挙動。
 *
 * コンボ・スコア・生存ゲージ・パワーアップ効果(slow/reverse/stop)・レベル
 * 開始のなだれ込み(rolloutBoost)は全レーン共通なので PP.game に残す。
 *
 * 原作 Zuma / Pirate Poppers と同じ「後ろから押される 1 本の列」:
 *   ・進むのは最後尾グループ(補給口に押されている側)と、宝玉を連れている
 *     グループ。宝玉は自ら列を引いて樽へ向かうので、後続の波が湧いても
 *     取り残されない。宝玉のない分断グループは、後続が接触して合流する
 *     まで完全に停止する。
 *   ・速度はレール上の位置で決まる(speedAt)。洞窟から出た直後は速く、
 *     樽に近づくほど少しずつ減速する。
 *   ・隙間は同色なら磁力で閉じる。ぶつけた側のグループが洞窟方向へ押し戻される。
 *   ・重なりは後ろ→前への押し出しで解決。
 *
 * マッチ判定は原作 Zuma と同じくイベント駆動:
 *   発射玉の割り込み・磁力の合流・消したあとの接合のときだけ調べる。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var D = PP.D;

  // 逆風(reverse)の風速。発動から加速し、進行方向の速度から引き算して使う。
  // 全レーン共通の風なので、風速の更新は update のフレーム先頭で1回だけ行う。
  // reverseDist は今回の発動で「実際に後退した」累計距離(PP.REVERSE_RANGE で凪ぐ)。
  // 風の吹いた時間ではなく実後退で数える: 前進の速い区間では風が勝つまで
  // 列が動かないので、時間で数えると戻らないまま上限だけ消費してしまう。
  // reverseFrameRet はこのフレームの後退量(advance が書き、update が積む)
  var reverseV = 0, reverseWasActive = false, reverseDist = 0, reverseFrameRet = 0;

  // 風の状態を初期化する(レベル開始・リトライ時に main.js が呼ぶ)。
  // これが無いと、風が吹いている最中のリトライで reverseWasActive が true のまま
  // 残り、再開1フレーム目に「時間切れ終了」と誤検出して開幕から凪が入ってしまう
  function resetWind() {
    reverseV = 0;
    reverseWasActive = false;
    reverseDist = 0;
    reverseFrameRet = 0;
  }

  // 波の効果音を鳴らした直近の時刻(ms)。マルチレーンではレベル開始時に全レーンが
  // 同時に波を湧かせるので、この窓の間に重なった波は音を1回にまとめる(N重奏を防ぐ)。
  var lastWaveSoundT = -1e9;
  var WAVE_SOUND_GAP = 150;   // この間隔(ms)以内の波は音を鳴らし直さない

  // ホットループ用の使い回しオブジェクト(posAtInto の書き込み先)。ミサイル飛行中は
  // 毎フレーム全玉の座標を引くので、座標オブジェクトの確保を無くす(cannon.js と同じ手)。
  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };

  // 次の波までの保険タイマー(秒)。通常コースの本来のトリガは「最後尾の位置」
  // (updateWaveTimer 参照)で、時間はあくまで手詰まり防止の上限。
  // ボス戦は「玉列が途切れず流れ続ける」演出なので、専用の短い間隔で時間駆動する
  function waveInterval() {
    if (PP.game.bossMode) return PP.BOSS.waveInterval;
    return PP.WAVE_NEXT.maxWait;
  }

  // 新しい波の補給を開始する(レーン単位)
  function startWave(lane) {
    var g = PP.game;
    lane.wave++;
    var s = PP.WAVE_SIZE;
    var raw = Math.min(s.max, s.base + g.level * s.perLevel + lane.wave * s.perWave);
    // 波の玉数はレール全長に比例させる。短いコース(や短いレーン)が開幕から
    // 溢れないように、基準長(コース1)より短ければ同じ密度になるまで減らす。
    var scale = Math.max(0.35, Math.min(1, lane.rail.length / PP.WAVE_REF_LEN));
    lane.pending = Math.max(6, Math.round(raw * scale));
    // ボス戦: 波間隔を詰めて絶え間なく補給する(玉列は洞窟から先頭まで連続)。
    // 宝玉は付けない(宝の解放で列が途切れる構造にしない)。穴を開けるのは
    // プレイヤーのマッチ消しだけで、その穴がボスへの射線になる
    if (PP.game.bossMode) lane.pending = PP.BOSS.waveSize;
    lane.needTreasure = !PP.game.bossMode;
    lane.waveFresh = true;
    lane.waveTimer = waveInterval();
    PP.game.colorsDirty = true;   // 補給が再開した → 装填色の見張りの前提が変わる
    // 波の効果音は、近接タイミングで湧いた複数レーンぶんをまとめて1回だけ鳴らす。
    // ボス戦は補給が絶え間ない(数秒おきに波が始まる)ので、いちいち鳴らさない
    if (g.state === "playing" && !g.bossMode) {
      var now = Date.now();
      if (now - lastWaveSoundT > WAVE_SOUND_GAP) {
        PP.audio.newWave();
        lastWaveSoundT = now;
      }
    }
    PP.hud.update();
  }

  // 次の波のトリガ。前の波が洞窟口を空けていることが前提で、
  //   ・通常コース: 最後尾(前の波の締めの宝玉)が樽へある程度近づいたら次の波
  //     (PP.WAVE_NEXT.progress)。時間(waveTimer)は、最後尾が宝を失って
  //     停止したまま放置された場合でも補給が途絶えないための保険にだけ使う
  //   ・ボス戦: 従来どおり時間駆動(短い間隔で絶え間なく補給する演出)
  // 掃討フェーズ(g.finishing=全レーン共通)に入ったら補給は打ち切る。ただし
  // 供給中だった波の残り(lane.pending と末尾の宝玉)は最後まで出し切る。
  function updateWaveTimer(lane, dt) {
    var g = PP.game;
    if (g.state !== "playing" || g.finishing) return;
    if (lane.waveTimer > 0) lane.waveTimer -= dt;
    if (lane.pending > 0 || lane.needTreasure) return;
    var balls = lane.balls;
    var clear = balls.length === 0 || balls[balls.length - 1].d >= D;
    if (!clear) return;
    if (balls.length === 0) { startWave(lane); return; }
    if (g.bossMode) {
      if (lane.waveTimer <= 0) startWave(lane);
      return;
    }
    if (balls[balls.length - 1].d >= lane.rail.holeD * PP.WAVE_NEXT.progress ||
        lane.waveTimer <= 0) startWave(lane);
  }

  // 補給口から玉を追加。波の補給が終わったら末尾に宝玉を付ける
  function spawnBalls(lane) {
    var balls = lane.balls;
    while (lane.pending > 0 &&
           (balls.length === 0 || lane.waveFresh || balls[balls.length - 1].d >= D)) {
      var color = PP.ball.spawnColor(lane);
      var view = PP.ball.makeView(color);
      var d;
      if (balls.length === 0 || lane.waveFresh) {
        d = 0;                                // 新しい波は洞窟から
        lane.waveFresh = false;
      } else {
        d = balls[balls.length - 1].d - D;
      }
      view.visible = false;
      PP.layers.ballUnder.addChild(view);   // 既定は下層。交差では描画側が上層へ移す
      balls.push({ d: d, color: color, wave: lane.wave, view: view, pull: 0, slide: 0 });
      // 骸骨玉: 一定確率で「普通の色玉」に骸骨マークを重ねる(色はそのままなので
      // マッチも磁石も通常どおり効く。弾幕の管理は skull.js)。ボス戦には出さない。
      // コース定義の skullMult で出現率をコース単位で増減できる(コース5は 0.5)
      var skullChance = PP.SKULL.chance *
        ((PP.game.builtCourse && PP.game.builtCourse.skullMult) || 1);
      // 強化圧: 強化を取るほど骸骨玉も湧きやすくなる(PP.UPGRADE_PRESSURE)
      if (PP.upgrades && PP.upgrades.skullPressure) skullChance *= PP.upgrades.skullPressure();
      if (!PP.game.bossMode && PP.skull && PP.SKULL &&
          Math.random() < skullChance &&
          PP.skull.countActive() < PP.SKULL.maxActive) {
        var nb = balls[balls.length - 1];
        nb.skull = true;
        nb.skullCd = PP.SKULL.firstDelay;
        nb.skullFx = PP.ball.makeSkullOverlay();
        view.addChild(nb.skullFx);
      }
      PP.game.ballsDirty = true;   // 玉の増減 → 描画側が重なり順を積み直す
      PP.game.colorsDirty = true;  // 盤面の色構成が変わった → 装填色の見張りを回す
      lane.pending--;
    }

    // 波の補給完了 → 末尾に宝玉(こちらも balls の一員)
    if (lane.pending === 0 && lane.needTreasure) {
      lane.needTreasure = false;
      if (balls.length > 0) {
        var tview = PP.ball.makeTreasureView();
        tview.visible = false;
        PP.layers.ballUnder.addChildAt(tview, 0);
        balls.push({
          d: balls[balls.length - 1].d - D,
          color: null, treasure: true, wave: lane.wave,
          view: tview, pull: 0, slide: 0
        });
        PP.game.ballsDirty = true;
        PP.game.colorsDirty = true;   // 補給完了(pending/needTreasure が変化)
      }
    }
  }

  // 接触グループの区切りインデックス([開始index,...])
  // 毎フレーム×レーン数だけ呼ばれるので、配列は使い回す(GC 振動を避ける)。
  // レーンごとに逐次消費され、フレームをまたいで保持されないので 1 本で安全
  var _starts = [0];
  function groupStarts(lane) {
    var balls = lane.balls;
    var starts = _starts;
    starts.length = 1;
    starts[0] = 0;
    for (var i = 1; i < balls.length; i++) {
      if (balls[i - 1].d - balls[i].d > D + 0.5) starts.push(i);
    }
    return starts;
  }

  // balls[start, end) に宝玉が含まれるか(そのグループが自力で進むかの判定)
  function hasTreasure(lane, start, end) {
    var balls = lane.balls;
    for (var i = start; i < end; i++) {
      if (balls[i].treasure) return true;
    }
    return false;
  }

  // balls[start, end) が「宝玉 1 個だけ」のグループか(= 宝単体)。
  function isLoneTreasure(lane, start, end) {
    return end - start === 1 && !!lane.balls[start].treasure;
  }

  // レール上の位置に応じた前進速度。樽に近いほど遅くなる。
  // 渡すのはレーンとグループの先頭の d(列全体がその速度で動く)
  // 速度の一式(sp)はコースごとの設計。t はレール全長に対する割合なので、
  // 短いコースで同じ px/s を使うと一瞬で樽に届く。コース側で緩めてある。
  function speedAt(lane, d) {
    var g = PP.game;
    var sp = g.speed;
    // 難易度(【課題1】config.js)は速度プロファイルそのものに効かせる:
    // entry(序盤の圧)/ hole(終盤のプレッシャー)/ curve(どこまで速さを保つか)
    var df = PP.diff();
    var entry = sp.entry * df.entryMult;
    var hole = sp.hole * df.holeMult;
    var curve = sp.curve * df.curveMult;
    var t = Math.max(0, Math.min(1, d / lane.rail.holeD));
    var v = hole + (entry - hole) * Math.pow(1 - t, curve);
    v *= 1 + (g.level - 1) * sp.levelStep;     // レベルで底上げ
    v *= 1 + sp.rollout * g.rolloutBoost;      // 開始直後のなだれ込み
    // 強化圧: 強化を取るほど巡航速度が少し上がる(PP.UPGRADE_PRESSURE)。
    // ロード順の保険で upgrades の存在を見る(倍率は upgrades.js が事前計算)
    if (PP.upgrades && PP.upgrades.speedPressure) v *= PP.upgrades.speedPressure();
    if (g.effects.slow > 0) v *= 0.5;
    return v;
  }

  // 重なり解消: 後ろ→前へ押し出しを伝播。
  function relax(lane, record) {
    var balls = lane.balls;
    for (var i = balls.length - 2; i >= 0; i--) {
      if (balls[i].d < balls[i + 1].d + D) {
        var nd = balls[i + 1].d + D;
        if (record) balls[i].slide += balls[i].d - nd;
        balls[i].d = nd;
      }
    }
  }

  // 表示用アニメーション(割り込みの滑り込み・押し広げの戻り)を進める
  function updateAnims(lane, dt) {
    var balls = lane.balls;
    var decay = Math.exp(-dt / PP.SLIDE_DECAY);
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (b.slide) {
        b.slide *= decay;
        if (Math.abs(b.slide) < 0.3) b.slide = 0;
      }
      if (b.ins) {
        b.ins.t -= dt;
        if (b.ins.t <= 0) b.ins = null;
      }
      // 衝突の不応期(この間は同じ接合点を磁力で吸い直さない)
      if (b.hitCd > 0) {
        b.hitCd -= dt;
        if (b.hitCd < 0) b.hitCd = 0;
      }
    }
  }

  // 割り込みアニメが終わった玉のマッチ判定(演出中に消え始めないように遅らせる)
  function updatePendingMatches(lane, dt) {
    var list = lane.pendingMatches;
    for (var i = list.length - 1; i >= 0; i--) {
      list[i].t -= dt;
      if (list[i].t > 0) continue;
      var ball = list[i].ball;
      list.splice(i, 1);
      var idx = lane.balls.indexOf(ball);
      if (idx >= 0) resolveMatchAt(lane, idx, false);   // 発射でそろえた単発クリア=コンボにしない
    }
  }

  // ---- 全レーン共通の更新(フレームに1回) ----
  function update(dt) {
    var g = PP.game;
    var eff = g.effects;

    // レベル開始のなだれ込みは倍率を減衰させて通常速度へ滑らかに繋ぐ(全レーン共通)
    if (g.rolloutBoost > 0) {
      g.rolloutBoost *= Math.exp(-dt / g.speed.rolloutDecay);
      if (g.rolloutBoost < 0.05) { g.rolloutBoost = 0; g.rolloutDone = true; }
    }

    // 逆風の風速はフレーム先頭で1回だけ更新する(全レーンへ同じ風速を適用)。
    // 初速から加速し、固定の最大風速 PP.REVERSE_MAX で頭打ち(config.js)。
    // 終わり方は距離(REVERSE_RANGE)と時間切れ(dur)の2通りあり、どちらでも
    // eff.reverseHold の「凪」を挟んでから前進を再開する(即発車させない)。
    if (eff.reverse > 0) {
      if (!reverseWasActive) {
        // 発動の瞬間に初速へ。凪の最中に再取得したら風を優先(ホールド破棄)
        reverseV = PP.REVERSE_SPEED;
        reverseDist = 0;
        eff.reverseHold = 0;
      }
      if (reverseDist >= PP.REVERSE_RANGE) {
        // 玉およそ15個ぶん(REVERSE_RANGE)戻し切ったら、残り秒数を待たずに
        // 効果ごと終了する。「距離で終わる」アイテム。効果時間(PP.POWERUPS の
        // dur)は、風が流れに勝てず戻し切れない場合の保険の上限としてだけ働く
        eff.reverse = 0;
        reverseV = 0;
        eff.reverseHold = PP.REVERSE_HOLD;
      } else {
        reverseV = Math.min(reverseV + PP.REVERSE_ACCEL * dt, PP.REVERSE_MAX);
      }
    } else if (reverseWasActive) {
      // 時間切れ(powerups.update が dur を 0 にした)での終了もここで拾って凪を入れる
      reverseV = 0;
      eff.reverseHold = PP.REVERSE_HOLD;
    }
    reverseWasActive = eff.reverse > 0;

    reverseFrameRet = 0;
    for (var li = 0; li < g.lanes.length; li++) {
      updateLane(g.lanes[li], dt);
    }
    // このフレームの実後退(全レーン・全グループの最大値)を累計へ積む
    reverseDist += reverseFrameRet;
  }

  // ---- レーン1本ぶんの更新 ----
  // 補給→前進→反動→磁力→重なり解消→接合マッチ、を順に回す。玉の増減は spawnBalls
  // でだけ起き、以降のフェーズは group の区切り starts を共有して同じ配列を動かす。
  function updateLane(lane, dt) {
    updateWaveTimer(lane, dt);
    spawnBalls(lane);

    if (lane.balls.length > 0) {
      var starts = groupStarts(lane);
      // 分断された接合点を移動前に控えておく(移動・磁力で閉じたら合流とみなす)
      var joints = snapshotJoints(lane, starts);

      advance(lane, dt, starts);     // 1) 前進(錨で停止 / 逆風で後退 / 通常前進)
      applyRecoil(lane, dt);         // 2) 磁力衝突の反動
      applyMagnet(lane, dt, starts); // 3) 同色の隙間を磁力で閉じる(+慣性で滑る)
      relax(lane, false);            // 4) 重なり解消
      resolveJoints(lane, joints);   //    閉じた接合点だけマッチ判定
    }

    updateTreasures(lane);
    updateAnims(lane, dt);
    updatePendingMatches(lane, dt);
  }

  // 移動前のグループ間の隙間(接合点)を控える。移動・磁力で D 以内へ閉じたら合流。
  // groupStarts と同じ理由で、配列と {tail, head} オブジェクトをプールして使い回す
  var _joints = [], _jointPool = [];
  function snapshotJoints(lane, starts) {
    var balls = lane.balls;
    var n = 0;
    for (var ji = 0; ji < starts.length - 1; ji++) {
      var jTail = balls[starts[ji + 1] - 1];
      var jHead = balls[starts[ji + 1]];
      if (jTail.d - jHead.d - D > 0) {
        var jt = _jointPool[n] || (_jointPool[n] = { tail: null, head: null });
        jt.tail = jTail; jt.head = jHead;
        _joints[n] = jt;
        n++;
      }
    }
    _joints.length = n;
    return _joints;
  }

  // 1) 前進。錨(stop)=停止 / 逆風(reverse)=正味速度で後退 / 通常=位置依存の速度で前進。
  function advance(lane, dt, starts) {
    var g = PP.game;
    var eff = g.effects;
    var balls = lane.balls;
    var i;

    if (eff.stop > 0) {
      // 錨: 何も動かない
    } else if (eff.reverse > 0) {
      // 逆風: 「進行方向の速度」から風速 reverseV(フレーム先頭で更新済み)を
      // 引いた"正味の速度"で後退させる。正味が正=まだ流れが風に勝っている間は
      // 0 で頭打ち(前進はしない)。
      // 正味は先頭の玉(樽に一番近い=進行速度が最も遅い区間)の位置で決め、
      // 全玉へ同じ量を適用する: レーン全体が間隔を保ったまま洞窟側へ押し戻される。
      // グループごとに自分の位置の速度で計算すると、洞窟寄りの後続は速度が
      // 速すぎて風が勝てず居座り、先頭のチェーンしか戻らない(戻った先頭も
      // 後続に接触した時点で relax に押し返されて止まる)
      var net = Math.min(0, speedAt(lane, balls[0].d) - reverseV) * dt;  // 負なら後退
      if (net !== 0) {
        if (-net > reverseFrameRet) reverseFrameRet = -net;   // 実後退量(上限の計上用)
        for (i = 0; i < balls.length; i++) balls[i].d += net;
      }
    } else if (eff.reverseHold > 0) {
      // 吹き戻し後の凪: 錨と同様に前進だけ止める(反動・磁力・重なり解消は
      // 生かすので、開いた隙間は閉じ続ける)。タイマー減算は powerups.update
      // の汎用ループが行う。切れた後の発車は spdD/spdHold の既存機構が
      // 「じわっと加速」にしてくれる
    } else if (g.bossMode && starts.length > 1) {
      // ボスコースの特例: 隙間が開いている間は「洞窟に繋がっている最後尾の
      // 列群」だけが前進し、前方に切り離された断片はその場に静止する。
      // 断片は樽へ進まない=隙間を開けた恩恵で、最後尾が等速で詰めて再接続する
      // (速度は先頭位置基準 × gapCatchUp。洞窟寄りの通常則だと速すぎる)
      var base = speedAt(lane, balls[0].d);
      var lastStart = starts[starts.length - 1];
      var uStep = base * PP.BOSS.gapCatchUp * dt;
      for (i = 0; i < balls.length; i++) {
        if (i >= lastStart) balls[i].d += uStep;
        balls[i].spdD = undefined;   // 基準を捨てる(隙間が閉じた後は自然復帰)
        balls[i].spdHold = 0;
      }
    } else {
      // 反動で押し戻されている最中のグループは、速度基準を動かさない
      var recIdx = lane.recoil ? balls.indexOf(lane.recoil.anchor) : -1;
      for (var si = starts.length - 1; si >= 0; si--) {
        var gs = starts[si];
        var ge = (si + 1 < starts.length) ? starts[si + 1] : balls.length;
        if (si !== starts.length - 1 &&
            (!hasTreasure(lane, gs, ge) || isLoneTreasure(lane, gs, ge))) continue;
        // 速度はグループの先頭(樽に一番近い玉)の位置で決める。
        var head = balls[gs];
        var ref = head.spdD;
        var hold = head.spdHold || 0;
        if (ref === undefined || head.d >= ref) {
          ref = head.d;                       // 通常の前進(基準は先頭そのもの)
          hold = PP.SPD_REF_HOLD;
        } else if (recIdx >= gs && recIdx < ge) {
          hold = PP.SPD_REF_HOLD;             // 反動中は据え置き
        } else if (hold > 0) {
          hold -= dt;                         // 分断直後の猶予(急加速に見せない)
        } else {
          // 取り残された基準を、自分の先頭へじわりと引き寄せる
          ref = head.d + (ref - head.d) * Math.exp(-dt / PP.SPD_REF_RELAX);
        }
        var step = speedAt(lane, ref) * dt;
        for (i = gs; i < ge; i++) {
          balls[i].d += step;
          balls[i].spdD = ref;
          balls[i].spdHold = hold;
        }
      }
    }
  }

  // 3) 磁力: 隙間の前後が同色なら前グループが加速しながら後退して合流。最後に
  //    最後尾グループ(磁力の対象外)の pull を落とす。
  function applyMagnet(lane, dt, starts) {
    var balls = lane.balls;
    var i;
    // ボスの「運命のルーレット」の回転中は磁力を止める。色が毎ステップ
    // 入れ替わるため、偶然同色になった隙間が吸着してしまう誤発動を防ぐ
    // (確定した瞬間から通常どおり働く)
    if (PP.game.rouletteSpin) {
      for (i = 0; i < balls.length; i++) balls[i].pull = 0;
      return;
    }
    for (var gi = 0; gi < starts.length - 1; gi++) {
      var tail = starts[gi + 1] - 1;   // 前グループの最後尾の玉
      var head = starts[gi + 1];       // 後グループの先頭の玉
      var gStart = starts[gi];
      var gap = balls[tail].d - balls[head].d - D;
      var withTreasure = balls[tail].treasure || balls[head].treasure;
      // 後ろ側の先頭が宝単体 = 磁石。ただし前グループの末尾が宝玉のときは吸わない
      var headLone = balls[head].treasure &&
        (head + 1 >= balls.length || balls[head].d - balls[head + 1].d > D + 0.5);
      var magnet = headLone && !balls[tail].treasure;
      // ついさっきぶつかったばかりなら、反動で開いた隙間をすぐには磁力で閉じ直さない。
      if (!magnet && (balls[tail].hitCd > 0 || balls[head].hitCd > 0)) {
        for (i = gStart; i <= tail; i++) balls[i].pull = 0;
        continue;
      }
      var attract = magnet ||
        (!withTreasure && balls[tail].color === balls[head].color);
      if (!attract || gap <= 0) {
        // 磁力が切れた瞬間に急停止させない。巻き戻っていた勢いは慣性として残り滑る。
        var coast = balls[tail].pull || 0;
        if (coast <= 0 || gap <= 0) {
          if (gap <= 0 && attract && !magnet && coast > 0) impact(lane, head, coast);
          for (i = gStart; i <= tail; i++) balls[i].pull = 0;
          continue;
        }
        coast *= Math.exp(-dt / PP.COAST_DECAY);
        if (coast < PP.COAST_MIN) coast = 0;
        var coastMove = Math.min(coast * dt, gap);
        for (i = gStart; i <= tail; i++) {
          balls[i].d -= coastMove;
          balls[i].pull = coast;
        }
        continue;
      }
      // 引き寄せは加速する(近いほど速く吸い込まれ、ぶつかる勢いになる)。
      var v0 = magnet ? PP.MAGNET_SPEED : PP.ATTRACT_SPEED;
      var acc = magnet ? PP.MAGNET_ACCEL : PP.ATTRACT_ACCEL;
      var vmax = magnet ? PP.MAGNET_MAX : PP.ATTRACT_MAX;
      if (magnet) {
        // 磁石らしく「近いほど強く引く」。
        var near = Math.max(0, 1 - gap / PP.MAGNET_RANGE);
        acc *= 1 + PP.MAGNET_NEAR_GAIN * near * near;
      }
      // 巻き戻りの勢い(前フレームの磁力)を引き継いで加速する
      var v = Math.min(Math.max(balls[tail].pull || 0, v0) + acc * dt, vmax);
      var pullMove = Math.min(v * dt, gap);
      for (i = gStart; i <= tail; i++) { balls[i].d -= pullMove; balls[i].pull = v; }
      if (pullMove >= gap) {
        if (magnet) {
          // 宝に吸い付いた。反動は起こさず軽い演出だけにする
          for (i = gStart; i <= tail; i++) balls[i].pull = 0;
          var mp = lane.rail.posAt(balls[head].d);
          PP.fx.burst(mp.x, mp.y, "#ffe08a", 8);
          PP.audio.beep(520, 0.12, "sine", 0.09);
        } else {
          // 隙間が閉じた = 衝突。勢いを後ろの列への反動に変換する。
          impact(lane, head, v);
        }
      }
    }

    // 最後尾グループは磁力(3)の対象にならないので、ここで勢いを落とす。
    for (i = starts[starts.length - 1]; i < balls.length; i++) balls[i].pull = 0;
  }

  // 移動・磁力の結果、控えておいた接合点が D 以内へ閉じたらマッチ判定する。
  // (Zuma 準拠: 補給列の塊は勝手に消えない。閉じた接合だけを調べる)
  function resolveJoints(lane, joints) {
    var balls = lane.balls;
    for (var mi = 0; mi < joints.length; mi++) {
      var jt = joints[mi];
      if (jt.tail.d - jt.head.d > D + 0.5) continue;
      if (jt.tail.color !== jt.head.color) continue;
      var hi = balls.indexOf(jt.head);
      if (hi >= 0) resolveMatchAt(lane, hi, true);   // 磁石/合流での連鎖クリア=コンボを積む
    }
  }

  // 接合点 headIndex がいま繋がったとして、同色3連以上が成立するか(先読み)。
  function willMatchAt(lane, headIndex) {
    var balls = lane.balls;
    var front = balls[headIndex - 1], back = balls[headIndex];
    if (!front || !back) return false;
    var c = front.color;
    if (c === null || c === undefined || back.color !== c) return false;
    var n = 0, i;
    for (i = headIndex - 1; i >= 0 && balls[i].color === c; i--) {
      if (i < headIndex - 1 && balls[i].d - balls[i + 1].d > D + 1) break;
      n++;
    }
    for (i = headIndex; i < balls.length && balls[i].color === c; i++) {
      if (i > headIndex && balls[i - 1].d - balls[i].d > D + 1) break;
      n++;
    }
    return n >= 3;
  }

  // 反動があとどれだけ押せるか(px)。減衰で自然に止まる距離と使い残しの小さい方。
  function recoilReach(v, damp, max, moved) {
    return Math.min(v / damp, Math.max(0, max - (moved || 0)));
  }

  // 磁力で引き寄せられた列が後ろの列にぶつかった瞬間。
  // 衝突の勢いを反動に変換し、ぶつけられた側(補給側)だけを押し戻す。
  function impact(lane, headIndex, v) {
    var g = PP.game;
    var balls = lane.balls;
    var anchor = balls[headIndex];
    anchor.hitCd = PP.BOUNCE_COOLDOWN;
    if (balls[headIndex - 1]) balls[headIndex - 1].hitCd = PP.BOUNCE_COOLDOWN;
    // 段数は g.combo をそのまま使わない(impact はマッチ判定より前に呼ばれる)。
    var level = (g.comboTimer > 0 && willMatchAt(lane, headIndex)) ? g.combo + 1 : 0;
    var isCombo = level >= PP.RECOIL_COMBO_MIN;
    var mult = 1;
    if (isCombo) {
      mult = Math.min(PP.RECOIL_COMBO_MULT_MAX,
        1 + (level - PP.RECOIL_COMBO_MIN + 1) * PP.RECOIL_COMBO_GAIN);
    }
    var ratio = isCombo ? PP.RECOIL_COMBO_RATIO : PP.RECOIL_RATIO;
    var maxDist = (isCombo ? PP.RECOIL_COMBO_DIST : PP.RECOIL_MAX) * mult;
    var damp = isCombo ? PP.RECOIL_COMBO_DAMP : PP.RECOIL_DAMP;
    // 【強化】「砲撃の重み」: 押し戻しの強さと最大距離が伸びる(damp は据え置き
    // = 押す時間ではなく距離が伸びる。RECOIL_FLOOR が洞窟への押し込み過ぎを防ぐ)
    var rMul = PP.upgrades.val("recoil");
    ratio *= rMul;
    maxDist *= rMul;
    var rv = v * ratio * mult;

    // 同フレームの複数衝突や、連鎖で引き継いだ反動との比較(まだ押せる距離で比べる)。
    var replaced = false;
    if (!lane.recoil ||
        recoilReach(rv, damp, maxDist, 0) >
        recoilReach(lane.recoil.v, lane.recoil.damp || PP.RECOIL_DAMP,
                    lane.recoil.max, lane.recoil.moved)) {
      lane.recoil = { anchor: anchor, v: rv, moved: 0, max: maxDist, damp: damp };
      replaced = true;
    }
    if (!replaced && lane.recoil.anchor === anchor) return;
    if (g.state !== "playing" || !g.rolloutDone) return;

    // 手応えの演出: 衝突点の火花と、ぶつかった2玉の潰れ
    var p = lane.rail.posAt(anchor.d);
    PP.fx.burst(p.x, p.y, "#ffe8b0", 6);
    PP.audio.pop(1);
    if (mult > 1) {
      PP.fx.burst(p.x, p.y, "#ff9f4a", 10);
      PP.fx.floatText("大反動 x" + mult.toFixed(1), p.x, p.y - 30, "#ff9f4a", 19);
    }
    [balls[headIndex - 1], anchor].forEach(function (b) {
      if (!b) return;
      createjs.Tween.get(b.view, { override: true })
        .to({ scaleX: 1.18, scaleY: 0.86 }, 50)
        .to({ scaleX: 1, scaleY: 1 }, 160, createjs.Ease.backOut);
    });
  }

  // 反動の適用: ぶつけられた「そのグループ」だけを洞窟方向へ押し戻す。
  function applyRecoil(lane, dt) {
    var balls = lane.balls;
    var rec = lane.recoil;
    if (!rec) return;
    var ai = balls.indexOf(rec.anchor);
    if (ai < 0) { lane.recoil = null; return; }   // anchor が消えたら反動も終わり

    if (!rec.inherited) {
      rec.anchor.hitCd = PP.BOUNCE_COOLDOWN;
      if (balls[ai - 1]) balls[ai - 1].hitCd = PP.BOUNCE_COOLDOWN;
    }

    // 反動の対象は anchor を含む「接触している連続区間」[start, end)。
    var start = ai;
    while (start > 0 && balls[start - 1].d - balls[start].d <= D + 0.5) start--;
    var end = ai + 1;
    while (end < balls.length && balls[end - 1].d - balls[end].d <= D + 0.5) end++;

    var step = Math.min(rec.v * dt, rec.max - rec.moved);
    // グループの最後尾を洞窟の奥へ押し込みすぎない
    step = Math.min(step, balls[end - 1].d - PP.RECOIL_FLOOR);
    if (step > 0) {
      for (var i = start; i < end; i++) balls[i].d -= step;
      rec.moved += step;
    }
    rec.v *= Math.exp(-(rec.damp || PP.RECOIL_DAMP) * dt);
    if (rec.v < 8 || rec.moved >= rec.max) lane.recoil = null;
  }

  // 現在チェーンに乗っている宝玉の一覧(全レーン集約)。要素は {ball, lane}。
  function treasureList() {
    var out = [];
    PP.game.eachLaneBall(function (b, lane) {
      if (b.treasure) out.push({ ball: b, lane: lane });
    });
    return out;
  }

  // 宝玉の解放・粉砕(レーン lane 内)
  function updateTreasures(lane) {
    var balls = lane.balls;
    for (var i = balls.length - 1; i >= 0; i--) {
      var t = balls[i];
      if (!t.treasure) continue;
      if (i === 0) {
        // 前方の玉が全滅 → 宝玉が解放されて落下する
        freeTreasure(lane, i);
      } else if (i + 1 < balls.length &&
                 balls[i + 1].wave > t.wave &&
                 t.d - balls[i + 1].d <= D + 0.5) {
        // 後続の波が接触した → 粉砕
        crushTreasure(lane, i);
      }
    }
  }

  function removeTreasureAt(lane, index) {
    var t = lane.balls.splice(index, 1)[0];
    PP.game.ballsDirty = true;
    createjs.Tween.removeTweens(t.view.glow);
    if (t.view.parent) t.view.parent.removeChild(t.view);
    return t;
  }

  // 波を全消しした報酬: 宝玉がその場から落下アイテムになる
  function freeTreasure(lane, index) {
    var t = removeTreasureAt(lane, index);
    var p = lane.rail.posAt(Math.max(t.d, 0));
    PP.fx.burst(p.x, p.y, "#ffe08a", 16);
    PP.fx.floatText("お宝解放!", p.x, p.y - 26, "#ffe08a", 20);
    PP.audio.treasure();
    PP.powerups.dropTreasure(p.x, p.y);
  }

  // 後続の波に追いつかれた: 宝玉は砕け散る
  function crushTreasure(lane, index) {
    var t = removeTreasureAt(lane, index);
    var p = lane.rail.posAt(Math.max(t.d, 0));
    PP.fx.burst(p.x, p.y, "#c9a86a", 14);
    PP.fx.burst(p.x, p.y, "#8a97a8", 8);
    PP.fx.floatText("宝が砕けた…", p.x, p.y - 26, "#b0b8c0", 18);
    PP.audio.crush();
  }

  // 全宝玉を即時撤去(レベル開始・ゲームオーバー用)。全レーンを掃く。
  function clearTreasures() {
    PP.game.eachLane(function (lane) {
      var balls = lane.balls;
      for (var i = balls.length - 1; i >= 0; i--) {
        if (balls[i].treasure) removeTreasureAt(lane, i);
      }
    });
  }

  // index の玉を含む「接触している同色の連なり」を左右に伸ばし、3個以上なら消す。
  function resolveMatchAt(lane, index, chained) {
    var balls = lane.balls;
    if (index < 0 || index >= balls.length) return false;
    var c = balls[index].color;
    if (c === null || c === undefined) return false;
    var i = index, j = index;
    while (i > 0 && balls[i - 1].color === c &&
           balls[i - 1].d - balls[i].d <= D + 1) i--;
    while (j + 1 < balls.length && balls[j + 1].color === c &&
           balls[j].d - balls[j + 1].d <= D + 1) j++;
    // 【強化】救済(海神の加護)中は、撃った弾の割り込み(chained=false)に限り
    // 2個で消える。chained=false はこの経路(updatePendingMatches)だけが通るので、
    // 磁力合流・連鎖・爆発の巻き込みで盤面が勝手に2個ずつ溶ける事故は起きない
    var need = (!chained && PP.upgrades.rescueActive()) ? 2 : 3;
    if (j - i + 1 < need) return false;
    popRun(lane, i, j, chained);
    return true;
  }

  // balls[i..j] を消してスコア・演出・アイテムドロップ(レーン lane)
  function popRun(lane, i, j, chained) {
    var g = PP.game;
    var balls = lane.balls;
    var n = j - i + 1;
    g.combo = chained ? (g.comboTimer > 0 ? g.combo + 1 : 1) : 1;
    // 【強化】「コンボの余韻」で窓が延びる(未取得なら val は 1 = 従来どおり)
    g.comboTimer = PP.COMBO_WINDOW * PP.upgrades.val("combo");
    var points = n * 10 * g.combo;
    g.score += points;

    // 演出
    var mid = balls[Math.floor((i + j) / 2)];
    var mp = lane.rail.posAt(mid.d);
    PP.fx.floatText("+" + points, mp.x, mp.y - 24, "#ffe08a");
    if (g.combo >= 2) {
      PP.fx.floatText("コンボ x" + g.combo + "!", mp.x, mp.y - 48, "#ff5d8f", 20);
      PP.audio.combo(g.combo);
    } else {
      PP.audio.pop(n);
    }

    destroyRange(lane, i, j);
    PP.powerups.maybeDrop(mp.x, mp.y);
    PP.hud.update();

    // 消えた跡の前後がすでに接触していれば、その場で連鎖。
    joinAt(lane, i);
  }

  // balls[i..j] を列から取り除き、弾ける演出を付ける(スコアや連鎖判定はしない)
  function destroyRange(lane, i, j) {
    var balls = lane.balls;
    var removed = balls.splice(i, j - i + 1);
    PP.game.ballsDirty = true;
    PP.game.colorsDirty = true;   // 色が盤面から消えたかもしれない → 見張りを回す
    // 反動の起点が消えたら、後ろ(補給側)に残った玉へ引き継ぐ。
    if (lane.recoil && removed.indexOf(lane.recoil.anchor) >= 0) {
      lane.recoil.anchor = balls[i] || null;
      lane.recoil.inherited = true;
      if (!lane.recoil.anchor) lane.recoil = null;
    }
    removed.forEach(function (b, k) {
      var p = lane.rail.posAt(b.d + (b.slide || 0));
      b.view.x = p.x; b.view.y = p.y;
      // 骸骨玉の撃破報酬: ボーナススコア(確実)+高確率のパワーアップドロップ。
      // destroyRange は全撃破経路(マッチ・爆弾・ミサイル・カラーボム)の
      // 唯一の通り道なので、ここ1か所で必ず報酬判定が走る
      if (b.skull) {
        PP.game.score += PP.SKULL.rewardScore;
        if (Math.random() < PP.SKULL.dropChance) PP.powerups.dropPower(p.x, p.y);
        PP.fx.ring(p.x, p.y, "#ffd24a", 10, 80, 450);
        PP.fx.floatText("☠ 撃破! +" + PP.SKULL.rewardScore, p.x, p.y - 34, "#ffd24a", 20);
        PP.audio.beep(520, 0.12, "square", 0.09);
      }
      PP.fx.particles(p.x, p.y, b.color, k * 15);
      createjs.Tween.get(b.view, { override: true })
        .wait(k * 15)
        .to({ scaleX: 1.35, scaleY: 1.35 }, 60)
        .to({ scaleX: 0, scaleY: 0, alpha: 0 }, 100, createjs.Ease.backIn)
        .call(function () { if (b.view.parent) b.view.parent.removeChild(b.view); });
    });
    return removed.length;
  }

  // 【強化】自動機銃用: balls[index] の1個だけを破壊する。
  // popRun を使わないのは、あちらがコンボを 1 に上書きしてプレイヤーの継続コンボを
  // 踏み潰し、maybeDrop まで回してしまうため。destroyRange 経路なので骸骨玉の
  // 撃破報酬はそのまま通り、joinAt により前後が同色接触なら連鎖(chained)へ発展する
  // = 自動破壊がプレイヤーのお膳立てになる。スコア加算は呼び出し側(upgrades.js)。
  function destroySingle(lane, index) {
    if (index < 0 || index >= lane.balls.length) return 0;
    if (lane.balls[index].treasure) return 0;   // 宝玉は壊さない(二重の保険)
    var n = destroyRange(lane, index, index);
    joinAt(lane, index);
    return n;
  }

  // 消えた跡 index の前後がすでに接触していたら、その場で連鎖クリア(コンボを積む)。
  function joinAt(lane, index) {
    var balls = lane.balls;
    if (index > 0 && index < balls.length &&
        balls[index - 1].color === balls[index].color &&
        balls[index - 1].d - balls[index].d <= D + 1) {
      resolveMatchAt(lane, index, true);
    }
  }

  // 複数の run(昇順の [i0,j0],[i1,j1],...)を1レーンから安全に消す。
  // かつては run ごとに destroyRange → joinAt を回していたが、joinAt の連鎖
  // (resolveMatchAt → popRun)が下位インデックスの玉まで splice して、
  // まだ消していない run のインデックスを壊すバグがあった。
  // 3フェーズに分けて直す: (1) 各 run の補給側の隣を「参照」で記録、
  // (2) 全 run を後ろから destroyRange のみで消す(純粋な splice で連鎖しない)、
  // (3) splice が全て終わってから、参照を indexOf で引き直して連鎖判定する
  // (powerups.js の popRuns と同じパターン)。
  function destroyRunsSafely(lane, runs) {
    var balls = lane.balls, total = 0, joinRefs = [], r;
    for (r = 0; r < runs.length; r++) {
      var after = balls[runs[r][1] + 1];
      if (after) joinRefs.push(after);   // 次の run に含まれていれば後で indexOf < 0 になる
    }
    for (r = runs.length - 1; r >= 0; r--) {
      total += destroyRange(lane, runs[r][0], runs[r][1]);
    }
    for (r = 0; r < joinRefs.length; r++) {
      var idx = balls.indexOf(joinRefs[r]);
      if (idx > 0 &&
          balls[idx].color !== null && balls[idx].color !== undefined &&
          balls[idx - 1].color === balls[idx].color &&
          balls[idx - 1].d - balls[idx].d <= D + 1) {
        resolveMatchAt(lane, idx, true);   // 連鎖コンボ。splice 完了後なので安全
      }
    }
    return total;
  }

  // 爆弾の着弾: (x, y) を中心に BOMB_RADIUS 内の玉を全レーンから吹き飛ばす。
  // 判定は画面上の実距離(レール距離ではない)。宝玉は巻き込まない。
  function explodeAt(x, y) {
    var g = PP.game;
    // 【強化】「大口径火薬」で爆風が広がる。演出も RAD 基準にして、
    // 見た目の火球と実際に消える範囲が一致し続けるようにする
    var RAD = PP.BOMB_RADIUS * PP.upgrades.val("bombradius");
    var R2 = RAD * RAD;
    var total = 0;
    g.eachLane(function (lane) {
      var balls = lane.balls, runs = [];
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        if (b.treasure) continue;
        var p = lane.rail.posAt(b.d);
        var dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy > R2) continue;
        var lastRun = runs[runs.length - 1];
        if (lastRun && lastRun[1] === i - 1) lastRun[1] = i;
        else runs.push([i, i]);
      }
      if (runs.length) total += destroyRunsSafely(lane, runs);
    });

    // 大爆発の演出(空振りでも起爆はしている)。
    // 白熱の芯 → 赤い火球 → 三重の衝撃波リング、と内から外へ重ねて
    // 「火薬が破裂した」迫力を出す。色は火球らしい赤系でまとめる。
    PP.fx.flash(x, y, "rgba(255,255,240,1)", RAD * 0.5);   // 白熱の芯
    PP.fx.flash(x, y, "rgba(255,90,40,0.95)", RAD * 1.3); // 赤い火球
    PP.fx.ring(x, y, "#ffb08a", 10, RAD * 1.7, 560);
    PP.fx.ring(x, y, "#ff5a3c", 14, RAD * 1.25, 420);
    PP.fx.ring(x, y, "#e01810", 8, RAD * 0.8, 300);
    // 火の粉の飛距離は爆風半径に連動させる(半径 = 玉2個ぶんのとき spread 1)
    var spread = RAD / (PP.D * 2);
    PP.fx.burst(x, y, "#ff6a4a", 55, spread);
    PP.fx.burst(x, y, "#e01810", 40, spread);
    PP.fx.burst(x, y, "#ffd27a", 24, spread);   // 火の粉の混ざり
    PP.fx.shake(80,2);
    PP.audio.explode();

    if (total > 0) {
      var points = total * PP.BOMB_SCORE;
      g.score += points;
      PP.fx.floatText("+" + points, x, y - 30, "#ff8a6a", 26);
      PP.hud.update();
    }
  }

  // 【新】虹玉(万能玉)の炸裂: 着弾した玉を中心に「接触している連なり」を
  // 色に関係なく最大 PP.WILD.blastCap 個まで巻き込んで消す(マッチ判定は通さない)。
  // 宝玉は境界: 巻き込まず、そこで連なりを打ち切る(お宝は守られる)。
  // 骸骨玉の撃破報酬は destroyRange が一手に引き受ける。
  // 消した跡の前後が同色接触なら joinAt が連鎖(chained)へ発展させる。
  function wildBlast(lane, sh, hitIndex) {
    var balls = lane.balls;
    if (hitIndex < 0 || hitIndex >= balls.length) return;
    var i = hitIndex, j = hitIndex;
    // 接触している連なりを前後へ拡張(balls は先頭=樽側が d 大、後方ほど d 小)
    while (i > 0 && !balls[i - 1].treasure &&
           balls[i - 1].d - balls[i].d <= D + 1) i--;
    while (j + 1 < balls.length && !balls[j + 1].treasure &&
           balls[j].d - balls[j + 1].d <= D + 1) j++;
    // 上限: 着弾点を中心に、遠い側から削って blastCap 個に収める
    while (j - i + 1 > PP.WILD.blastCap) {
      if (hitIndex - i > j - hitIndex) i++; else j--;
    }
    var g = PP.game;
    var n = j - i + 1;
    // コンボ規約は popRun と同じ: 窓が生きていれば積む、切れていれば1から
    g.combo = g.comboTimer > 0 ? g.combo + 1 : 1;
    g.comboTimer = PP.COMBO_WINDOW * PP.upgrades.val("combo");
    var points = n * PP.WILD.scorePerBall * g.combo;
    g.score += points;
    var mp = lane.rail.posAt(balls[hitIndex].d);
    // 大技の演出: 虹の閃光 + 二重リング + 大量の火花 + 揺れ + 炸裂音
    PP.fx.screenFlash("rgba(142,240,208,0.30)", 0.30, 320);
    PP.fx.flash(mp.x, mp.y, "rgba(255,255,240,1)", 60);
    PP.fx.ring(mp.x, mp.y, "#8ef0d0", 10, 120, 420);
    PP.fx.ring(mp.x, mp.y, "#ffd24a", 6, 80, 320);
    PP.fx.burst(mp.x, mp.y, "#8ef0d0", 26, 2.0);
    PP.fx.burst(mp.x, mp.y, "#ffd24a", 14, 1.5);
    PP.fx.shake(Math.min(40, 10 + n * 2), 0.4);
    PP.audio.colorBomb();
    PP.fx.floatText("🌈 +" + points, mp.x, mp.y - 26, "#8ef0d0", 24);
    destroyRange(lane, i, j);
    PP.powerups.maybeDrop(mp.x, mp.y);
    PP.hud.update();
    joinAt(lane, i);
  }

  // ミサイルの貫通: x を中心とする幅 MISSILE_HIT_HALF*2 の縦回廊のうち、
  // このフレームで通過した区間 [yTop, yBottom](yTop = 進んだ後の y)に
  // かかる玉を全レーンから消す。スイープ判定なので高速でもすり抜けない。
  // 宝玉・洞窟内・トンネル内(隠れている)は対象外。消した数を返す。
  function pierceSegment(x, yTop, yBottom) {
    var g = PP.game;
    var H = PP.MISSILE_HIT_HALF;
    var total = 0, fxAt = null;
    g.eachLane(function (lane) {
      var balls = lane.balls, runs = [];
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        if (b.treasure) continue;
        if (b.d < PP.R) continue;              // まだ洞窟の中
        if (lane.rail.tunnelAt(b.d)) continue; // トンネル内=隠れている
        var p = lane.rail.posAtInto(b.d, _pos);
        if (Math.abs(p.x - x) >= H) continue;
        if (p.y > yBottom + H || p.y < yTop - H) continue;
        if (!fxAt) fxAt = { x: p.x, y: p.y };
        var lastRun = runs[runs.length - 1];
        if (lastRun && lastRun[1] === i - 1) lastRun[1] = i;
        else runs.push([i, i]);
      }
      if (runs.length) total += destroyRunsSafely(lane, runs);
    });
    if (total > 0) {
      var points = total * PP.MISSILE_SCORE;
      g.score += points;
      PP.fx.flash(x, fxAt.y, "rgba(255,255,240,1)", 55);
      PP.fx.flash(x, fxAt.y, "rgba(160,220,255,0.95)", 110);
      PP.fx.ring(x, fxAt.y, "#7ad9ff", 8, 90, 340);
      PP.fx.ring(x, fxAt.y, "#aee6ff", 14, 60, 260);
      PP.fx.burst(x, fxAt.y, "#aee6ff", Math.min(40, 10 + total * 4));
      PP.fx.burst(x, fxAt.y, "#7ad9ff", Math.min(20, 6 + total * 2), 1.4);
      // まとめて薙ぎ払ったときは画面全体が青白く明滅してボム級の手応えに
      if (total >= 4) PP.fx.screenFlash("rgba(160,220,255,1)", 0.28, 220);
      PP.audio.missileHit();
      PP.fx.floatText("+" + points, x, fxAt.y - 26, "#7ad9ff", 20);
      PP.hud.update();
    }
    return total;
  }

  // 発射玉をチェーンに割り込ませる(レーン lane)。
  // ※ 万能玉(wild)はここへ来ない: cannon.js が wildBlast へ振り分ける
  function insertShot(lane, sh, hitIndex) {
    var balls = lane.balls;
    var hit = balls[hitIndex];
    var p = lane.rail.posAt(hit.d);
    // レール接線との内積で、樽側(前)か補給側(後)かを決定
    var dot = (sh.x - p.x) * p.tx + (sh.y - p.y) * p.ty;
    var view = PP.ball.makeView(sh.color);
    PP.layers.ballUnder.addChild(view);   // 既定は下層。交差では描画側が上層へ移す
    var newBall = {
      color: sh.color, wave: hit.wave, view: view, pull: 0, slide: 0,
      ins: { x: sh.x, y: sh.y, t: PP.INSERT_TIME }
    };
    var at;
    if (dot > 0) {
      newBall.d = hit.d + D;              // 前に割り込み(前方を押し出す)
      at = hitIndex;
    } else {
      newBall.d = hit.d;                  // 後ろに割り込み(hit 以前を押し出す)
      at = hitIndex + 1;
    }
    balls.splice(at, 0, newBall);
    PP.game.ballsDirty = true;
    PP.game.colorsDirty = true;   // 玉が増えた → 装填色の見張りを回す
    PP.audio.hit();
    // 重なりを前方へ押し出して解消(表示は slide で滑らかに開く)
    relax(lane, true);
    // 割り込みアニメが終わってからマッチ判定
    lane.pendingMatches.push({ ball: newBall, t: PP.INSERT_TIME });
  }

  // レーン上の全玉の色を差し替える(ボスの「運命のルーレット」)。宝玉は変えない。
  //   mode "spin"  … ルーレットの回転中。完全ランダムで目まぐるしく色が入れ替わる
  //                  (見た目だけの中間状態。すぐ次のステップで上書きされる)
  //   mode "final" … 確定。補給と同じ「塊生成ルール」(SPAWN_CLUSTER で直前の色を
  //                  引き継ぎ、SPAWN_RUN_MAX で塊を打ち切る)で並べ直すので、
  //                  シャッフル後も「同色の塊を狙って消す」ゲームがそのまま成立する。
  // view は同じ親・同じ重なり位置で作り直し、座標と表示状態を引き継ぐ
  function scrambleColors(mode) {
    var g = PP.game;
    var finalize = mode !== "spin";
    for (var li = 0; li < g.lanes.length; li++) {
      var balls = g.lanes[li].balls;
      var prev = -1, run = 0;
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        if (b.treasure || b.color === null || b.color === undefined) { prev = -1; run = 0; continue; }
        var c;
        if (finalize && prev >= 0 && run < PP.SPAWN_RUN_MAX && Math.random() < PP.SPAWN_CLUSTER) {
          c = prev;              // 補給と同じ確率で塊を続ける
        } else {
          c = Math.floor(Math.random() * g.nColors);
        }
        run = (c === prev) ? run + 1 : 1;
        prev = c;
        if (c === b.color) continue;   // 同色なら差し替えを省く
        b.color = c;
        // view はそのままに共有 canvas だけ貼り替える(ルーレットの回転中は
        // 0.12秒ごとに全玉が変わるので、作り直すと 1 秒間に数百個の
        // DisplayObject 生成+レイヤー全積み直しになり大きなカクつきになる)
        if (!PP.ball.recolorView(b.view, c)) {
          // makeView 製でない view だけ従来どおり作り直す(通常は通らない)
          var old = b.view;
          var view = PP.ball.makeView(c);
          view.x = old.x; view.y = old.y;
          view.visible = old.visible;
          if (old.parent) {
            old.parent.addChildAt(view, old.parent.getChildIndex(old));
            old.parent.removeChild(old);
          } else {
            PP.layers.ballUnder.addChild(view);
          }
          b.view = view;
          g.ballsDirty = true;   // view を差し替えた時だけ重なり順を積み直す
        }
      }
    }
    g.colorsDirty = true;   // 盤面の色構成が変わった → 装填色の見張りを回す
  }

  PP.chain = {
    update: update,
    resetWind: resetWind,
    startWave: startWave,
    scrambleColors: scrambleColors,
    clearTreasures: clearTreasures,
    treasureList: treasureList,
    // 公開系はレーンを受け取り、そのまま内部処理へ渡す
    resolveMatchAt: resolveMatchAt,
    popRun: popRun,
    destroySingle: destroySingle,
    explodeAt: explodeAt,
    wildBlast: wildBlast,
    pierceSegment: pierceSegment,
    insertShot: insertShot,
    speedAt: speedAt
  };
})();
