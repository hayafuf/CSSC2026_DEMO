/* =========================================================
 * crisis.js — 樽に呑まれかけているときの演出
 *
 * 目的は「呑み込まれる恐怖」でプレイヤーを焦らせること。
 * すべてをひとつの心拍に同期させ、危機が深まるほど速く打たせる:
 *
 *   ・crisis.mp3 をループ再生。深いほど音量とピッチが上がる
 *   ・赤い帳が心拍で脈打ち、内側が縮んで視野が狭まる(トンネル視)
 *   ・樽の口が心拍に合わせて赤く灯る = 呑み込む口が呼吸している
 *   ・ドクロも同じ心拍で膨らむ
 *   ・玉が1個呑まれるたびに赤い閃光・強い揺れ・「あと N 個」の宣告
 *
 * マルチレーン: 危機の深さ(帳・心拍・音)は「一番危ないレーン」で決まる。
 * 樽の灯り・這い寄る赤・ドクロ・樽の呼吸は樽ごと(レーンごと)に、その
 * レーン自身の深さで個別に灯す。1本コースなら樽1つで従来と同一。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var built = false;
  var vignette, flash;
  var edgePulse;   // 画面の縁の赤帯。心拍の頭でカッと光って減衰する
  var omen;        // 「☠ GAME OVER ☠」の凶兆。深い危機で一瞬ちらつく
  var st;
  // 樽ごとの演出パーツ。buildParts で PP.barrels(main が作る)から組む。
  //   { lane, mouth, maw, creep, creepPts, creepDrawn, want, announced, deep }
  var parts = [];

  function blank() {
    return { level: 0, phase: 0, drip: 0 };
  }

  // 樽ごとの灯り(maw)と這い寄る赤(creep)を、いまのレーン構成に合わせて作り直す。
  function buildParts() {
    var W = PP.layers.fx;
    // 古いパーツを片付ける
    for (var k = 0; k < parts.length; k++) {
      if (parts[k].maw && parts[k].maw.parent) W.removeChild(parts[k].maw);
      if (parts[k].creep && parts[k].creep.parent) W.removeChild(parts[k].creep);
    }
    parts = [];
    var lanes = PP.game.lanes || [];
    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      var mouth = lane.rail.posAt(lane.rail.holeD);
      // レールを樽から遡る「這い寄る赤い光」の経路
      var creepPts = [];
      for (var d = lane.rail.holeD; d > lane.rail.holeD - PP.CRISIS.creep; d -= 26) {
        creepPts.push(lane.rail.posAt(Math.max(0, d)));
      }
      var creep = new createjs.Shape();
      creep.compositeOperation = "lighter";
      creep.alpha = 0;
      W.addChild(creep);

      var maw = new createjs.Shape();
      maw.graphics.beginRadialGradientFill(
        ["rgba(255,90,40,0.9)", "rgba(190,10,0,0.45)", "rgba(120,0,0,0)"], [0, 0.42, 1],
        0, 0, 3, 0, 0, 88).drawCircle(0, 0, 88);
      maw.compositeOperation = "lighter";
      maw.x = mouth.x; maw.y = mouth.y;
      maw.alpha = 0;
      W.addChild(maw);

      parts.push({
        lane: lane, mouth: mouth, maw: maw, creep: creep,
        creepPts: creepPts, creepDrawn: -1, want: 0, announced: false, deep: 0
      });
    }
  }

  function build() {
    var L = PP.layers.crisis;

    buildParts();

    // 血の帳。縮めると暗い部分が内側へ寄ってきて視野が狭まる。
    vignette = new createjs.Shape();
    vignette.graphics.beginRadialGradientFill(
      ["rgba(150,0,0,0)", "rgba(115,0,0,0.4)", "rgba(52,0,0,0.92)"], [0, 0.6, 1],
      PP.W / 2, PP.H / 2, 150, PP.W / 2, PP.H / 2, 620)
      .drawRect(-PP.W / 2, -PP.H / 2, PP.W * 2, PP.H * 2);
    vignette.regX = PP.W / 2; vignette.regY = PP.H / 2;
    vignette.x = PP.W / 2; vignette.y = PP.H / 2;
    vignette.alpha = 0;
    L.addChild(vignette);

    // 画面の縁だけを覆う赤帯(4辺)。心拍の頭で光り、すぐ減衰する。
    // 帳(vignette)より鋭く点滅するので「ドクン」が縁に走って見える
    edgePulse = new createjs.Shape();
    var eg = edgePulse.graphics, EW = 90;
    eg.beginLinearGradientFill(["rgba(200,0,0,0.8)", "rgba(200,0,0,0)"], [0, 1], 0, 0, 0, EW)
      .drawRect(0, 0, PP.W, EW);
    eg.beginLinearGradientFill(["rgba(200,0,0,0)", "rgba(200,0,0,0.8)"], [0, 1], 0, PP.H - EW, 0, PP.H)
      .drawRect(0, PP.H - EW, PP.W, EW);
    eg.beginLinearGradientFill(["rgba(200,0,0,0.8)", "rgba(200,0,0,0)"], [0, 1], 0, 0, EW, 0)
      .drawRect(0, 0, EW, PP.H);
    eg.beginLinearGradientFill(["rgba(200,0,0,0)", "rgba(200,0,0,0.8)"], [0, 1], PP.W - EW, 0, PP.W, 0)
      .drawRect(PP.W - EW, 0, EW, PP.H);
    edgePulse.compositeOperation = "lighter";
    edgePulse.alpha = 0;
    L.addChild(edgePulse);

    // 凶兆: ゲームオーバーの文字が視界の隅にちらつく(サブリミナル風)。
    // 色はゲームオーバー画面(doom スキン)と同じ血の赤
    omen = new createjs.Text("☠ GAME OVER ☠",
      'bold 64px "Cinzel Decorative","Hiragino Kaku Gothic ProN","Meiryo",serif', "#8b0f0f");
    omen.textAlign = "center"; omen.textBaseline = "middle";
    omen.x = PP.W / 2; omen.y = PP.H / 2;
    omen.alpha = 0;
    L.addChild(omen);

    // 玉が呑まれた瞬間の閃光
    flash = new createjs.Shape();
    flash.graphics.beginFill("#a00000").drawRect(0, 0, PP.W, PP.H);
    flash.alpha = 0;
    L.addChild(flash);

    st = blank();
    built = true;
  }

  // 心拍の波形(ドクン、という二拍)
  function heart(p) {
    return Math.exp(-p * 10) + 0.5 * Math.exp(-Math.abs(p - 0.21) * 15);
  }

  // 樽から溢れた汚染がレールを遡ってくる(1樽ぶん)。深いほど遠くまで這う
  function drawCreep(part, n) {
    var count = Math.round(n * part.creepPts.length);
    if (count === part.creepDrawn) return;
    part.creepDrawn = count;
    var g = part.creep.graphics;
    var pts = part.creepPts;
    g.clear();
    if (count < 2) return;
    function trace(len) {
      g.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < len; i++) g.lineTo(pts[i].x, pts[i].y);
    }
    g.setStrokeStyle(PP.R * 2 + 4, "round", "round").beginStroke("rgba(120,0,0,0.5)");
    trace(count); g.endStroke();
    g.setStrokeStyle(PP.R * 0.9, "round", "round").beginStroke("rgba(255,60,20,0.5)");
    trace(Math.max(2, Math.round(count * 0.45))); g.endStroke();
  }

  // 画面が血を流す。心拍の頭で滴らせる
  function drip() {
    var L = PP.layers.crisis;
    var s = new createjs.Shape();
    var w = 3 + Math.random() * 4;
    var h = 12 + Math.random() * 22;
    s.graphics.beginFill("rgba(125,0,0,0.85)").drawRoundRect(0, 0, w, h, w / 2);
    s.x = 20 + Math.random() * (PP.W - 40);
    s.y = 62;
    s.alpha = 0.9;
    L.addChild(s);
    createjs.Tween.get(s)
      .to({ y: s.y + 90 + Math.random() * 160, alpha: 0 },
          1400 + Math.random() * 1400, createjs.Ease.quadIn)
      .call(function () { L.removeChild(s); });
  }

  // 赤い走査ノイズ。画面のどこかに横一線の赤いラインが走り、すぐ消える。
  // 「映像が乱れる」不穏さで、通常状態ではないことを突きつける
  function glitchLine() {
    var L = PP.layers.crisis;
    var s = new createjs.Shape();
    var h = 2 + Math.random() * 2;
    s.graphics.beginFill("rgba(255,40,20,0.55)").drawRect(0, 0, PP.W, h);
    s.x = 0;
    s.y = 62 + Math.random() * (PP.H - 80);
    s.compositeOperation = "lighter";
    L.addChild(s);
    createjs.Tween.get(s)
      .to({ alpha: 0 }, 120)
      .call(function () { L.removeChild(s); });
  }

  // 樽に何個ぶん入っているか(0 = まだ口の外)
  function depthOf(lead, holeD) {
    var over = lead - holeD;
    return over > 0 ? Math.floor(over / PP.D) + 1 : 0;
  }

  function update(dt) {
    if (!built) return;
    var g = PP.game;
    var C = PP.CRISIS;

    // 各レーンの危機の深さ want を測り、一番危ないレーンの値を全体に使う
    var maxWant = 0;
    for (var li = 0; li < g.lanes.length && li < parts.length; li++) {
      var lane = g.lanes[li];
      var holeD = lane.rail.holeD;
      var start = holeD * C.start;
      var lead = lane.balls.length > 0 ? lane.balls[0].d : 0;
      var want = 0;
      if (lead > holeD) want = 1 + (lead - holeD) / (PP.D * PP.barrelCap());
      else if (lead > start) want = (lead - start) / (holeD - start);
      want = Math.max(0, Math.min(2, want));
      parts[li].want = want;
      parts[li].lead = lead;
      parts[li].holeD = holeD;
      if (want > maxWant) maxWant = want;
    }

    // 全体の帳・心拍・音は maxWant で駆動(深まるときは速く、退くときはゆっくり)
    var k = Math.min(1, dt * (maxWant > st.level ? C.rise : C.fall));
    st.level += (maxWant - st.level) * k;
    if (st.level < 0.015 && maxWant === 0) st.level = 0;

    var n = st.level / 2;                    // 0..1 に正規化した深さ
    PP.audio.setDanger(maxWant > 0);
    PP.audio.crisis(n);

    if (st.level > 0) {
      var beat = C.beatSlow + (C.beatFast - C.beatSlow) * n;
      var was = Math.floor(st.phase);
      st.phase += dt / beat;
      if (Math.floor(st.phase) > was) {
        PP.fx.shake(C.shake * (0.35 + 0.65 * n), 0.2);
        if (n > C.growlAt) PP.audio.growl((n - C.growlAt) / (1 - C.growlAt));
        var dr = (n - C.dripAt) / (1 - C.dripAt);
        if (dr > 0) {
          st.drip += dr * 2.5;
          while (st.drip >= 1) { st.drip -= 1; drip(); }
        }
        // 心拍の頭: 画面の縁がカッと赤く光る(下の減衰でスッと引く)
        edgePulse.alpha = Math.min(0.85, 0.7 * n);
        // 深い危機では映像が乱れる(赤い走査ノイズ)
        if (n > C.glitchAt) {
          var lines = 1 + Math.floor(Math.random() * 3);
          for (var gi = 0; gi < lines; gi++) glitchLine();
        }
      }
    } else {
      st.phase = 0;
      st.drip = 0;
      edgePulse.alpha = 0;
      omen.alpha = 0;
    }
    var h = st.level > 0 ? heart(st.phase % 1) : 0;

    vignette.alpha = C.vignette * n * (0.5 + 0.5 * h);
    vignette.scaleX = vignette.scaleY = 1 - C.tunnel * n;   // 視野が狭まる
    edgePulse.alpha *= Math.exp(-dt * 6);                   // 縁の光は鋭く減衰

    // 凶兆: 深い危機でだけ、視界に「☠ GAME OVER ☠」が一瞬浮かんでは消える。
    // 確率的に数フレームだけ現れ、位置も僅かにズレる(グリッチ風のちらつき)
    if (st.level > 0 && n > C.omenAt &&
        Math.random() < 0.10 + 0.18 * (n - C.omenAt) / (1 - C.omenAt)) {
      omen.alpha = 0.08 + 0.24 * Math.random();
      omen.x = PP.W / 2 + (Math.random() - 0.5) * 16;
      omen.y = PP.H / 2 + (Math.random() - 0.5) * 12;
    } else {
      omen.alpha *= 0.75;   // 数フレームで残像ごと消える
    }

    // 樽ごとの灯り・這う赤・呼吸・ドクロ・宣告(そのレーン自身の深さで灯す)
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi];
      var nLane = part.want / 2;             // このレーンの深さ(0..1)
      part.maw.alpha = Math.min(1, nLane * (0.4 + 0.7 * h));
      part.maw.scaleX = part.maw.scaleY = 0.75 + 0.3 * nLane + 0.25 * h;
      drawCreep(part, nLane);
      part.creep.alpha = nLane * (0.45 + 0.55 * h);

      // 樽そのものが呼吸する
      var bp = PP.barrels && PP.barrels[pi];
      if (bp) {
        var s = 1 + (0.06 + 0.16 * nLane) * h;
        bp.back.scaleX = bp.back.scaleY = s;
        bp.front.scaleX = bp.front.scaleY = s;
        var sk = bp.skull;
        if (sk) {
          if (part.want > 0) {
            sk.scaleX = sk.scaleY = 1 + (0.2 + 0.55 * nLane) * h;
            sk.color = part.want >= 1 ? "#ff2f2f" : "#ff5d5d";
          } else {
            sk.scaleX = sk.scaleY = 1;
            sk.color = "#f0e6c8";
          }
        }
      }

      // 口が開いた瞬間の宣告(危機に入るたび1回だけ)
      if (part.want > 0 && !part.announced) {
        part.announced = true;
        PP.fx.floatText("樽が口を開けた!", part.mouth.x - 80, part.mouth.y - 46, "#ff5d5d", 21);
      } else if (part.want === 0) {
        part.announced = false;
      }

      // 呑まれた / 押し戻した
      var deep = depthOf(part.lead || 0, part.holeD || 1);
      if (deep > part.deep) swallowed(part, deep);
      else if (deep < part.deep) pushedBack(part);
      part.deep = deep;
    }
  }

  // 玉が1個ぶん樽に落ちた。残り個数を突きつける
  function swallowed(part, deep) {
    var left = Math.max(0, PP.barrelCap() + 1 - deep);
    flash.alpha = 0.5;
    createjs.Tween.get(flash, { override: true }).to({ alpha: 0 }, 400);
    PP.fx.shake(15, 0.55);
    PP.fx.burst(part.mouth.x, part.mouth.y, "#ff4020", 20);
    PP.fx.burst(part.mouth.x, part.mouth.y, "#ffb060", 10);
    PP.fx.floatText(left > 0 ? "呑まれた!  あと " + left + " 個" : "呑まれた!",
      part.mouth.x - 70, part.mouth.y - 44, "#ff3535", 24);
    PP.audio.swallowed(deep);
  }

  // 押し戻した。安堵は与えるが、演出はゆっくりしか退かない
  function pushedBack(part) {
    PP.fx.floatText("押し戻した!", part.mouth.x - 70, part.mouth.y - 44, "#8ef0d0", 21);
    PP.audio.pushedBack();
  }

  // 危機の外(クリア・ゲームオーバー)へ抜けるときは音も絵も畳む
  function stop() {
    if (!built) return;
    st = blank();
    createjs.Tween.removeTweens(flash);
    vignette.alpha = 0;
    vignette.scaleX = vignette.scaleY = 1;
    flash.alpha = 0;
    edgePulse.alpha = 0;
    omen.alpha = 0;
    for (var pi = 0; pi < parts.length; pi++) {
      parts[pi].maw.alpha = 0;
      parts[pi].creep.alpha = 0;
      parts[pi].creep.graphics.clear();
      parts[pi].creepDrawn = -1;
      parts[pi].announced = false;
      parts[pi].deep = 0;
      var bp = PP.barrels && PP.barrels[pi];
      if (bp) {
        bp.back.scaleX = bp.back.scaleY = 1;
        bp.front.scaleX = bp.front.scaleY = 1;
      }
    }
    // 垂れている血・走査ノイズを片付ける(帳・閃光・縁の帯・凶兆の常設物は残す)
    var L = PP.layers.crisis;
    for (var i = L.children.length - 1; i >= 0; i--) {
      var c = L.children[i];
      if (c !== vignette && c !== flash && c !== edgePulse && c !== omen) {
        createjs.Tween.removeTweens(c);
        L.removeChild(c);
      }
    }
    PP.audio.crisis(0);
  }

  function reset() {
    stop();
    for (var pi = 0; pi < parts.length; pi++) {
      var bp = PP.barrels && PP.barrels[pi];
      if (bp && bp.skull) { bp.skull.scaleX = bp.skull.scaleY = 1; bp.skull.color = "#f0e6c8"; }
    }
  }

  // コース(レール)が差し替わったとき、樽ごとの灯りと這い寄る赤を新しい構成へ組み直す。
  function relocate() {
    if (!built) return;
    buildParts();
  }

  PP.crisis = {
    build: build,
    update: update,
    stop: stop,
    reset: reset,
    relocate: relocate
  };
})();
