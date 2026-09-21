/* projectiles.js — 発射弾の移動と衝突。時間は秒、座標はpx。
 * PP.game.shotsを更新し、命中結果をchain/bossへ渡す。大砲の描画は持たない。 */
(function () {
  "use strict";
  var PP = window.PP;

  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };
  // updateShots の玉座標キャッシュ。中身は毎フレーム書き直すが、配列やレーン毎の
  // 入れ物はモジュールに置いて使い回す(弾が飛んでいる間の毎フレーム確保を無くす)。
  var _cache = [], _cacheN = 0, _overPts = [], _overN = 0;
  var _posDirty = true;   // 玉座標キャッシュの要更新フラグ(サブステップ間で持ち越す)

  // 発射玉の移動とチェーンへの命中判定(全レーン横断)。
  // dt が大きいフレーム(処理落ち等)では、弾が1フレームで当たり判定の半径を
  // 超えて動いてチェーンをすり抜けることがある(config.js の SHOT_SPEED_MAX の
  // 注釈参照)。そこで dt が大きいときは短い時間に等分して stepShots を複数回
  // 呼び、通常速度と同じ細かさで動かす。
  // 通常速度(60fps で dt ≈ 0.0167 秒)では従来どおり 1 回だけ呼ばれる。
  // ステップ数は 4 で頭打ちにする: 上限が無いと「重い → 分割数が増える →
  // さらに重い」の悪循環(処理落ちスパイラル)になる。上限後の 1 ステップは
  // 最悪でも dt/4 で、弾半径に対するすり抜け余裕は実用上足りる
  function updateShots(dt) {
    var steps = (dt > 0.02) ? Math.min(4, Math.ceil(dt / 0.0167)) : 1;
    // 横風中は横速度(最大 PP.GALE.maxLateral)が足されて 1 ステップの移動が当たり半径を
    // 超えうるので、通常速度でも最低 3 分割にしてすり抜けを防ぐ
    // ((2600 + 2000) / 180 ≈ 26px < 当たり半径 44px)
    if (PP.gale.accel() !== 0) steps = Math.max(steps, 3);
    var h = dt / steps;
    _posDirty = true;   // チェーンはフレーム間でしか進まないので、引き直しはフレームに1回
    for (var i = 0; i < steps; i++) stepShots(h);
  }
  // 玉の画面座標(と立体交差の上下・トンネルの内外)は d から一意に決まる。
  // 弾ごとに全玉ぶん引き直すと「弾数 × 玉数」になるので、盤面が変わらない限り
  // 玉あたり 1 回に集約する。割り込み/爆発で列が変わったら posDirty で作り直す。
  // (キャッシュ自体はサブステップをまたいで有効。updateShots がフレーム頭で dirty にする)
  // stepShots の中で定義していた頃は、呼ばれるたび(1 フレーム 1〜4 回)に
  // クロージャを 2 つ確保していたので、モジュールスコープへ巻き上げてある
  function refreshBallPos(lanes) {
    _overN = 0;   // 橋(上の帯)に乗っている玉の画面座標。下の玉の遮蔽判定に使う
    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      var balls = lane.balls;
      var c = _cache[li] ||
        (_cache[li] = { lane: null, balls: null, n: 0, bx: [], by: [], bover: [], btun: [] });
      c.lane = lane; c.balls = balls; c.n = balls.length;
      for (var k = 0; k < balls.length; k++) {
        var p = lane.rail.posAtInto(balls[k].d, _pos);
        c.bx[k] = p.x; c.by[k] = p.y;
        c.bover[k] = lane.rail.heightAt(balls[k].d) > 0;
        c.btun[k] = lane.rail.tunnelAt(balls[k].d);
        if (c.bover[k] && !c.btun[k] && balls[k].d >= PP.R) {
          _overPts[_overN++] = p.x; _overPts[_overN++] = p.y;
        }
      }
    }
    _cacheN = lanes.length;
    _posDirty = false;
  }

  // 下の帯の玉(ground)が、橋の桁の下に隠れているか。橋に乗っている玉の画面座標が
  // 近く(桁幅ぶん)にあれば、その地上玉は桁に覆われて見えない=撃てない。
  // 立体交差の無いコースでは overPts が空なので常に false。
  //
  // 半径は course-view.js の DECK_HALF(桁の視覚幅 = 片側 40px)と対にする。
  // ずれると「桁に隠れて見えないのに撃てる玉」が生まれ、見えている先の玉を
  // 狙った弾がその手前で止まる。桁の幅を変えるときは必ずここも動かすこと。
  var _OCCLUDE_R2 = 0;
  function occludedByDeck(x, y) {
    if (!_OCCLUDE_R2) _OCCLUDE_R2 = (PP.D * 0.85) * (PP.D * 0.85);
    for (var o = 0; o < _overN; o += 2) {
      var dx = x - _overPts[o], dy = y - _overPts[o + 1];
      if (dx * dx + dy * dy < _OCCLUDE_R2) return true;
    }
    return false;
  }

  function stepShots(dt) {
    var g = PP.game;
    var shots = g.shots;
    if (shots.length === 0) return;   // 弾が無いフレームは何もしない
    // 「時間の滞留」(ボスの妖弾・パワーダウン⏳): 発射玉の時間だけ極端に
    // 遅く流れる。弾の積分にだけ倍率を掛ける(チェーンや演出は通常速度のまま)。
    if (g.bossFx.shotSlow > 0) dt *= PP.BOSS.shotSlow.factor;
    var lanes = g.lanes;
    var R = PP.R, D = PP.D;

    for (var s = shots.length - 1; s >= 0; s--) {
      var sh = shots[s];

      // ミサイル: 等加速で真上へ直進し、通過した回廊上の玉を貫通して消す。
      // 速度に上限が無いので、1フレームの移動区間ごと当てるスイープ判定
      // (chain.pierceSegment)を使い、高速でもすり抜けないようにする。
      // 何かに当たっても止まらず、画面上端へ抜けたところで消える。
      if (sh.special === "missile") {
        var v0 = sh.spd;
        sh.spd += PP.MISSILE_ACCEL * dt;
        var yPrev = sh.y;
        sh.y -= (v0 + sh.spd) * 0.5 * dt;   // 等加速の厳密積分
        sh.view.y = sh.y;
        PP.fx.missileTrail(sh.x, sh.y + R, Math.min(140, (yPrev - sh.y) + 40),
          PP.MISSILE_HIT_HALF * 2);
        if (PP.fx.particleLoad() < 0.75) {
          PP.fx.burst(sh.x, sh.y + R * 1.2, "rgba(255,190,90,0.5)", 2);
        }
        var hits = PP.chain.pierceSegment(sh.x, sh.y, yPrev);
        if (hits > 0) {
          _posDirty = true;   // 列が変わった → 通常弾は座標を引き直す
          // 貫通のたびにボム級へ迫る強い揺れ(ボムの 80 は超えない)
          PP.fx.shake(Math.min(60, 12 + hits * 8), 0.5);
        }
        // ボス戦: ミサイルはボスも貫く(1発ぶんの無敵時間で多段ヒットは防ぐ)。
        // 高速なので今フレームの移動区間の中点でも判定してすり抜けを防ぐ
        if (g.bossMode &&
            (PP.boss.hitTest(sh.x, sh.y) || PP.boss.hitTest(sh.x, (sh.y + yPrev) / 2))) {
          PP.boss.onHit(PP.BOSS.dmg.missile, sh.x, sh.y);
        }
        if (sh.y < -R * 3) {
          if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
          PP.layers.shot.removeChild(sh.view);
          shots.splice(s, 1);
        }
        continue;   // 通常弾の加速・割り込み・命中ロジックには入らない
      }

      // 発射後は加速していく(等速直線をやめる)。真上固定なので速度ベクトルは
      // 向きを保ったまま増速し、SHOT_SPEED_MAX で頭打ちにする。
      var sp = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy);
      if (sp > 0 && sp < PP.SHOT_SPEED_MAX) {
        var nsp = Math.min(PP.SHOT_SPEED_MAX, sp + PP.SHOT_ACCEL * dt);
        sh.vx *= nsp / sp; sh.vy *= nsp / sp;
        sp = nsp;
      }
      // 横風(深海の悪魔+風): 風の加速度を「横速度 wx」として別勘定で積分する。
      // vx に混ぜると上の再正規化(nsp/sp 倍)で毎ステップ横成分が縮んでしまうため。
      // 通常弾・万能玉・爆弾に効く(ミサイルは上の分岐で抜けているので受けない)
      var gax = PP.gale.accel();
      if (gax !== 0 || sh.wx !== 0) {
        sh.wx += gax * dt;
        var ml = PP.GALE.maxLateral;
        if (sh.wx > ml) sh.wx = ml; else if (sh.wx < -ml) sh.wx = -ml;
      }
      sh.x += (sh.vx + sh.wx) * dt;
      sh.y += sh.vy * dt;
      sh.roll += sp * dt;   // 転がりも実速度に追従させる
      sh.view.x = sh.x; sh.view.y = sh.y;
      sh.view.spin.rotation = -sh.roll * PP.SPIN_K;
      // ボス戦: 玉列の隙間を抜けて上まで届いた弾がクラーケンに当たる。
      // ボスの当たり判定はレーンよりほぼ上にあるので、チェーン判定より先で良い
      if (g.bossMode && PP.boss.hitTest(sh.x, sh.y)) {
        var bdmg = sh.special === "bomb" ? PP.BOSS.dmg.bomb : PP.BOSS.dmg.shot;
        if (sh.special === "bomb") {
          PP.chain.explodeAt(sh.x, sh.y);   // 爆風の演出ごと炸裂
          _posDirty = true;                 // 爆風で列が変わったかもしれない
        }
        PP.boss.onHit(bdmg, sh.x, sh.y);
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        continue;
      }
      // 画面外
      if (sh.x < -R * 2 || sh.x > PP.W + R * 2 || sh.y < -R * 2 || sh.y > PP.H + R * 2) {
        // 外した爆弾は不発のまま画面外へ
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        continue;
      }
      // チェーンとの衝突(全レーンで最近接の玉)。立体交差では、画面上で重なる
      // 上下の帯のうち「見えている上の帯」を優先する(スコアを少し下げて同点付近
      // で勝たせる)。トンネル内の玉(隠れている)は当たり判定から外す=撃てない。
      // 命中の可否判定そのものは実距離で行う。
      if (_posDirty) refreshBallPos(lanes);
      var bestLane = -1, bestI = -1, bestScore = Infinity, bestDist = Infinity;
      var OVER_BIAS = (D * 0.6) * (D * 0.6);
      // 命中に必要な距離²(下の判定と同じ値)。score は最悪でも dist - OVER_BIAS
      // なので、dist ≥ HIT_R2 + OVER_BIAS の玉は「命中し得る玉」(score < HIT_R2)
      // に絶対勝てない = 飛ばしても結果は変わらない。まず dy だけで粗く弾く。
      var HIT_R2 = (D * 0.92) * (D * 0.92);
      var SKIP_R2 = HIT_R2 + OVER_BIAS;
      for (var li = 0; li < _cacheN; li++) {
        var c = _cache[li];
        for (var i = 0; i < c.n; i++) {
          var dy = sh.y - c.by[i];
          if (dy * dy >= SKIP_R2) continue;   // 縦距離だけで既に候補外
          var b = c.balls[i];
          // 宝玉は割り込みの対象外。ただし爆弾は宝玉に当たっても起爆する
          if (b.treasure && sh.special !== "bomb") continue;
          if (b.d < R) continue;    // まだ洞窟の中
          if (c.btun[i]) continue;  // トンネル内=隠れていて撃てない
          var dx = sh.x - c.bx[i];
          var dist = dx * dx + dy * dy;
          if (dist >= SKIP_R2) continue;      // 実距離でも候補外(遮蔽判定より先に安く弾く)
          // 下の帯の玉が橋の桁の下に隠れているなら撃てない(見えている上の帯を撃つ)。
          // _overN=0(橋の玉が1個も無い=立体交差の無いコース)なら関数呼び出しごと省く
          if (_overN && !c.bover[i] && occludedByDeck(c.bx[i], c.by[i])) continue;
          var score = dist;
          if (c.bover[i]) score -= OVER_BIAS;
          if (score < bestScore) { bestScore = score; bestDist = dist; bestI = i; bestLane = li; }
        }
      }
      if (bestI >= 0 && bestDist < HIT_R2) {
        var hitLane = _cache[bestLane].lane;
        // 当たった玉のレール距離は割り込み/爆発の前に控える(c.balls は lane.balls の別名で、
        // insertShot の splice 後は bestI が別の玉を指す)。夜の「灯し直し」に使う
        var hitD = _cache[bestLane].balls[bestI].d;
        if (sh.special === "bomb") PP.chain.explodeAt(sh.x, sh.y);
        else if (sh.wild) PP.chain.wildBlast(hitLane, sh, bestI);   // 虹玉は炸裂(挿入しない)
        else PP.chain.insertShot(hitLane, sh, bestI);
        if (PP.night.active()) PP.night.onHit(sh.x, sh.y, hitLane, hitD);   // 夜: 残光+最寄りの灯りを灯し直す
        if (sh.view.spark) createjs.Tween.removeTweens(sh.view.spark);
        PP.layers.shot.removeChild(sh.view);
        shots.splice(s, 1);
        _posDirty = true;  // 割り込み/爆発で列が変わった → 次弾は座標を引き直す
      }
    }
  }


  PP.projectiles = { update: updateShots };
})();
