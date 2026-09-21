/* chain-view.js — レール距離から玉の表示位置と描画順を決める。
 * 玉の移動・消去判定は行わない。橋・トンネル・樽への沈み込みを描く。 */
(function () {
  "use strict";
  var PP = window.PP;

  var _pos = { x: 0, y: 0, tx: 0, ty: 0 };
  var SINK = PP.D * (PP.BARREL_CAPACITY + 1);
  var showSpin = true;   // 回転レイヤーを見せるか(renderChains が毎フレーム更新)
  function placeBall(b, rail) {
    // slide: 割り込みで押し広げられた分を遅れて追従。ins: 着弾点から枠へ滑り込む
    var vd = b.d + (b.slide || 0);
    var p = rail.posAtInto(Math.max(vd, 0), _pos);
    var vx = p.x, vy = p.y;
    if (b.ins) {
      var k = 1 - b.ins.t / PP.INSERT_TIME;
      k = 1 - (1 - k) * (1 - k);           // quadOut
      vx = b.ins.x + (p.x - b.ins.x) * k;
      vy = b.ins.y + (p.y - b.ins.y) * k;
      b.view.scaleX = b.view.scaleY = 1 + 0.3 * (1 - k);
    }
    // 樽に飲み込まれた分だけ小さく暗く沈める
    var depth = b.d - rail.holeD;
    if (depth > 0) {
      var t = Math.min(depth / SINK, 1);
      b.view.scaleX = b.view.scaleY = 1 - 0.45 * t;
      b.view.alpha = 1 - 0.45 * t;
    } else if (!b.ins && b.view.alpha !== 1) {
      b.view.scaleX = b.view.scaleY = 1;
      b.view.alpha = 1;
    }
    b.view.x = vx;
    b.view.y = vy;
    // 回転レイヤー(塗装の合わせ目)は低負荷モードでは隠す: 玉200個で描画
    // コールが 600→400 になる。base+shade は残すので立体感は保たれる。
    // visible をここで毎フレーム同期するので、auto の途中切替・プール再利用・
    // ユーザー設定変更のどの経路でも自動で追従する(大砲の装填玉は placeBall を
    // 通らないが 2〜3 個なので対象外)
    if (b.view.spin) {
      if (b.view.spin.visible !== showSpin) b.view.spin.visible = showSpin;
      if (showSpin) b.view.spin.rotation = vd * PP.SPIN_K;
    }
    // 洞窟の外側だけ非表示にする。トンネル内の玉は描画したままにする:
    // 覆い(tunnel 層は玉より上)が不透明なので自然に隠れ、覆いに開けた
    // 舷窓の穴からだけ覗く(撃てない判定は cannon.js が rail.tunnelAt で行う)。
    b.view.visible = vd > -PP.R;
    return vd;
  }

  // チェーンの描画反映(全レーンの玉を各レールへ配置。宝玉も同じ列の一員)。
  // 立体交差コースでは玉が橋の上下(ballOver/ballUnder)を行き来する。
  //
  // 各層の正しい並び(=かつての「毎フレーム全積み直し」が作っていた順)は
  // 「レーン番号昇順 → そのレーンの balls 添字昇順」のうち、その層に属する玉。
  // 全積み直しは 150 玉規模の removeAllChildren+addChild で、コース5(交差5か所
  // ×4レーン)では毎フレーム走って StageGL のバッチ再構築を誘発していた。
  // いまは配置ループが正準順の走査そのものであることを利用し、「層をまたいだ玉
  // だけを、正準順で直前に処理した同じ層の玉(last)の直後へ挿し込む」差分更新に
  // している。挿入位置を last からの相対で決めるのは、消滅 Tween 中の view
  // (balls からは消えたが縮小アニメの間レイヤーに残る)が children に混ざって
  // いても成立させるため — 添字を自前で数える方式はこの「ゾンビ」で必ずズレる。
  // 通常フレームは挿入ゼロ=children を一切触らない。
  function renderChains() {
    var g = PP.game;
    var lanes = g.lanes;
    // 低負荷モードなら回転レイヤーを隠す(placeBall で毎フレーム同期)
    showSpin = PP.quality !== 0 || PP.PERF.LOW.ballSpin !== false;
    var canRestack = g.state === "playing" && g.hasOverpass;
    // 差分更新は「前フレームの並びが正準」という前提の上に立つ。view の作り直し
    // など前提が崩れたとき(ballsDirty)だけ、従来どおりの全積み直しで並びを
    // 作り直してから差分更新へ戻る
    var incremental = canRestack && !g.ballsDirty;
    var lastUnder = null, lastOver = null;   // 正準順で直前に処理した各層の view
    var li, bi, lane, balls, b, vd, target, last;

    // 配置しつつ、各玉の行き先レイヤーを判定する。
    // 立体交差:「上に来る帯」の玉は橋の桁より上(ballOver)、それ以外は下(ballUnder)。
    // 判定は玉半径ぶん広げた区間で行う。区間をそのまま使うと、玉の中心が橋の端を
    // 越えた瞬間に下の層へ落ちて、まだ桁に乗っている前半分が桁に欠かれてしまう。
    for (li = 0; li < lanes.length; li++) {
      lane = lanes[li]; balls = lane.balls;
      for (bi = 0; bi < balls.length; bi++) {
        b = balls[bi];
        vd = placeBall(b, lane.rail);
        target = lane.rail.heightAt(vd, PP.R) > 0 ? PP.layers.ballOver : PP.layers.ballUnder;
        b.layer = target;
        if (incremental) {
          // 層をまたいだ玉と湧いたばかりの玉(親なし)だけを正しい位置へ。
          // addChildAt は旧親から自動で外すので、移動はこの1呼び出しで済む
          if (b.view.parent !== target) {
            last = target === PP.layers.ballOver ? lastOver : lastUnder;
            target.addChildAt(b.view, last ? target.getChildIndex(last) + 1 : 0);
          }
          if (target === PP.layers.ballOver) lastOver = b.view;
          else lastUnder = b.view;
        }
      }
    }

    if (canRestack) {
      if (g.ballsDirty) {
        // 全積み直し(正準順を作り直す)。宝玉の追加や view の差し替えなど、
        // まれなイベントのフレームしか通らない
        PP.layers.ballUnder.removeAllChildren();
        PP.layers.ballOver.removeAllChildren();
        for (li = 0; li < lanes.length; li++) {
          balls = lanes[li].balls;
          for (bi = 0; bi < balls.length; bi++) balls[bi].layer.addChild(balls[bi].view);
        }
        g.ballsDirty = false;
      }
    } else {
      // 交差なし/プレイ外は従来どおり必要な玉だけ移す(addChild は末尾追加なので
      // 並びが乱れうる。次にプレイ中の積み直しへ入ったとき直せるよう dirty を立てる)
      for (li = 0; li < lanes.length; li++) {
        balls = lanes[li].balls;
        for (bi = 0; bi < balls.length; bi++) {
          b = balls[bi];
          if (b.view.parent !== b.layer) { b.layer.addChild(b.view); g.ballsDirty = true; }
        }
      }
    }
  }


  PP.chainView = { render: renderChains };
})();
