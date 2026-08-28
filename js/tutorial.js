/* =========================================================
 * tutorial.js — プレイ中チュートリアル(停止カード + ガイド + 文脈ヒント)
 *
 * 各ステップは2幕構成:
 *  【説明】ゲームを止め(チェーン凍結+暗転の帳)、羊皮紙カードで1つだけ教える。
 *          クリック/タップ(どのキーでも可)で続行。
 *  【実践】帳を薄く残したまま、実際にその操作をやらせる。狙う玉はハロで光らせ、
 *          大砲からはガイド線(照準ビーム)を立て、真下に合うとビームが緑になる。
 *
 * ステップ: ①移動 → ②3個消し(玉を光らせて狙わせる)→ ③交換 → ④万能玉(虹玉)
 *          → ⑤障害物(説明のみ)→ ⑥勝敗ルール(説明のみ)
 *
 * 設計の要点:
 *  - ゲーム状態は増やさない。state は "playing" のまま、
 *      a) chain.js の前進ゲートに chainHeld() … チェーン凍結
 *      b) main.js のゲージ減算に active() ガード … 時間も凍結
 *      c) input.js の modal() ガード … 説明中は盤面操作を止めて「続行」に読み替え
 *  - 暗転の帳・ハロ・ビームはキャンバス(stage 直下の最前面)に描く。
 *    【StageGL】非cacheのShapeはWebGLでは描かれない(upgrades.js の規約)ので、
 *    図形は必ず cache してから使う。
 *  - 文字(カード・バナー・トースト)は DOM。ポーズ中もキャンバスの再描画停止
 *    (main.js pauseDrawn)の影響を受けず、言語のキャッシュ制約もない。
 *  - 計時はすべて update(dt) 駆動(setTimeout 不使用)。ポーズすれば全部止まる。
 *  - ポーズ画面が帳の下に隠れないよう、pause.js が setShelved(true/false) を呼ぶ。
 *
 * ゲーム側からの呼び出しは全て if (PP.tut) ガード付き(PP.settings と同じ作法)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP = window.PP || {};

  var banner = document.getElementById("tutBanner");
  var toastEl = document.getElementById("tutToast");
  var card = document.getElementById("tutCard");
  if (!banner || !toastEl || !card) return;   // DOM が無い環境(テスト等)では何もしない

  // ---------- 進行状態 ----------
  var running = false;
  var phase = "idle";     // idle | wait | explain | action | gap
  var stepIdx = 0;
  var subIdx = 0;         // 「wild」の小目標(0=装填 → 1=発射)
  var gapT = 0;           // ✓ の余韻
  var waitT = 0;          // 「shoot」の的(2個並び)待ち
  var notifyGuardT = 0;   // 説明カードを閉じたクリックが操作として数わらないための猶予
  var moveAcc = 0;        // 「move」: 大砲の移動量の累積(px)
  var lastCx = null;
  var holdNow = false;    // 説明入りでチェーンを凍結したか
  var autoHold = false;   // 保険: 放置しても樽に届かないための自動凍結
  var forceNext = false;  // 設定からの再実行予約
  var bannerHideT = 0;
  var shelved = false;    // ポーズ画面に隠れないよう一時退避中か
  var tAnim = 0;          // ガイドの脈動用の累積時間

  // 「shoot」の的: { lane, refs:[ball...], color }
  var target = null;
  var aligned = false;
  var wildGranted = false;
  // 実演の状態: 「itemGood」「itemBad」は落としたアイテムの参照、「skull」は
  // 目覚めさせた骸骨玉 { ball, lane }。demoT は各実演の経過秒(保険のタイムアウト)
  var demoItem = null;
  var demoT = 0;
  var demoTries = 0;      // itemGood: コインを落とし直した回数(取り損ねたら1回だけ再挑戦)
  var coinsBefore = 0, livesBefore = 0;
  var demoSkull = null;
  var skullFired = false;
  var graceT = 0;         // 終了直後の猶予秒: 完了演出の間はチェーンを止めたままにする
  var GRACE_SEC = 2.0;

  // 終了(完走・スキップ)の共通後始末: 練習中に期限切れした次波の保険タイマーを
  // 満タンに戻し、少しの猶予を置いてから流れを再開する。
  // これが無いと「終わった瞬間に新しい波が来る」体験になる
  function releaseField() {
    if (PP.chain && PP.chain.resetWaveTimers) PP.chain.resetWaveTimers();
    graceT = GRACE_SEC;
  }

  var MOVE_GOAL = 150;    // 「動かせた」と認める移動量(px)
  var ALIGN_PX = 26;      // ビームが「いい位置」になる許容ズレ
  var GAP_SEC = 0.8;
  var WAIT_MAX = 6.0;     // 的待ちの上限(見つからなくても先へ進む)

  // 既読フラグはバージョン番号で持つ。チュートリアルを作り直したらここを上げる:
  // 旧版を見た(古い番号が保存されている)プレイヤーにも、新版が一度だけ出る
  var TUT_VER = 2;
  function seenVer() { return PP.store ? PP.store.get("tutorialVerSeen", 0) : TUT_VER; }
  function markSeen(v) { if (PP.store) PP.store.set("tutorialVerSeen", v); }

  // タイトル画面の 🎓 ON/OFF(hud.js のボタン)。明示的に切り替えるまでは
  // 「現バージョンをまだ見ていない = ON」。完走/スキップで OFF に戻るので、
  // もう一度見たいときはタイトルで ON にしてから出航する
  function enabled() {
    var v = PP.store ? PP.store.get("tutorialOn", null) : null;
    if (v === null || v === undefined) return seenVer() < TUT_VER;
    return !!v;
  }
  function setEnabled(f) { if (PP.store) PP.store.set("tutorialOn", !!f); }

  // key(): PP.TOUCH で「〜」「〜pc」を選ぶ(起動時に確定する定数なので安全)
  function dev(base) { return function () { return PP.TOUCH ? base : base + "pc"; }; }
  function fix(base) { return function () { return base; }; }

  var STEPS = [
    { id: "move", hold: false, et: "tut.e1t", eb: dev("tut.e1"), ab: dev("tut.a1"),
      glow: ["tLeft", "tRight"] },
    { id: "shoot", hold: true, need: "match", et: "tut.e2t", eb: dev("tut.e2"), ab: fix("tut.a2"),
      glow: ["tFire"] },
    { id: "swap", hold: true, need: "swap", et: "tut.e3t", eb: dev("tut.e3"), ab: dev("tut.a3"),
      glow: ["tSwap"] },
    { id: "wild", hold: true, needs: ["wild", "fire"], et: "tut.e4t", eb: dev("tut.e4"),
      ab: dev("tut.a4"), ab2: "tut.a4b", glow: ["tWild"], glow2: ["tFire"] },
    { id: "itemGood", hold: true, et: "tut.e5t", eb: fix("tut.e5"), ab: fix("tut.a5") },
    { id: "itemBad", hold: true, et: "tut.e6t", eb: fix("tut.e6"), ab: fix("tut.a6") },
    { id: "skull", hold: true, et: "tut.e7t", eb: fix("tut.e7"), ab: fix("tut.a7") },
    { id: "rules", hold: true, cardOnly: true, et: "tut.e8t", eb: fix("tut.e8") }
  ];

  // ---------- 文脈ヒント(初登場時のトースト) ----------
  var hintsSeen = (PP.store && PP.store.get("hintsSeen", {})) || {};
  var toastQueue = [];
  var toastT = 0;
  var toastFade = 0;
  var TOAST_SEC = 5.0;
  var HINTS = {
    item:     fix("tut.hItem"),
    down:     fix("tut.hDown"),
    treasure: fix("tut.hTreasure"),
    choice:   function () { return PP.TOUCH ? "tut.hChoice" : "tut.hChoicePc"; },
    special:  function () { return PP.TOUCH ? "tut.hSpecial" : "tut.hSpecialPc"; },
    parry:    function () { return PP.TOUCH ? "tut.hParry" : "tut.hParryPc"; },
    wild:     function () { return PP.TOUCH ? "tut.hWild" : "tut.hWildPc"; },
    coin:     fix("tut.hCoin"),
    boss:     fix("tut.hBoss")
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ========== キャンバスのガイド層(暗転の帳・ハロ・ビーム・矢印) ==========
  // 全図形は StageGL 対応のため cache 必須。層は stage 直下の最前面
  // (upgrades.js のカード3択と同じ流儀)。クリックは通す(mouseEnabled=false)。
  var layer = null;
  var veil, beamA, beamG, marker, arrowL, arrowR, cannonHalo, lead, leadDot;
  var halos = [];
  var LEAD_H = 64;   // 引き出し線の素の長さ(scaleY で伸ばす)
  var HALO_R = 26;
  var BEAM_H = 64;   // ビームの素の高さ(scaleY で伸ばす)
  var layerKillT = 0;

  function buildLayer() {
    if (layer) return;
    layer = new createjs.Container();
    layer.mouseEnabled = false;
    layer.mouseChildren = false;

    // 暗転の帳: 中央がわずかに明るい放射グラデ(upgrades.js の暗幕と同じ焼き方)。
    // 濃さは shape.alpha で操る(説明中 1.0 / 実践中 0.5 / 平常 0)
    veil = new createjs.Shape();
    veil.graphics.beginRadialGradientFill(
      ["rgba(8,12,20,0.60)", "rgba(2,4,8,0.76)"], [0, 1],
      PP.W / 2, PP.H / 2, 160, PP.W / 2, PP.H / 2, PP.W * 0.72)
      .drawRect(-140, -140, PP.W + 280, PP.H + 280);
    veil.cache(-140, -140, PP.W + 280, PP.H + 280, PP.PERF.VEIL_CACHE_SCALE);
    veil.alpha = 0;
    layer.addChild(veil);

    // 照準ビーム(大砲の真上に立てるガイド線)。琥珀=移動中 / 緑=いい位置。
    // 中心線+淡い光の帯。原点は下端中央、scaleY で的まで伸ばす
    beamA = makeBeam("rgba(255,210,74,", "#ffd24a");
    beamG = makeBeam("rgba(142,240,208,", "#8ef0d0");

    // 的の真上で跳ねる下向き矢印
    marker = new createjs.Shape();
    marker.graphics.beginFill("#ffd24a").moveTo(-13, -20).lineTo(13, -20).lineTo(0, 0)
      .closePath().beginStroke("rgba(0,0,0,0.5)").setStrokeStyle(2)
      .moveTo(-13, -20).lineTo(13, -20).lineTo(0, 0).closePath();
    marker.cache(-16, -24, 32, 28);
    marker.visible = false;
    layer.addChild(marker);

    // 「move」の左右矢印(大砲の両脇で外向きに揺れる)
    arrowL = makeSideArrow(-1);
    arrowR = makeSideArrow(1);

    // 大砲のスポットライト(移動の説明・交換ステップで脈動)
    cannonHalo = new createjs.Shape();
    cannonHalo.graphics.setStrokeStyle(4).beginStroke("#ffd24a").drawEllipse(-58, -30, 116, 78)
      .beginFill("rgba(255,210,74,0.10)").drawEllipse(-58, -30, 116, 78);
    cannonHalo.cache(-62, -34, 124, 86);
    cannonHalo.visible = false;
    layer.addChild(cannonHalo);

    // 光らせる玉のハロ(並びの全玉を光らせる。同色が長く続くこともあるので多めに)
    for (var i = 0; i < 8; i++) {
      var h = new createjs.Shape();
      h.visible = false;
      layer.addChild(h);
      halos.push(h);
    }

    // 糸(引き出し線): 札のピンから対象物へ。原点は始点、+y 方向に LEAD_H の長さで
    // 焼き、scaleY で伸ばして rotation で向ける。先端の輪は対象物の手前で止める
    lead = new createjs.Shape();
    lead.graphics.beginFill("rgba(0,0,0,0.35)").drawRect(-2.2, 0, 4.4, LEAD_H)   // 縁取り(暗い盤面でも糸が読める)
      .beginFill("rgba(255,224,150,0.92)").drawRect(-1, 0, 2, LEAD_H);
    lead.cache(-3, 0, 6, LEAD_H);
    lead.visible = false;
    layer.addChild(lead);
    // 先端: 対象物を囲む細い輪(ハロとは別物。「糸の先はこれ」を示す)
    leadDot = new createjs.Shape();
    leadDot.graphics.setStrokeStyle(2).beginStroke("rgba(255,224,150,0.95)").drawCircle(0, 0, 8)
      .beginFill("#ffe08a").drawCircle(0, 0, 2.2);
    leadDot.cache(-10, -10, 20, 20);
    leadDot.visible = false;
    layer.addChild(leadDot);
  }

  // 引き出し線を (ax, ay) → (tx, ty) に張る。対象物の手前 gap px で止める
  function drawLead(ax, ay, tx, ty, gap) {
    var dx = tx - ax, dy = ty - ay;
    var len = Math.sqrt(dx * dx + dy * dy) - (gap || 0);
    if (len < 12) { lead.visible = leadDot.visible = false; return; }
    lead.visible = leadDot.visible = true;
    lead.x = ax; lead.y = ay;
    lead.rotation = Math.atan2(-dx, dy) * 180 / Math.PI;   // +y 向きの図形を対象へ回す
    lead.scaleY = len / LEAD_H;
    lead.alpha = 0.85;
    var ux = dx / (len + (gap || 0)), uy = dy / (len + (gap || 0));
    leadDot.x = ax + ux * len; leadDot.y = ay + uy * len;
    leadDot.alpha = 0.7 + 0.3 * Math.sin(tAnim * 6);
  }

  function makeBeam(rgbaPrefix, solid) {
    var b = new createjs.Shape();
    b.graphics.beginFill(rgbaPrefix + "0.16)").drawRect(-9, -BEAM_H, 18, BEAM_H)
      .beginFill(rgbaPrefix + "0.55)").drawRect(-2.5, -BEAM_H, 5, BEAM_H)
      .beginFill(solid).drawRect(-1, -BEAM_H, 2, BEAM_H);
    b.cache(-10, -BEAM_H, 20, BEAM_H);
    b.visible = false;
    layer.addChild(b);
    return b;
  }

  function makeSideArrow(dir) {
    var a = new createjs.Shape();
    a.graphics.beginFill("#ffd24a")
      .moveTo(0, -14).lineTo(dir * 22, 0).lineTo(0, 14).closePath()
      .beginStroke("rgba(0,0,0,0.5)").setStrokeStyle(2)
      .moveTo(0, -14).lineTo(dir * 22, 0).lineTo(0, 14).closePath();
    a.cache(-26, -18, 52, 36);
    a.visible = false;
    layer.addChild(a);
    return a;
  }

  // ハロを的の色で焼き直す(色はステップ開始時に1回決まるだけなので安い)
  function colorHalos(light) {
    for (var i = 0; i < halos.length; i++) {
      var h = halos[i];
      h.graphics.clear();
      h.graphics.setStrokeStyle(3.5).beginStroke(light).drawCircle(0, 0, HALO_R)
        .beginFill("rgba(255,255,255,0.10)").drawCircle(0, 0, HALO_R - 4)
        .setStrokeStyle(1.5).beginStroke("rgba(255,255,255,0.85)").drawCircle(0, 0, HALO_R - 7);
      h.cache(-HALO_R - 4, -HALO_R - 4, HALO_R * 2 + 8, HALO_R * 2 + 8);
    }
  }

  function showLayer() {
    buildLayer();
    layerKillT = 0;
    layer.visible = !shelved;
    PP.stage.addChild(layer);   // 常に最前面へ(HUD よりも手前)
  }
  function dropLayer(immediate) {
    if (!layer) return;
    if (immediate) {
      disposeLayer();
    } else {
      layerKillT = 0.5;   // 帳のフェードを待ってから外す(update が面倒を見る)
      hideGuides();
    }
  }
  // ガイド層を捨てる: 全画面の帳のキャッシュ(縮小しても 1MB 前後)や図形の
  // キャッシュ canvas を、チュートリアルが終わったら保持しない(次の begin で作り直す)
  function disposeLayer() {
    if (!layer) return;
    if (layer.parent) layer.parent.removeChild(layer);
    for (var i = 0; i < layer.numChildren; i++) {
      var ch = layer.getChildAt(i);
      if (ch.uncache) ch.uncache();
    }
    layer.removeAllChildren();
    layer = null;
    veil = beamA = beamG = marker = arrowL = arrowR = cannonHalo = lead = leadDot = null;
    halos = [];
    layerKillT = 0;
  }
  function hideGuides() {
    if (!layer) return;
    beamA.visible = beamG.visible = marker.visible = false;
    arrowL.visible = arrowR.visible = cannonHalo.visible = false;
    lead.visible = leadDot.visible = false;
    for (var i = 0; i < halos.length; i++) halos[i].visible = false;
  }

  // いまのステップで引き出し線が指す対象物のステージ座標(無ければ null)
  function leadTarget(st) {
    var cx = PP.cannon.x, cy = PP.cannon.y;
    switch (st.id) {
      case "move":
      case "swap":
        return { x: cx, y: cy - 30, gap: 60 };
      case "wild":
        // 携帯: 画面の 🌈 ボタン(DOM)へ。位置は layoutDom が一度だけ測ってある
        if (PP.TOUCH && subIdx === 0 && dock.wildX) return { x: dock.wildX, y: dock.wildY, gap: 40 };
        return { x: cx, y: cy - 30, gap: 60 };
      case "shoot":
        if (target) {
          var pos = targetPositions();
          if (pos) {
            var tx = target.tx, ty = target.ty, ok = false;
            for (var q = 0; q < pos.length; q++) if (Math.abs(pos[q].x - tx) < 1) { ty = pos[q].y; ok = true; }
            if (!ok) { tx = 0; ty = 0; for (q = 0; q < pos.length; q++) { tx += pos[q].x; ty += pos[q].y; } tx /= pos.length; ty /= pos.length; }
            return { x: tx, y: ty, gap: 34 };
          }
        }
        return null;
      case "itemGood":
      case "itemBad":
        if (demoItem && PP.powerups.has && PP.powerups.has(demoItem)) return { x: demoItem.x, y: demoItem.y, gap: 26 };
        return null;
      case "skull":
        if (demoSkullAlive()) {
          var sp = demoSkull.lane.rail.posAt(demoSkull.ball.d + (demoSkull.ball.slide || 0));
          return { x: sp.x, y: sp.y, gap: 34 };
        }
        return null;
    }
    return null;
  }

  // ========== 的(2個以上の同色並び)の選定 ==========
  function pickTargetRun() {
    var g = PP.game;
    var best = null;
    g.eachLane(function (lane) {
      var balls = lane.balls;
      var i = 0;
      while (i < balls.length) {
        var j = i;
        var c = balls[i].color;
        while (j + 1 < balls.length && balls[j + 1].color === c &&
               balls[j].d - balls[j + 1].d <= PP.D + 1) j++;
        var len = j - i + 1;
        if (c !== null && c !== undefined && len >= 2) {
          var refs = balls.slice(i, j + 1);
          // 「真下から撃って本当に当たる」玉だけを的にする: レールは蛇行するので、
          // 的の真下にいても手前の段の玉に先に当たることがある。並びの各玉について
          // 「その x で真上に撃つと最初に当たるのがその玉か」を調べ、当たる玉の x を
          // 照準点(tx)にする。1つも無い並びは的にしない
          // 照準点は「届く玉」のうち並びの中央に近いもの(糸と矢印が並びの真ん中を
          // 指す=どの玉群を狙うのか一目で分かる)
          var mid = lane.rail.posAt(refs[Math.floor(refs.length / 2)].d).x;
          var tx = null, ty = 0;
          for (var k = 0; k < refs.length; k++) {
            var p = lane.rail.posAt(refs[k].d);
            if (p.y <= 80 || p.y >= PP.cannon.y - 110) continue;   // 画面外・大砲の間際は除外
            var hit = PP.cannon.firstHitBall(p.x);
            if (hit && refs.indexOf(hit.ball) >= 0) {
              if (tx === null || Math.abs(p.x - mid) < Math.abs(tx - mid)) {
                tx = p.x; ty = p.y;
              }
            }
          }
          if (tx !== null) {
            // 長い並び優先、同点なら大砲から近い方(移動距離が短く成功しやすい)
            var score = Math.min(len, 3) * 1000 - Math.abs(tx - PP.cannon.x);
            if (!best || score > best.score) {
              best = { lane: lane, refs: refs, color: c, tx: tx, ty: ty, score: score };
            }
          }
        }
        i = j + 1;
      }
    });
    return best;
  }

  // 的の現在位置(消えた玉は除く)。全部消えていたら null。
  // 1フレームに何度も呼ばれる(判定・ハロ・糸)ので、フレーム内は結果を使い回す
  var frameNo = 0, tpFrame = -1, tpCache = null;
  function targetPositions() {
    if (!target) return null;
    if (tpFrame === frameNo) return tpCache;
    tpFrame = frameNo;
    var balls = target.lane.balls;
    var out = [];
    for (var k = 0; k < target.refs.length; k++) {
      var b = target.refs[k];
      if (balls.indexOf(b) < 0) continue;
      out.push(target.lane.rail.posAt(b.d));
    }
    tpCache = out.length ? out : null;
    return tpCache;
  }

  // ========== DOM(カード・バナー) ==========
  // 文言の *強調* を <b class="tut-em"> に変換する(先にエスケープしてから)。
  // 辞書側は「*FIRE* で撃て」のように書くだけで要点が金色に浮く
  function rich(s) {
    return esc(s).replace(/\*(.+?)\*/g, '<b class="tut-em">$1</b>');
  }

  function showCard(st) {
    var t = PP.i18n.t;
    // 見出しは「絵文字 + 半角スペース + 題名」で書いてある。絵文字を丸いバッジに分離する
    var title = t(st.et);
    var m = /^(\S+)\s+(.+)$/.exec(title);
    var icon = m ? m[1] : "📜";
    var ttl = m ? m[2] : title;
    card.innerHTML =
      '<div class="tut-card-head">' +
        '<span class="tut-card-icon"><span>' + esc(icon) + "</span></span>" +
        '<span class="tut-card-title">' + esc(ttl) + "</span>" +
        '<span class="tut-card-step">STEP ' + (stepIdx + 1) + " / " + STEPS.length + "</span>" +
      "</div>" +
      '<div class="tut-card-body">' + rich(t(st.eb())) + "</div>" +
      '<div class="tut-card-foot">' +
        '<button type="button" class="tut-card-skip" id="tutCardSkip">' +
          esc(t("tut.skip")) + (PP.TOUCH ? "" : " (Esc)") + "</button>" +
        '<span class="tut-cont-hint">' + esc(t("tut.contHint", { tap: PP.TAP })) + "</span>" +
        '<span class="tut-cont">' + esc(t("tut.cont")) + "</span>" +
      "</div>";
    layoutDom();   // 文字サイズをキャンバスの実寸に合わせる(位置は CSS で中央)
    card.hidden = false;
    card.style.visibility = shelved ? "hidden" : "";
  }
  function hideCard() { card.hidden = true; }
  // カードのどこを押しても「続行」。スキップボタンだけは全体スキップ
  card.addEventListener("click", function (ev) {
    if (ev.target && ev.target.id === "tutCardSkip") { skip(); return; }
    tapAdvance();
  });

  // ---------- コールアウト(札)の配置: 盤面の左・上下中央、玉のある段には被せない ----------
  // レールに重なるのは構わないが、玉の並んでいる段には被せない。チュートリアル中は
  // チェーンが止まっていて玉は上の段に固まっているので、盤面の左・上下中央に置き、
  // 玉がそこまで下がってきたら玉のすぐ下へ滑って避ける。
  // コイン/デバフの落下実演のときだけ、落下線(大砲の真上)を避けて右へ寄せる。
  // DOM はキャンバスの CSS 拡縮や全画面のレターボックスに追従しないので、
  // キャンバスの実寸からステージ座標を画面座標へ写す(resize / fullscreenchange で再計算)
  var DOCK_W = 380, DOCK_H = 66, DOCK_X = 56, DOCK_MID_Y = (PP.H - DOCK_H) / 2;
  // dock: 換算係数と札の「目標位置」「現在位置」(ステージ座標)。移動は JS で補間して
  // transform に書く=毎フレーム DOM を読まない(getBoundingClientRect は強制レイアウト)
  var dock = { s: 1, ox: 0, oy: 0, x: DOCK_X, y: DOCK_MID_Y, cx: DOCK_X, cy: DOCK_MID_Y,
               wildX: 0, wildY: 0, pinSide: "top" };
  var tmpP = {};   // rail.posAtInto 用の使い回し(毎フレームのアロケーションを避ける)
  function layoutDom() {
    var cv = document.getElementById("gameCanvas");
    var wrap = cv && cv.parentNode;
    if (!cv || !wrap) return;
    var cr = cv.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (!cr.width) return;
    var s = cr.width / PP.W;
    dock.s = s;
    dock.ox = cr.left - wr.left;   // wrap 内でのキャンバス原点(全画面のレターボックス対応)
    dock.oy = cr.top - wr.top;
    [banner, toastEl].forEach(function (el) {
      el.style.left = "0px"; el.style.top = "0px";
      el.style.width = (DOCK_W * s) + "px";
      el.style.height = (DOCK_H * s) + "px";
      el.style.fontSize = Math.max(10, Math.min(17, 13 * s)) + "px";
    });
    card.style.fontSize = Math.max(11, Math.min(19, 15 * s)) + "px";
    // 携帯の 🌈 ボタンの中心(糸の先)はここで一度だけ測る
    var b = PP.TOUCH ? document.getElementById("tWild") : null;
    if (b && b.offsetParent) {
      var br = b.getBoundingClientRect();
      dock.wildX = (br.left + br.width / 2 - cr.left) / s;
      dock.wildY = (br.top + br.height / 2 - cr.top) / s;
    }
    placeCallout(true);
    applyCalloutPos(true);
  }
  window.addEventListener("resize", layoutDom);
  document.addEventListener("fullscreenchange", layoutDom);

  // 盤面にある玉のうち一番下の y(見えている玉だけ。無ければ 0)。
  // 全玉走査なので毎フレームは呼ばず、placeCallout が 0.15 秒ごとに間引いて使う
  function lowestBallY() {
    var m = 0;
    PP.game.eachLaneBall(function (b, lane) {
      if (b.d < PP.R || !b.view.visible) return;
      lane.rail.posAtInto(b.d, tmpP);
      if (tmpP.y > m) m = tmpP.y;
    });
    return m;
  }

  // 札の目標位置を決める(0.15 秒ごと。force で即時)
  var placeT = 0;
  function placeCallout(force) {
    var st = running ? STEPS[stepIdx] : null;
    // 縦: 盤面の上下中央。チュートリアル中は玉がそこまで下がっていれば一番下の玉の
    // 少し下へ(大砲の上には必ず収める)。チュートリアル外のヒント(通常プレイ中)は
    // 玉が盤面全体にあるので「玉の下」を追うと最下部へ押し出され、携帯では ◀▶ や
    // 大砲と重なってしまう。ヒントは札と同じ左・上下中央に固定する
    var y = DOCK_MID_Y;
    if (running) {
      y = Math.max(DOCK_MID_Y, lowestBallY() + 64);
      y = Math.min(y, PP.CANNON_Y - 84 - DOCK_H);
    }
    // 横: 左。落下実演の間だけ、落下線(大砲の x の周辺)に重なるなら右へ逃がす
    var x = DOCK_X;
    if (st && (st.id === "itemGood" || st.id === "itemBad")) {
      var cx = PP.cannon.x;
      if (cx < x + DOCK_W + 200) x = Math.min(PP.W - DOCK_W - 20, cx + 220);
    }
    if (!force && Math.abs(y - dock.y) < 24 && Math.abs(x - dock.x) < 24) return;
    dock.x = x; dock.y = y;
    if (force) { dock.cx = x; dock.cy = y; }
  }

  // 現在位置を目標へ寄せて transform に書く(動いているときだけ DOM に触る)
  function applyCalloutPos(force) {
    var dx = dock.x - dock.cx, dy = dock.y - dock.cy;
    if (!force && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return;
    var k = force ? 1 : 0.16;
    dock.cx += dx * k; dock.cy += dy * k;
    var tr = "translate3d(" + (dock.ox + dock.cx * dock.s).toFixed(1) + "px," +
             (dock.oy + dock.cy * dock.s).toFixed(1) + "px,0)";
    banner.style.transform = tr;
    toastEl.style.transform = tr;
  }

  // 札の縁のピンの中心(糸の起点)。対象が札より上なら上辺、下(大砲など)なら下辺。
  // 位置は自前の現在位置から求める(DOM は読まない)
  function pinOf(side) {
    if (side !== dock.pinSide) {
      dock.pinSide = side;
      banner.classList.toggle("pin-bottom", side === "bottom");
    }
    return { x: dock.cx + DOCK_W / 2, y: side === "bottom" ? dock.cy + DOCK_H : dock.cy };
  }
  function calloutCenterY() { return dock.cy + DOCK_H / 2; }

  function showBanner(key, done) {
    var t = PP.i18n.t;
    var h = '<div class="tut-eyebrow">' +
      '<span class="tut-step' + (done ? " done" : "") + '">' +
        (done ? "✔ DONE" : "STEP " + (stepIdx + 1) + " / " + STEPS.length) + "</span>" +
      '<button type="button" class="tut-skip" id="tutSkipBtn">' +
        esc(t("tut.skip")) + (PP.TOUCH ? "" : " (Esc)") + "</button>" +
      "</div>" +
      '<div class="tut-order">' + rich(t(key)) + "</div>";
    banner.innerHTML = h;
    layoutDom();
    banner.hidden = false;
    banner.classList.remove("out");
    banner.style.visibility = shelved ? "hidden" : "";
    bannerHideT = 0;
  }
  banner.addEventListener("click", function (ev) {
    if (ev.target && ev.target.id === "tutSkipBtn") skip();
  });
  function fadeBanner() {
    banner.classList.add("out");
    bannerHideT = 0.45;
  }

  function clearGlow() {
    var glowing = document.querySelectorAll(".tbtn.tut-glow");
    for (var i = 0; i < glowing.length; i++) glowing[i].classList.remove("tut-glow");
  }
  function applyGlow(ids) {
    clearGlow();
    if (!ids) return;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.add("tut-glow");
    }
  }

  // ========== ステップの進行 ==========
  function begin() {
    running = true;
    stepIdx = -1;
    subIdx = 0;
    holdNow = false;
    autoHold = false;
    target = null;
    tAnim = 0;
    showLayer();
    enterStep(0);
  }

  function enterStep(i) {
    stepIdx = i;
    subIdx = 0;
    if (i >= STEPS.length) { finishAll(); return; }
    if (STEPS[i].id === "shoot") {
      // 的(2個並び)が流れ込んでくるまで待つ。前ステップの ✓ は出したままにする
      phase = "wait";
      waitT = 0;
      return;
    }
    startExplain();
  }

  function startExplain() {
    var st = STEPS[stepIdx];
    if (st.hold) holdNow = true;   // ここからチェーン凍結=「ゲームを止めて」教える
    if (st.id === "shoot") prepareTarget();
    if (st.id === "wild") prepareWild();
    phase = "explain";
    banner.hidden = true;
    clearGlow();
    showCard(st);
    PP.audio.beep(392, 0.07, "sine", 0.04);   // カードが出た合図(そっと)
  }

  function prepareTarget() {
    target = pickTargetRun();
    aligned = false;
    if (target) {
      // 的と同じ色を装填してから教える=「光っている玉と同じ色」を保証する
      PP.game.currentColor = target.color;
      PP.cannon.refreshBalls();
      colorHalos(PP.PALETTE[target.color].light);
    }
  }

  function prepareWild() {
    // 練習用の在庫を保証(撃った分は完了時に返す=プレイヤーの損ゼロ)
    wildGranted = false;
    if ((PP.game.wildCharges || 0) < 1) {
      PP.game.wildCharges = 1;
      wildGranted = true;
      PP.hud.update();
    }
  }

  // 説明カードからの「続行」(input.js が盤面クリックを読み替えて呼ぶ・カード直押しも)
  function tapAdvance() {
    if (!running || phase !== "explain") return;
    PP.audio.beep(660, 0.05, "sine", 0.045);
    hideCard();
    var st = STEPS[stepIdx];
    if (st.cardOnly) {
      if (stepIdx >= STEPS.length - 1) { finishAll(); return; }
      phase = "gap";
      gapT = 0.25;
      return;
    }
    phase = "action";
    notifyGuardT = 0.35;   // カードを閉じた同じクリック/タップを操作に数えない
    moveAcc = 0;
    lastCx = null;
    showBanner(st.ab(), false);
    applyGlow(st.glow);
    demoT = 0;
    if (st.id === "itemGood") {
      // 実演: コインを大砲の少し横に落とす(真下へ入れば受け止められる距離)
      markHint("item");
      markHint("coin");
      coinsBefore = PP.game.coins || 0;
      livesBefore = PP.game.lives || 0;
      demoTries = 1;
      demoItem = dropDemoCoin();
    } else if (st.id === "itemBad") {
      // 実演: デバフを1つだけ、大砲の真上から落とす(避けないと受け止めてしまう)。
      // markHint を先に立てておけば dropDown 内の hint("down") はトーストを積まない
      markHint("down");
      demoItem = PP.powerups.dropDown ? PP.powerups.dropDown(PP.cannon.x, 150) : null;
    } else if (st.id === "skull") {
      // 実演: 盤面の玉を1つ骸骨化して、すぐ予兆→発射させる
      demoSkull = pickDemoSkull();
      skullFired = false;
      if (demoSkull) {
        PP.chain.skullify(demoSkull.ball, 0.8);
        colorHalos("#ff5d8f");
      } else {
        // 骸骨化できる玉が無い(盤面がほぼ空など)。実演は諦めて先へ
        phase = "gap";
        gapT = 0.3;
      }
    }
  }

  function dropDemoCoin() {
    if (!PP.powerups.dropCoin) return null;
    var m = PP.CANNON_MARGIN || 60;
    var side = PP.cannon.x < PP.W / 2 ? 1 : -1;
    var x = Math.max(m, Math.min(PP.W - m, PP.cannon.x + side * 150));
    return PP.powerups.dropCoin(x, 150);
  }

  // 骸骨化する玉: skull.js の canFire と同じ条件(洞窟の外・樽際の禁止帯より
  // 手前・トンネル外・可視)を満たし、画面内で見やすい高さにある色玉。
  // 大砲から横に離れているほど「狙われている」のが弾道で分かるので優先
  function pickDemoSkull() {
    var best = null;
    PP.game.eachLane(function (lane) {
      var rail = lane.rail;
      var lim = rail.holeD * (1 - PP.SKULL.quietZone);
      for (var i = 0; i < lane.balls.length; i++) {
        var b = lane.balls[i];
        if (b.skull || b.color === null || b.color === undefined) continue;
        if (b.d < PP.R || b.d > lim || rail.tunnelAt(b.d) || !b.view.visible) continue;
        var p = rail.posAt(b.d);
        // 画面内(レールの始点は画面外にある。そこから撃った弾は画面外の後始末で
        // 即消えるので、洞窟際の玉は選ばない)+見やすい高さ
        if (p.x < 60 || p.x > PP.W - 60) continue;
        if (p.y < 100 || p.y > PP.cannon.y - 140) continue;
        var score = Math.abs(p.x - PP.cannon.x);
        if (!best || score > best.score) best = { ball: b, lane: lane, score: score };
      }
    });
    return best;
  }
  function demoSkullAlive() {
    return !!demoSkull && demoSkull.lane.balls.indexOf(demoSkull.ball) >= 0;
  }

  function completeStep() {
    var st = STEPS[stepIdx];
    showBanner(st.ab2 && subIdx > 0 ? st.ab2 : st.ab(), true);
    clearGlow();
    hideGuides();
    if (PP.audio && PP.audio.catchItem) PP.audio.catchItem();
    phase = "gap";
    gapT = GAP_SEC;
  }

  function finishAll() {
    running = false;
    holdNow = false;
    autoHold = false;
    clearGlow();
    hideCard();
    markSeen(TUT_VER);
    setEnabled(false);   // 次のランでは出さない(タイトルの 🎓 で ON に戻せる)
    fadeBanner();
    dropLayer(false);
    releaseField();
    if (PP.fx) PP.fx.floatText(PP.i18n.t("tut.done"), PP.W / 2, PP.H / 2 - 40, "#8ef0d0", 26);
    if (PP.audio && PP.audio.treasure) PP.audio.treasure();
  }

  function skip() {
    if (!running) return;
    running = false;
    holdNow = false;
    autoHold = false;
    clearGlow();
    hideCard();
    markSeen(TUT_VER);
    setEnabled(false);
    fadeBanner();
    dropLayer(false);
    releaseField();
  }

  // 画面遷移(タイトルへ戻る等)による中断。既読は書かない=次の初プレイでまた出る
  function abort() {
    running = false;
    holdNow = false;
    autoHold = false;
    clearGlow();
    hideCard();
    banner.hidden = true;
    banner.classList.remove("out");
    bannerHideT = 0;
    dropLayer(true);
  }

  function markHint(id) {
    if (hintsSeen[id]) return;
    hintsSeen[id] = true;
    if (PP.store) PP.store.set("hintsSeen", hintsSeen);
  }

  // ========== 公開 API ==========
  function maybeStart() {
    var g = PP.game;
    if (running) return;
    if (PP.editor && PP.editor.active) return;
    if (g.customCourse) return;                 // エディタ試遊・共有コースでは出さない
    if (!enabled()) return;                     // タイトルの 🎓 が OFF(既読の既定も OFF)
    if (g.level !== 1 && !forceNext) return;    // 出航の最初の海域だけ(?level=N の検証起動は除く)
    forceNext = false;
    begin();
  }

  // もう一度見る(タイトルの 🎓 を ON にする操作の裏方。プレイ中に呼べば即開始)
  function restart() {
    setEnabled(true);
    if (PP.store) PP.store.set("hintsSeen", {});
    hintsSeen = {};
    var g = PP.game;
    if (g.state === "playing" || g.state === "intro") {
      forceNext = false;
      begin();
    } else {
      forceNext = true;
      if (PP.fx) PP.fx.floatText(PP.i18n.t("tut.again"), PP.W / 2, PP.H / 2 - 40, "#8ef0d0", 20);
    }
  }

  // 完了イベント(cannon.js: fire/swap、chain.js: match、upgrades.js: wild=装填)
  function notify(ev) {
    if (!running || phase !== "action" || notifyGuardT > 0) return;
    var st = STEPS[stepIdx];
    if (st.needs) {
      if (ev !== st.needs[subIdx]) return;
      if (subIdx === 0) {
        // 小目標1(虹玉の装填)達成 → そのまま「撃て」へ
        subIdx = 1;
        PP.audio.beep(660, 0.05, "sine", 0.045);
        showBanner(st.ab2, false);
        applyGlow(st.glow2);
      } else {
        if (st.id === "wild") {
          // 練習で撃った1発を返す(付与した保険の分も含めてストックは減らない)
          PP.game.wildCharges = Math.min(PP.game.wildMax || 99, (PP.game.wildCharges || 0) + 1);
          PP.hud.update();
          markHint("wild");
        }
        completeStep();
      }
      return;
    }
    if (st.need === ev) completeStep();
  }

  function hint(id) {
    if (hintsSeen[id] || !HINTS[id]) return;
    hintsSeen[id] = true;
    if (PP.store) PP.store.set("hintsSeen", hintsSeen);
    toastQueue.push(HINTS[id]);
  }

  // ポーズ中はポーズ画面が主役: 帳・カード・バナーを一時退避する(pause.js が呼ぶ)
  function setShelved(f) {
    shelved = !!f;
    if (layer) layer.visible = !shelved;
    if (!shelved) layoutDom();   // 全画面の切替などで枠が動いていても復帰時に合わせ直す
    var vis = shelved ? "hidden" : "";
    card.style.visibility = vis;
    banner.style.visibility = vis;
    toastEl.style.visibility = vis;
  }

  // ========== 毎フレーム(main.js tick の共通セクション) ==========
  function update(dt) {
    tickToast(dt);
    if (bannerHideT > 0) {
      bannerHideT -= dt;
      if (bannerHideT <= 0) { banner.hidden = true; banner.classList.remove("out"); }
    }
    // 帳のフェード(終了後の後片付けは running と独立に進める)
    if (layer && layer.parent) {
      // 帳は説明パネルの表示中だけ。実践中は素の盤面で操作させる(ガイドは
      // ハロ・ビーム・矢印だけで十分に目立つ)
      var vt = (running && phase === "explain") ? 1 : 0;
      veil.alpha += (vt - veil.alpha) * Math.min(1, dt * 7);
      if (layerKillT > 0) {
        layerKillT -= dt;
        if (layerKillT <= 0) disposeLayer();   // 外すだけでなくキャッシュも解放する
      }
    }
    if (graceT > 0 && PP.game.state === "playing") graceT -= dt;   // 終了後の猶予(凍結の余韻)
    if (!running) return;
    var g = PP.game;
    // レベルの外へ出たら中断(choosing / retrying / draining は続きがあるので待つ)
    if (g.state === "title" || g.state === "over" || g.state === "gameclear") { abort(); return; }
    if (g.state !== "playing") return;

    tAnim += dt;
    frameNo++;   // targetPositions のフレーム内キャッシュの鍵
    if (notifyGuardT > 0) notifyGuardT -= dt;

    // 保険の自動凍結: ステップ①で遊んでいる間も、玉が進みすぎたら止める
    // (説明の順番と関係なく「樽に届く」事故だけは絶対に起こさない)
    if (!autoHold && !holdNow) {
      if (g.rolloutDone) {
        autoHold = true;
      } else {
        var count = 0, lead = 0;
        g.eachLane(function (lane) {
          count += lane.balls.length;
          if (lane.balls.length) {
            var r = lane.balls[0].d / (lane.rail.holeD || 1);
            if (r > lead) lead = r;
          }
        });
        if (count > 25 || lead > 0.45) autoHold = true;
      }
    }

    var st = STEPS[stepIdx];
    if (phase === "action") {
      // 札の置き場所(全玉走査)は 0.15 秒ごとに間引く。補間は毎フレーム(applyCalloutPos)
      placeT += dt;
      if (placeT >= 0.15) { placeT = 0; placeCallout(false); }
    }
    if (phase === "wait") {
      // 的(2個並び)が流れ込むのを待ってから説明に入る。上限を超えたら
      // 的なし(ハロ無しの汎用文言)で先へ進む。全玉走査なので 0.2 秒ごとに間引く
      waitT += dt;
      placeT += dt;
      if (placeT >= 0.2 || waitT > WAIT_MAX) {
        placeT = 0;
        if (pickTargetRun() || g.rolloutDone || waitT > WAIT_MAX) startExplain();
      }
    } else if (phase === "gap") {
      gapT -= dt;
      if (gapT <= 0) enterStep(stepIdx + 1);
    } else if (phase === "action") {
      if (st.id === "move") {
        var cx = PP.cannon.x;
        if (lastCx !== null) moveAcc += Math.abs(cx - lastCx);
        lastCx = cx;
        if (moveAcc >= MOVE_GOAL) completeStep();
      } else if (st.id === "shoot" && target) {
        if (!targetPositions()) {
          // 的の並びが(爆発などで)消えてしまったら選び直す
          prepareTarget();
          showBanner(st.ab(), false);
        } else if (PP.game.currentColor !== target.color) {
          // 撃ち外しても「光る玉と同じ色を装填してある」の約束を守り続ける
          // (交換はまだ教えていないので、ここだけは黙って手を貸す)
          PP.game.currentColor = target.color;
          PP.cannon.refreshBalls();
        }
      } else if (st.id === "itemGood") {
        // コインが消えたら: 受け止めていれば ✓。取り損ねなら1回だけ落とし直す
        demoT += dt;
        var caught = (PP.game.coins || 0) > coinsBefore || (PP.game.lives || 0) > livesBefore;
        var coinGone = !demoItem || !(PP.powerups.has && PP.powerups.has(demoItem));
        if (caught || demoT > 14 || (coinGone && demoTries >= 2)) {
          demoItem = null;
          completeStep();
        } else if (coinGone) {
          demoTries++;
          demoItem = dropDemoCoin();
        }
      } else if (st.id === "itemBad") {
        // 実演のデバフが消えたら(避け切った or 受け止めてしまった)次へ。
        // 参照が取れなかった場合の保険としてタイマーでも進める
        demoT += dt;
        var gone = !demoItem || !(PP.powerups.has && PP.powerups.has(demoItem));
        if (gone || demoT > 8) { demoItem = null; completeStep(); }
      } else if (st.id === "skull") {
        // 骸骨玉が撃ち終わって弾が全部消えたら(避けた・迎撃した・被弾した)、
        // または骸骨玉自体を消したら次へ。撃たない事故の保険にタイムアウト
        demoT += dt;
        var nb = PP.skull.bulletCount ? PP.skull.bulletCount() : 0;
        if (nb > 0) skullFired = true;
        if (!demoSkullAlive() || (skullFired && nb === 0) || demoT > 18) completeStep();
      }
    }

    updateGuides();
  }

  // ガイドの位置と脈動(説明中も実践中も毎フレーム追従)
  function updateGuides() {
    if (!layer || !layer.parent) return;
    hideGuides();
    if (!running) return;
    var st = STEPS[stepIdx];
    if (!st || (phase !== "explain" && phase !== "action")) return;
    var pulse = 0.62 + 0.38 * Math.sin(tAnim * 5.2);
    var cx = PP.cannon.x, cy = PP.cannon.y;

    // 実践中: 札を大砲から遠い側へ寄せ、ピンから対象物へ糸を張る。
    // 対象物が動けば(落ちるコイン・動く大砲)毎フレーム追い直す
    if (phase === "action") {
      applyCalloutPos(false);
      var tgt = leadTarget(st);
      if (tgt) {
        var pin = pinOf(tgt.y < calloutCenterY() ? "top" : "bottom");
        drawLead(pin.x, pin.y, tgt.x, tgt.y, tgt.gap);
      }
    }

    if (st.id === "move") {
      if (phase === "explain") {
        cannonHalo.visible = true;
        cannonHalo.x = cx; cannonHalo.y = cy - 18;
        cannonHalo.alpha = pulse;
      } else {
        var bob = Math.sin(tAnim * 6) * 8;
        arrowL.visible = arrowR.visible = true;
        arrowL.x = cx - 78 - bob; arrowR.x = cx + 78 + bob;
        arrowL.y = arrowR.y = cy - 16;
        arrowL.alpha = arrowR.alpha = 0.9;
      }
      return;
    }

    if (st.id === "swap") {
      cannonHalo.visible = true;
      cannonHalo.x = cx; cannonHalo.y = cy - 18;
      cannonHalo.alpha = pulse;
      return;
    }

    if (st.id === "skull") {
      // 目覚めさせた骸骨玉を光らせて「これが撃ってくる」を示す
      if (phase === "action" && demoSkullAlive()) {
        var sp = demoSkull.lane.rail.posAt(demoSkull.ball.d + (demoSkull.ball.slide || 0));
        var h0 = halos[0];
        h0.visible = true;
        h0.x = sp.x; h0.y = sp.y;
        h0.alpha = 0.5 + 0.5 * pulse;
        h0.scaleX = h0.scaleY = 1 + 0.07 * Math.sin(tAnim * 5.2);
        marker.visible = true;
        marker.x = sp.x;
        marker.y = sp.y - 44 + Math.abs(Math.sin(tAnim * 5)) * -8;
        marker.alpha = 0.95;
      }
      return;
    }

    if (st.id === "shoot") {
      var pos = targetPositions();
      if (pos) {
        // 的の玉を光らせる(ハロ+白リングの脈動)
        var minY = 1e9, sx = 0;
        for (var i = 0; i < pos.length && i < halos.length; i++) {
          var h = halos[i];
          h.visible = true;
          h.x = pos[i].x; h.y = pos[i].y;
          h.alpha = 0.5 + 0.5 * pulse;
          h.scaleX = h.scaleY = 1 + 0.07 * Math.sin(tAnim * 5.2);
          if (pos[i].y < minY) minY = pos[i].y;
          sx += pos[i].x;
        }
        // 照準点は「真下から撃って当たる玉」の x(選定時に決めた target.tx)。
        // その玉が消えていたら今ある玉の平均で代用する
        var tx = target.tx;
        var txAlive = false;
        for (var q = 0; q < pos.length; q++) if (Math.abs(pos[q].x - tx) < 1) txAlive = true;
        if (!txAlive) tx = sx / pos.length;
        // 的の真上で跳ねる矢印
        marker.visible = true;
        marker.x = tx;
        marker.y = minY - 44 + Math.abs(Math.sin(tAnim * 5)) * -8;
        marker.alpha = 0.95;
        if (phase === "action") {
          // 照準ビーム: 大砲の真上に立て、「真上に撃って最初に当たる玉」が的の並びの
          // どれかになった瞬間に緑にする(x のズレではなく実際の命中で判定)
          var was = aligned;
          var fh = PP.cannon.firstHitBall(cx);
          aligned = !!(fh && target.refs.indexOf(fh.ball) >= 0);
          var beam = aligned ? beamG : beamA;
          beam.visible = true;
          beam.x = cx;
          beam.y = cy - 44;
          beam.scaleY = Math.max(0.5, (cy - 44 - (minY + 30)) / BEAM_H);
          beam.alpha = aligned ? 0.95 : 0.45 + 0.25 * pulse;
          if (was !== aligned) showBanner(aligned ? "tut.a2go" : st.ab(), false);
        }
      } else if (phase === "action") {
        // 的なしの汎用モード: ビームだけ立てて「同じ色に当てよ」
        beamA.visible = true;
        beamA.x = cx; beamA.y = cy - 44;
        beamA.scaleY = (cy - 44 - 90) / BEAM_H;
        beamA.alpha = 0.45 + 0.25 * pulse;
      }
    }
  }

  // ---------- トーストの進行 ----------
  function tickToast(dt) {
    if (toastT > 0) {
      toastT -= dt;
      if (toastT <= 0) { toastEl.classList.add("out"); toastFade = 0.45; }
      return;
    }
    if (toastFade > 0) {
      toastFade -= dt;
      if (toastFade <= 0) { toastEl.hidden = true; toastEl.classList.remove("out"); }
      return;
    }
    if (!toastQueue.length) return;
    // ステップ制の最中はバナーと場所が重なるうえ情報過多になるので、
    // キューに留めて終わってから順に流す
    if (running) return;
    var keyFn = toastQueue.shift();
    toastEl.innerHTML = '<div class="tut-eyebrow"><span class="tut-step done">HINT</span></div>' +
      '<div class="tut-order">' + rich(PP.i18n.t(keyFn())) + "</div>";
    layoutDom();
    toastEl.hidden = false;
    toastEl.classList.remove("out");
    toastEl.style.visibility = shelved ? "hidden" : "";
    toastT = TOAST_SEC;
  }

  PP.tut = {
    maybeStart: maybeStart,
    restart: restart,
    enabled: enabled,         // hud.js: タイトルの 🎓 ボタンの表示 / input.js: 切替
    setEnabled: setEnabled,
    skip: skip,
    tapAdvance: tapAdvance,   // input.js: 説明中のクリック/タップ/キー=「続行」
    active: function () { return running; },   // main.js: ゲージの凍結判定
    modal: function () { return running && phase === "explain"; },   // input.js: 盤面操作を止める
    // chain.js: 前進の凍結(終了直後の猶予 graceT の間も止めたまま)
    chainHeld: function () { return (running && (holdNow || autoHold)) || graceT > 0; },
    suppressDrops: function () { return running; },   // powerups.js: 練習中はランダムドロップ停止
    // chain.js / skull.js: 練習中は骸骨玉を湧かせず・撃たせない
    // (「障害物」ステップの実演のときだけ、目覚めさせた1体が撃つ)
    suppressSkulls: function () {
      if (!running) return false;
      var st = STEPS[stepIdx];
      return !(st && st.id === "skull" && phase === "action");
    },
    notify: notify,
    hint: hint,
    setShelved: setShelved,   // pause.js: ポーズ画面と重ならないよう退避
    update: update
  };
})();
