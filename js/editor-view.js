/* editor-view.js — エディタのプレビュー描画。
 * WebGLでは表示領域だけをキャッシュする。編集・カメラ操作時に更新する。 */
(function () {
  "use strict";
  var PP = window.PP;
  PP.createEditorView = function (ED, model, options) {
    var MARGIN = options.margin, GRID = options.grid;
    var commitCtrl = model.commitCtrl, currentCourse = model.currentCourse;
    var activeLane = model.activeLane;
    var cachePending = false;
    function scheduleCache() {
      if (!PP.glActive || cachePending) return;
      cachePending = true;
      requestAnimationFrame(function () {
        cachePending = false;
        if (ED.active && ED.container) ED.container.cache(0, 0, PP.W, PP.H);
      });
    }

    // ---------- 描画 ----------
    // グリッド・レール線・洞窟/樽マーカー・遊べる領域の枠・選択枠を preview へ描く
    function redrawPreview() {
      scheduleCache();
      var g = ED.preview.graphics.clear();

      // 画面(0..W,0..H)の内側を少し明るく、外側は「画面外(のりしろ)」として暗いまま。
      // 内側を塗ることで、どこがゲーム画面に映る範囲かひと目で分かる。
      g.beginFill("rgba(20,32,48,0.55)").drawRect(0, 0, PP.W, PP.H).endFill();

      if (ED.snap) drawGrid(g);

      // 画面のふち。この外側は画面外=洞窟(始点)を置くと玉がここから流れ込む。
      g.setStrokeStyle(2).beginStroke("rgba(120,180,255,0.85)")
        .drawRect(0, 0, PP.W, PP.H).endStroke();

      // 遊べる領域の目安枠
      g.setStrokeStyle(1).beginStroke("rgba(240,192,64,0.25)")
        .drawRect(40, 50, PP.W - 80, PP.CANNON_Y - 52 - 50).endStroke();

      // 3分割ガイド(三分割法)。左右・上下を3等分する目安線。
      g.setStrokeStyle(1 / ED.camScale).beginStroke("rgba(160,255,200,0.26)");
      g.moveTo(PP.W / 3, 0); g.lineTo(PP.W / 3, PP.H);
      g.moveTo(PP.W * 2 / 3, 0); g.lineTo(PP.W * 2 / 3, PP.H);
      g.moveTo(0, PP.H / 3); g.lineTo(PP.W, PP.H / 3);
      g.moveTo(0, PP.H * 2 / 3); g.lineTo(PP.W, PP.H * 2 / 3);
      g.endStroke();

      // 画面中心の十字線(縦=X の中央 / 横=Y の中央)。左右・上下対称に置く目安。
      // 線幅は縮尺で割り、拡大率によらず画面上でほぼ一定の細さにする。
      g.setStrokeStyle(1.5 / ED.camScale).beginStroke("rgba(120,210,255,0.5)");
      g.moveTo(PP.W / 2, 0); g.lineTo(PP.W / 2, PP.H);
      g.moveTo(0, PP.H / 2); g.lineTo(PP.W, PP.H / 2);
      g.endStroke();

      // レーンを描く。編集中でない(他の)レーンは細い薄線でうっすら見せ、
      // 編集中レーンは従来どおり太いレール+矢印+洞窟/樽+トンネル/橋の帯で描く。
      commitCtrl();
      var course = currentCourse().toCourse();
      for (var li = 0; li < ED.lanes.length; li++) {
        if (ED.lanes[li].ctrl.length < 2) continue;
        var active = li === ED.laneIdx;
        var pl = PP.rail.measure(course, li);
        if (!active) {
          // 他レーン: 細い薄線 + 始点/終点の小さな目印だけ
          g.setStrokeStyle(2 / ED.camScale).beginStroke("rgba(160,190,220,0.35)");
          g.moveTo(pl.xs[0], pl.ys[0]);
          for (var j = 1; j < pl.xs.length; j++) g.lineTo(pl.xs[j], pl.ys[j]);
          g.endStroke();
          drawSpans(g, pl, ED.lanes[li].tunnels, "rgba(20,14,7,0.35)");
          drawSpans(g, pl, ED.lanes[li].raised, "rgba(120,180,255,0.28)");
          // 始点の小さな緑丸。塗りは必ず endFill で閉じる。閉じないと EaselJS では
          // この緑塗りが次に描くレーンのレール折れ線へ流れ込み、レールが緑に塗られる。
          g.beginFill("rgba(77,220,85,0.5)").drawCircle(pl.xs[0], pl.ys[0], PP.R * 0.6).endFill();
          continue;
        }
        // 編集中レーンのレール本体
        g.setStrokeStyle(PP.R * 2, "round", "round").beginStroke("rgba(0,0,0,0.35)");
        g.moveTo(pl.xs[0], pl.ys[0]);
        for (var i = 1; i < pl.xs.length; i++) g.lineTo(pl.xs[i], pl.ys[i]);
        g.endStroke();
        g.setStrokeStyle(2).beginStroke("rgba(240,230,200,0.7)");
        g.moveTo(pl.xs[0], pl.ys[0]);
        for (i = 1; i < pl.xs.length; i++) g.lineTo(pl.xs[i], pl.ys[i]);
        g.endStroke();
        // トンネル(暗い帯)と橋 raised(明るい青の帯)を重ねる
        drawSpans(g, pl, activeLane().tunnels, "rgba(20,14,7,0.62)");
        drawSpans(g, pl, activeLane().raised, "rgba(120,180,255,0.55)");
        // 2クリック中の1点目マーカー
        if (ED.spanStart !== null) {
          var sp0 = pl.xs.length ? posOnRail(pl, ED.spanStart) : null;
          if (sp0) {
            g.setStrokeStyle(2.5).beginStroke("#ffd24a").drawCircle(sp0.x, sp0.y, PP.R + 3).endStroke();
          }
        }
        // 進行方向の矢印(数個)
        for (var f = 0.15; f < 1; f += 0.35) {
          var d = pl.length * f, a = idxAt(pl.cum, d);
          var dx = pl.xs[a + 1] - pl.xs[a], dy = pl.ys[a + 1] - pl.ys[a];
          var L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
          var x = pl.xs[a], y = pl.ys[a];
          g.beginFill("#f0c040").moveTo(x + dx * 10, y + dy * 10)
            .lineTo(x - dy * 6, y + dx * 6).lineTo(x + dy * 6, y - dx * 6).closePath();
        }
        // 洞窟(始点)と樽(終点)
        var s = ED.ctrl[0], e2 = ED.ctrl[ED.ctrl.length - 1];
        g.beginFill("rgba(0,0,0,0.7)").drawCircle(s[0], s[1], PP.R + 6).endFill();
        g.setStrokeStyle(3).beginStroke("#5c3d1f").drawCircle(s[0], s[1], PP.R + 6).endStroke();
        // 樽(終点)。塗りを閉じて、後続レーンのレール線へ茶色が流れ込むのを防ぐ。
        g.beginFill("rgba(150,90,40,0.9)").drawCircle(e2[0], e2[1], PP.R + 4).endFill();
      }

      // 選択中の点を黄色い輪で強調(ハンドルより一回り大きく描く)
      if (ED.sel >= 0 && ED.sel < ED.ctrl.length) {
        var sp = ED.ctrl[ED.sel];
        g.setStrokeStyle(3).beginStroke("#ffd24a").drawCircle(sp[0], sp[1], 15).endStroke();
      }

      // スマートガイド(他の点と X/Y が揃ったときのピンクの整列線)。
      // 線幅は縮尺で割って、拡大率によらず画面上でほぼ一定の細さにする。
      var gw = 1.5 / ED.camScale;
      if (ED.guideX !== null) {
        g.setStrokeStyle(gw).beginStroke("rgba(255,70,190,0.95)");
        g.moveTo(ED.guideX, -MARGIN); g.lineTo(ED.guideX, PP.H + MARGIN); g.endStroke();
      }
      if (ED.guideY !== null) {
        g.setStrokeStyle(gw).beginStroke("rgba(255,70,190,0.95)");
        g.moveTo(-MARGIN, ED.guideY); g.lineTo(PP.W + MARGIN, ED.guideY); g.endStroke();
      }
      // 等間隔ガイド(左右/上下の中間に吸着中)。両側の隙間が等しいことを、
      // ドラッグ中の点を挟む2つの区間へ水色の二重矢印(端キャップ付き線)で示す。
      if (ED.sel >= 0 && ED.sel < ED.ctrl.length) {
        var q = ED.ctrl[ED.sel];
        if (ED.eqX) { drawGapMark(g, ED.eqX.a, q[1], q[0], q[1]); drawGapMark(g, q[0], q[1], ED.eqX.b, q[1]); }
        if (ED.eqY) { drawGapMark(g, q[0], ED.eqY.a, q[0], q[1]); drawGapMark(g, q[0], q[1], q[0], ED.eqY.b); }
      }
    }
    // 等間隔を示す1区間の目印: (x1,y1)-(x2,y2) を結ぶ水色の線と、両端の短い直交キャップ。
    function drawGapMark(g, x1, y1, x2, y2) {
      var gw = 1.5 / ED.camScale, cap = 6 / ED.camScale;
      var dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
      var nx = -dy / L * cap, ny = dx / L * cap;   // 線に直交するキャップ方向
      g.setStrokeStyle(gw).beginStroke("rgba(90,230,255,0.95)");
      g.moveTo(x1, y1); g.lineTo(x2, y2);
      g.moveTo(x1 - nx, y1 - ny); g.lineTo(x1 + nx, y1 + ny);
      g.moveTo(x2 - nx, y2 - ny); g.lineTo(x2 + nx, y2 + ny);
      g.endStroke();
    }
    // タイル(玉の直径)間隔の方眼。縦横ともに GRID 間隔で引く。
    // 線幅は縮尺で割り、拡大率によらず画面上でほぼ一定の細さにする。
    function drawGrid(g) {
      g.setStrokeStyle(1 / ED.camScale).beginStroke("rgba(255,255,255,0.08)");
      for (var x = 0; x <= PP.W; x += GRID) { g.moveTo(x, 0); g.lineTo(x, PP.H); }
      for (var y = 0; y <= PP.H; y += GRID) { g.moveTo(0, y); g.lineTo(PP.W, y); }
      g.endStroke();
    }
    function idxAt(cum, d) {
      var lo = 0, hi = cum.length - 1;
      while (lo + 1 < hi) { var m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      return lo;
    }
    // measure 済みの折れ線 pl 上の全長比 f(0..1)→ 座標 {x,y}。
    function posOnRail(pl, f) {
      var d = Math.max(0, Math.min(1, f)) * pl.length;
      var a = idxAt(pl.cum, d), seg = pl.cum[a + 1] - pl.cum[a] || 1;
      var t = (d - pl.cum[a]) / seg;
      return { x: pl.xs[a] + (pl.xs[a + 1] - pl.xs[a]) * t,
               y: pl.ys[a] + (pl.ys[a + 1] - pl.ys[a]) * t };
    }
    // 区間(tunnels/raised の {from,to} 配列)を、レール上に太い帯として描く。
    function drawSpans(g, pl, spans, color) {
      if (!spans || !spans.length) return;
      for (var i = 0; i < spans.length; i++) {
        var lo = Math.max(0, Math.min(1, spans[i].from)) * pl.length;
        var hi = Math.max(0, Math.min(1, spans[i].to)) * pl.length;
        if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
        var a = idxAt(pl.cum, lo), b = idxAt(pl.cum, hi);
        var p0 = posOnRail(pl, lo / pl.length);
        g.setStrokeStyle(PP.R * 2 + 4, "round", "round").beginStroke(color);
        g.moveTo(p0.x, p0.y);
        for (var k = a + 1; k <= b; k++) g.lineTo(pl.xs[k], pl.ys[k]);
        var p1 = posOnRail(pl, hi / pl.length);
        g.lineTo(p1.x, p1.y);
        g.endStroke();
      }
    }

    // 制御点のハンドル(番号つき)。挙動は現在モードで変わる:
    //   edit  … クリックで選択、ドラッグで移動
    //   erase … クリックでその点を削除
    //   insert… ハンドル上では何もしない(線側で挿入する)
    // ドラッグ中は preview だけ更新し、離した時に全体を組み直す
    // (ドラッグ中の shape を消さないため。選択枠は preview に描くので rebuild 不要)。

    return {
      redraw: redrawPreview,
      scheduleCache: scheduleCache
    };
  };
})();
