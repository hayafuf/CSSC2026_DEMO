/* =========================================================
 * gale.js — 横風(難易度「深海の悪魔+風」)
 *
 * 大砲から撃った玉が、横向きの風に流されて左右へ曲がる。風は
 *   ・向き(左 / 右)と強さ(風速 m/s = PP.GALE.strengthMin〜strengthMax の整数、
 *     または calmChance の確率で 0 = 凪。弱い風は出さない)を持ち、
 *   ・数秒ごと(PP.GALE.periodMin〜periodMax)に変わり、
 *   ・変わる PP.GALE.warn 秒前に「次の風」が決まって予兆が出る: 予告の SE が
 *     noticeCount 回(既定 3 回)鳴り、HUD の WIND 欄が脈打つ。変わった瞬間に別の SE が 1 回。
 *   ・切り替わりは PP.GALE.ramp 秒かけて滑らかに補間する
 *     (HUD の表示は先に変わり、弾の曲がりは少し遅れて追いつく=読める猶予を作る)。
 * 強さは名前の表を持たず、乱数で引いた整数をそのまま HUD に出す。
 * 横加速度 = 強さ × PP.GALE.accelPer。
 *
 * このファイルが持つのは「いまの風」の状態機械だけ。弾を実際に曲げるのは
 * cannon.js の stepShots(accel() を横加速度として積分)、🔭 の曲線予測も cannon.js、
 * HUD の WIND 欄は hud.js(info() を読む)、解禁とボタンは config.js / input.js が担当する。
 *
 * 名前について: 既存の「風」= 引き潮(PP.REVERSE_*、chain.js の resetWind、
 * PP.audio.wind)はチェーンを押し戻す別の仕組みなので、こちらは gale で統一。
 *
 * 数値はすべて config.js の PP.GALE(教材のチューニング表と同じ流儀)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var G = PP.GALE;

  // ---- 状態 ----
  var strength = 0, dir = 0;     // 目標の風: 強さ(整数 m/s。0 = 凪) / 向き -1(左) +1(右) 0(凪)
  var cur = 0;                   // いま弾に効いている横加速度 px/s²(補間中の値)
  var from = 0, target = 0, rampT = 1;   // 補間の始点・終点・進み(0→1)
  var timer = 0;                 // 次の風に変わるまでの秒
  var pending = null;            // 予兆中の「次の風」{dir, strength}(warn 秒前に決まる)
  var noticeT = 0, noticeN = 0;  // 予告音: 予兆開始からの経過秒と、鳴らした回数
  var forced = false;            // force() 中は自動で切り替えない(検証用)
  var streakAcc = 0;             // 風の筋のスポーン蓄積(小数の本数/秒を整数に均す)

  // この難易度に風があるか(config.js の DIFFICULTY[...].gale)
  function active() { return !!PP.diff().gale; }

  // 強さと向きから横加速度へ(ボス海域は倍率を掛ける)
  function accelOf(d, s) { return d * s * G.accelPer * (PP.game.bossMode ? G.bossMult : 1); }

  // 次の風を決める(まだ適用しない)。calmChance で凪(0 m/s、向き無し)、それ以外は
  // min〜max の一様乱数の整数(弱い風は範囲から外してある)。
  // 今とまったく同じ風は 3 回まで引き直す(変わったのに何も起きない肩透かしを減らす)
  function decideNext() {
    var s, d, tries = 0;
    do {
      if (Math.random() < G.calmChance) {
        s = 0; d = 0;
      } else {
        s = G.strengthMin + Math.floor(Math.random() * (G.strengthMax - G.strengthMin + 1));
        d = Math.random() < 0.5 ? -1 : 1;
      }
    } while (s === strength && d === dir && ++tries < 3);
    return { dir: d, strength: s };
  }

  // 予告音: 予兆の間、noticeGap 秒おきに noticeCount 回鳴らす。setTimeout ではなく
  // update の経過秒で鳴らすので、ポーズ中は予告も止まる(再開後に続きが鳴る)
  function tickNotice(dt) {
    noticeT += dt;
    while (noticeN < G.noticeCount && noticeT >= noticeN * G.noticeGap) {
      noticeN++;
      PP.audio.galeNotice();
    }
  }

  // 風の目標を差し替える(補間はここから ramp 秒)。切り替わりの SE と、強い風なら文言も
  function setTarget(d, s) {
    dir = d; strength = s;
    from = cur; rampT = 0;
    target = accelOf(d, s);
    PP.audio.galeChanged();
    // 強い風は砲の上にも一言(向きと数値)
    if (s >= G.announceFrom && PP.cannon) {
      PP.fx.floatText((d < 0 ? "◀ " : "") + "WIND " + s + " m/s" + (d > 0 ? " ▶" : ""),
        PP.cannon.x, PP.cannon.y - 150, "#bfe3ff", 20);
    }
  }

  // レベル開始・リトライで仕切り直す(main.js の startLevel が呼ぶ)。
  // 風は常に吹いているので、開始の瞬間から最初の風(補間なし・音なし)を立てる
  function reset() {
    var first = decideNext();
    dir = first.dir; strength = first.strength;
    cur = from = target = accelOf(dir, strength);
    rampT = 1;
    timer = G.periodMin + Math.random() * (G.periodMax - G.periodMin);
    pending = null; forced = false; streakAcc = 0;
    noticeT = 0; noticeN = 0;
  }

  // 毎フレーム(main.js の tick、playing 中だけ)
  function update(dt) {
    if (rampT < 1) {
      rampT = Math.min(1, rampT + dt / G.ramp);
      var e = rampT * rampT * (3 - 2 * rampT);   // smoothstep: 立ち上がりと収束が滑らか
      cur = from + (target - from) * e;
    }
    if (!forced) {
      timer -= dt;
      if (!pending && timer <= G.warn) {
        pending = decideNext();
        noticeT = 0; noticeN = 0;   // 予告音はここから鳴り始める(1回目は即)
      }
      if (pending) tickNotice(dt);
      if (timer <= 0) {
        setTarget(pending.dir, pending.strength);
        pending = null;
        timer = G.periodMin + Math.random() * (G.periodMax - G.periodMin);
      }
    }
    spawnStreaks(dt);
  }

  // 画面を横切る風の筋。強いほど本数が増える(凪は無し)。fx のプール経由なので生成ゼロ
  function spawnStreaks(dt) {
    if (!dir) return;
    var per = strength * G.streaks.perStrength;
    if (PP.fx.particleLoad() > 0.7) per *= 0.5;   // 連鎖の大量パーティクル中は控える
    streakAcc += per * dt;
    while (streakAcc >= 1) {
      streakAcc -= 1;
      var y = 80 + Math.random() * 520;                 // HUD の下〜砲の上
      var len = G.streaks.len * (0.7 + Math.random() * 0.6);
      var x0 = Math.random() * PP.W;
      // 細長い楕円(半径 4.5 の焼き込み円を横に伸ばす)が風下へ流れて薄れる
      PP.fx.drift(x0, y, x0 + dir * len * 2.5, y, "rgba(200,225,255,0.55)",
        len / 9, 0.35, G.streaks.dur * (0.8 + Math.random() * 0.4));
    }
  }

  // いま弾に効く横加速度 px/s²(風の無い難易度では常に 0 = 他モジュールの分岐がここで閉じる)
  function accel() { return active() ? cur : 0; }

  // HUD・検証用の観測口。dir/strength は目標、cur は補間中の実効値、frac は補間の進み、
  // pending は予兆中の次の風(無ければ null)、warn は予兆の進み 0→1(予兆中でなければ 0)
  function info() {
    return {
      dir: dir, strength: strength, cur: cur, target: target, frac: rampT,
      pending: pending,
      warn: pending ? 1 - Math.max(0, timer) / G.warn : 0
    };
  }

  // 検証用: 風を固定する(PP.boss.forceAttack と同じ流儀)。hold 秒後に自動へ戻る
  // (省略時はレベルが変わるまで固定)。補間も飛ばして即その風にする
  function force(d, s, hold) {
    forced = true;
    pending = null;
    setTarget(d, s);
    cur = target; rampT = 1;
    timer = hold || 1e9;
    if (hold) forced = false;
  }

  PP.gale = { active: active, reset: reset, update: update, accel: accel, info: info, force: force };
})();
