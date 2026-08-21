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
    // danger/dangerHold は危険BGMのヒステリシス(入りは即・抜けは bgmRelease 秒
    // ためらう)。境界で BGM が頭出しを繰り返すのを防ぐ(update 参照)
    return { level: 0, phase: 0, drip: 0, danger: false, dangerHold: 0 };
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
      // 太い丸ストローク2本の再ラスタライズは重く、キャッシュしないと stage.update の
      // たびに走る。経路の bbox(最大ストローク半幅 PP.R+2 と丸キャップぶんの余白付き)
      // で一度 cache し、以後は drawCreep が描き直したときだけ updateCache する。
      // キャッシュ済みビットマップにも alpha / lighter 合成は同じに掛かるので絵は同一。
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (var ci = 0; ci < creepPts.length; ci++) {
        var cp = creepPts[ci];
        if (cp.x < bx0) bx0 = cp.x;
        if (cp.x > bx1) bx1 = cp.x;
        if (cp.y < by0) by0 = cp.y;
        if (cp.y > by1) by1 = cp.y;
      }
      var pad = PP.R + 6;
      creep.cache(Math.floor(bx0 - pad), Math.floor(by0 - pad),
        Math.ceil(bx1 - bx0 + pad * 2), Math.ceil(by1 - by0 + pad * 2));
      W.addChild(creep);

      var maw = new createjs.Shape();
      maw.graphics.beginRadialGradientFill(
        ["rgba(255,90,40,0.9)", "rgba(190,10,0,0.45)", "rgba(120,0,0,0)"], [0, 0.42, 1],
        0, 0, 3, 0, 0, 88).drawCircle(0, 0, 88);
      maw.compositeOperation = "lighter";
      maw.x = mouth.x; maw.y = mouth.y;
      maw.alpha = 0;
      // グラデ円を一度だけビットマップに焼く。危機中は毎フレーム alpha と scale が
      // 動くが、どちらも焼いたビットマップにそのまま掛かるので絵は同一(creep と
      // 同じ理屈)。scale は最大 0.75+0.3+0.25≒1.3 まで上がるので、その倍率でも
      // ボケないよう第5引数(cacheScale)で 1.35 倍の解像度で焼いておく
      maw.cache(-90, -90, 180, 180, 1.35);
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
    // 【最重要の1行】画面4倍面積(2600×1400)のラジアルグラデを一度だけ焼く。
    // cache しないと EaselJS は「値を変えていなくても」毎フレームこのグラデを
    // 塗り直す — 樽の直前だけ急に重くなる最大の原因がこれだった。
    // 毎フレームの alpha/scale 変更(トンネル視)は焼いたビットマップに掛かるだけ。
    // フル解像度だと RGBA で約 15MB 食うので、ぼんやりしたグラデの性質を利用して
    // 半分の解像度(PERF.VEIL_CACHE_SCALE)で焼き、表示時に引き伸ばす
    vignette.cache(-PP.W / 2, -PP.H / 2, PP.W * 2, PP.H * 2, PP.PERF.VEIL_CACHE_SCALE);
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
    // 4辺のグラデ帯も一度だけ焼く(vignette と同じ理屈・同じ縮小解像度)
    edgePulse.cache(0, 0, PP.W, PP.H, PP.PERF.VEIL_CACHE_SCALE);
    L.addChild(edgePulse);

    // 凶兆: ゲームオーバーの文字が視界の隅にちらつく(サブリミナル風)。
    // 色はゲームオーバー画面(doom スキン)と同じ血の赤
    omen = new createjs.Text("☠ GAME OVER ☠",
      'bold 64px "Cinzel Decorative","Hiragino Kaku Gothic ProN","Meiryo",serif', "#8b0f0f");
    omen.textAlign = "center"; omen.textBaseline = "middle";
    omen.x = PP.W / 2; omen.y = PP.H / 2;
    omen.alpha = 0;
    // 64px の装飾フォントを毎フレーム描かせない。中央揃え+middle 基準なので
    // ローカル原点は文字の中央 = getBounds の範囲に余白を足して焼く。
    // Web フォントが後から届いたら焼き直す(regFontCache: config.js)
    var ob = omen.getBounds();
    omen.cache(ob.x - 8, ob.y - 8, ob.width + 16, ob.height + 16);
    PP.regFontCache(omen);
    L.addChild(omen);

    // 玉が呑まれた瞬間の閃光。単色の全画面フィルはごく小さく焼いて
    // 引き伸ばしても同じ絵(fx.js bakeSolid と同じ理屈)
    flash = new createjs.Shape();
    flash.graphics.beginFill("#a00000").drawRect(0, 0, PP.W, PP.H);
    flash.alpha = 0;
    flash.cache(0, 0, PP.W, PP.H, 0.05);
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
    // updateCache は大きなオフスクリーンの焼き直しで、この関数の中で一番高い。
    // count は玉の微動でも 1 ずつ揺れるので、そのたびに焼き直すと危機中ほぼ
    // 毎フレーム走ってしまう。CREEP_STEP 刻み未満の変化は見送る(alpha の脈動は
    // 毎フレーム掛かるので、先端が数十px 刻みで伸びても気づかれない)。
    // ただし 0 への遷移(危機の終わり)だけは必ず描き直して消し残りを防ぐ
    if (Math.abs(count - part.creepDrawn) < PP.PERF.CREEP_STEP &&
        !(count < 2 && part.creepDrawn >= 2)) return;
    part.creepDrawn = count;
    var g = part.creep.graphics;
    var pts = part.creepPts;
    g.clear();
    if (count < 2) { part.creep.updateCache(); return; }
    function trace(len) {
      g.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < len; i++) g.lineTo(pts[i].x, pts[i].y);
    }
    g.setStrokeStyle(PP.R * 2 + 4, "round", "round").beginStroke("rgba(120,0,0,0.5)");
    trace(count); g.endStroke();
    g.setStrokeStyle(PP.R * 0.9, "round", "round").beginStroke("rgba(255,60,20,0.5)");
    trace(Math.max(2, Math.round(count * 0.45))); g.endStroke();
    part.creep.updateCache();   // 描き直したフレームだけビットマップへ焼き直す
  }

  // ---------- 血の滴り・走査ノイズのプール ----------
  // 心拍のたびに Shape + Tween を作り捨てると、危機中ずっと細かいゴミが出続けて
  // GC のカクつきの種になる。Shape は使い回し、動きは update の自前積分で付ける
  // (fx.js のパーティクルプールと同じ思想の小型版。crisis レイヤー上に置きたい
  //  ので fx のプールは使わない — 帳や砲台との重なり順を変えないため)
  var dripFree = [], dripActive = [];      // {s, age, dur, y0, fall}
  var glitchFree = [], glitchActive = [];  // {s, age, dur}
  var crisisAudioOn = false;   // 警報ループを前フレームで更新したか(update 参照)

  // 滴りと走査ノイズの絵は「大きさが違うだけ」なので、一度焼いた canvas を
  // 全部で共有し、個体差は scale で付ける(course-view の光ドットと同じ手)。
  // 旧実装は spawn のたびに graphics を組み直していた=cache も効かず、
  // 生きている間ずっと毎フレームのベクタ再ラスタライズになっていた
  var dripCanvas = null, glitchCanvas = null;
  function bakeDrip() {
    var s = new createjs.Shape();
    s.graphics.beginFill("rgba(125,0,0,0.85)").drawRoundRect(0, 0, 5, 23, 2.5);
    s.cache(0, 0, 5, 23);
    return s.cacheCanvas;
  }
  function bakeGlitch() {
    var s = new createjs.Shape();
    s.graphics.beginFill("rgba(255,40,20,0.55)").drawRect(0, 0, 8, 8);
    s.cache(0, 0, 8, 8);
    return s.cacheCanvas;
  }

  // 画面が血を流す。心拍の頭で滴らせる
  function drip() {
    var rec = dripFree.pop();
    if (!rec) {
      if (!dripCanvas) dripCanvas = bakeDrip();
      var s = new createjs.Bitmap(dripCanvas);
      PP.layers.crisis.addChild(s);
      rec = { s: s, age: 0, dur: 0, y0: 0, fall: 0 };
    }
    var w = 3 + Math.random() * 4;
    var h = 12 + Math.random() * 22;
    rec.s.scaleX = w / 5;    // 焼き込み(5×23)からの伸縮。角丸の歪みは判別不可
    rec.s.scaleY = h / 23;
    rec.s.x = 20 + Math.random() * (PP.W - 40);
    rec.s.y = rec.y0 = 62;
    rec.s.alpha = 0.9;
    rec.s.visible = true;
    rec.age = 0;
    rec.dur = 1.4 + Math.random() * 1.4;
    rec.fall = 90 + Math.random() * 160;
    dripActive.push(rec);
  }

  // 赤い走査ノイズ。画面のどこかに横一線の赤いラインが走り、すぐ消える。
  // 「映像が乱れる」不穏さで、通常状態ではないことを突きつける
  function glitchLine() {
    var rec = glitchFree.pop();
    if (!rec) {
      if (!glitchCanvas) glitchCanvas = bakeGlitch();
      var s = new createjs.Bitmap(glitchCanvas);
      s.compositeOperation = "lighter";
      s.scaleX = PP.W / 8;   // 横幅は常に全画面(単色なので伸ばしても同じ絵)
      PP.layers.crisis.addChild(s);
      rec = { s: s, age: 0, dur: 0.12 };
    }
    var h = 2 + Math.random() * 2;
    rec.s.scaleY = h / 8;
    rec.s.x = 0;
    rec.s.y = 62 + Math.random() * (PP.H - 80);
    rec.s.alpha = 1;
    rec.s.visible = true;
    rec.age = 0;
    glitchActive.push(rec);
  }

  // プールの1フレームぶんの前進。動きは元の Tween と同じ式:
  //   滴り  = y が quadIn(加速して落ちる)・alpha も同じ曲線で 0.9→0
  //   ノイズ = alpha が直線で 1→0(元の Tween も ease 指定なし=直線)
  function updateVeils(dt) {
    for (var i = dripActive.length - 1; i >= 0; i--) {
      var r = dripActive[i];
      r.age += dt;
      var k = r.age / r.dur;
      if (k >= 1) {
        r.s.visible = false;
        dripFree.push(r);
        dripActive[i] = dripActive[dripActive.length - 1];
        dripActive.pop();
        continue;
      }
      var e = k * k;
      r.s.y = r.y0 + r.fall * e;
      r.s.alpha = 0.9 * (1 - e);
    }
    for (var j = glitchActive.length - 1; j >= 0; j--) {
      var gr = glitchActive[j];
      gr.age += dt;
      var gk = gr.age / gr.dur;
      if (gk >= 1) {
        gr.s.visible = false;
        glitchFree.push(gr);
        glitchActive[j] = glitchActive[glitchActive.length - 1];
        glitchActive.pop();
        continue;
      }
      gr.s.alpha = 1 - gk;
    }
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
    // 危険BGMのヒステリシス: 入りは即、抜けは bgmRelease 秒待ってから。
    // チェーンが危機の境界(want=0 付近)で前後に揺れるたびに setDanger が
    // on/off を往復すると、そのたび BGM が頭出し+クロスフェードをやり直して
    // しまう(音のバタつきと 33ms タイマーの無駄)。状態が変わる瞬間だけ呼ぶ
    if (maxWant > 0) {
      st.dangerHold = 0;
      if (!st.danger) { st.danger = true; PP.audio.setDanger(true); }
    } else if (st.danger) {
      st.dangerHold += dt;
      if (st.dangerHold >= C.bgmRelease) { st.danger = false; PP.audio.setDanger(false); }
    }
    // 警報ループの更新は「鳴っている(可能性のある)間」だけ呼ぶ。
    // 深さ 0 のまま毎フレーム呼んでも audio 側は早期 return するが、
    // 危機でもないのに毎フレーム関数を1本呼び続ける必要はない。
    // 0 へ落ちた最初の1回だけは必ず呼んで、鳴り残しを止める
    if (n > 0 || crisisAudioOn) {
      PP.audio.crisis(n);
      crisisAudioOn = n > 0;
    }

    if (st.level > 0) {
      var beat = C.beatSlow + (C.beatFast - C.beatSlow) * n;
      var was = Math.floor(st.phase);
      st.phase += dt / beat;
      if (Math.floor(st.phase) > was) {
        PP.fx.shake(C.shake * (0.35 + 0.65 * n), 0.2);
        if (n > C.growlAt) PP.audio.growl((n - C.growlAt) / (1 - C.growlAt));
        var dr = (n - C.dripAt) / (1 - C.dripAt);
        if (dr > 0) {
          // 低負荷モード(main.js の低FPS検知)では滴りの頻度を落とす
          if (PP.quality === 0) dr *= PP.PERF.LOW.dripMul;
          st.drip += dr * 2.5;
          while (st.drip >= 1) { st.drip -= 1; drip(); }
        }
        // 心拍の頭: 画面の縁がカッと赤く光る(下の減衰でスッと引く)
        edgePulse.alpha = Math.min(0.85, 0.7 * n);
        // 深い危機では映像が乱れる(赤い走査ノイズ)。低負荷モードでは省く
        if (n > C.glitchAt && (PP.quality !== 0 || PP.PERF.LOW.glitch)) {
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
    // 指数減衰は漸近するだけで厳密には 0 にならない。alpha が僅かでも残っていると
    // EaselJS は全画面の帯を毎フレーム合成し続けるので、見えない明るさになったら
    // 0 に切り落として描画そのものをスキップさせる(alpha<=0 は描画されない)
    if (edgePulse.alpha < 0.01) edgePulse.alpha = 0;

    // 凶兆: 深い危機でだけ、視界に「☠ GAME OVER ☠」が一瞬浮かんでは消える。
    // 確率的に数フレームだけ現れ、位置も僅かにズレる(グリッチ風のちらつき)
    if (st.level > 0 && n > C.omenAt &&
        Math.random() < 0.10 + 0.18 * (n - C.omenAt) / (1 - C.omenAt)) {
      omen.alpha = 0.08 + 0.24 * Math.random();
      omen.x = PP.W / 2 + (Math.random() - 0.5) * 16;
      omen.y = PP.H / 2 + (Math.random() - 0.5) * 12;
    } else {
      omen.alpha *= 0.75;   // 数フレームで残像ごと消える
      if (omen.alpha < 0.02) omen.alpha = 0;   // edgePulse と同じ理由の 0 クランプ
    }

    // 樽ごとの灯り・這う赤・呼吸・ドクロ・宣告(そのレーン自身の深さで灯す)
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi];
      var nLane = part.want / 2;             // このレーンの深さ(0..1)

      // 完全に静まったレーン(このレーンも全体の心拍も休止)は、休止状態へ
      // 戻し終えた次のフレームから丸ごと飛ばす。平常時のプレイでは crisis の
      // 仕事をゼロにするための早回り(wasIdle は「前のフレームで休止値まで
      // 戻し終えた」の印。最初の休止フレームだけは下を通って値を戻す)
      var idle = part.want === 0 && st.level === 0;
      if (idle && part.wasIdle) continue;   // announced/deep も休止値へ戻し済み
      part.wasIdle = idle;

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
            PP.setSkullColor(sk, part.want >= 1 ? "#ff2f2f" : "#ff5d5d");
          } else {
            sk.scaleX = sk.scaleY = 1;
            PP.setSkullColor(sk, "#f0e6c8");
          }
        }
      }

      // 口が開いた瞬間の宣告(危機に入るたび1回だけ)
      if (part.want > 0 && !part.announced) {
        part.announced = true;
        PP.fx.floatText(PP.i18n.t("crisis.mouthOpen"), part.mouth.x - 80, part.mouth.y - 46, "#ff5d5d", 21);
      } else if (part.want === 0) {
        part.announced = false;
      }

      // 呑まれた / 押し戻した
      var deep = depthOf(part.lead || 0, part.holeD || 1);
      if (deep > part.deep) swallowed(part, deep);
      else if (deep < part.deep) pushedBack(part);
      part.deep = deep;
    }

    // 滴り・走査ノイズを進める(プールの自前積分)。危機を抜けた後も、
    // 空中に残っている滴りが消えきるまでは動かし続ける
    updateVeils(dt);
  }

  // 玉が1個ぶん樽に落ちた。残り個数を突きつける
  function swallowed(part, deep) {
    var left = Math.max(0, PP.barrelCap() + 1 - deep);
    flash.alpha = 0.5;
    createjs.Tween.get(flash, { override: true }).to({ alpha: 0 }, 400);
    PP.fx.shake(15, 0.55);
    PP.fx.burst(part.mouth.x, part.mouth.y, "#ff4020", 20);
    PP.fx.burst(part.mouth.x, part.mouth.y, "#ffb060", 10);
    PP.fx.floatText(left > 0 ? PP.i18n.t("crisis.swallowedLeft", { n: left }) : PP.i18n.t("crisis.swallowed"),
      part.mouth.x - 70, part.mouth.y - 44, "#ff3535", 24);
    PP.audio.swallowed(deep);
  }

  // 押し戻した。安堵は与えるが、演出はゆっくりしか退かない
  function pushedBack(part) {
    PP.fx.floatText(PP.i18n.t("crisis.pushedBack"), part.mouth.x - 70, part.mouth.y - 44, "#8ef0d0", 21);
    PP.audio.pushedBack();
  }

  // 危機の外(クリア・ゲームオーバー)へ抜けるときは音も絵も畳む
  function stop() {
    if (!built) return;
    // ヒステリシス中でも危険BGMは畳む(st は下で作り直すので旗も消える)。
    // setDanger 側に「同じ曲なら何もしない」ガードがあるので冪等
    PP.audio.setDanger(false);
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
      parts[pi].creep.updateCache();
      parts[pi].creepDrawn = -1;
      parts[pi].announced = false;
      parts[pi].deep = 0;
      parts[pi].wasIdle = false;   // 次の update で一度は休止値へ戻す経路を通す
      var bp = PP.barrels && PP.barrels[pi];
      if (bp) {
        bp.back.scaleX = bp.back.scaleY = 1;
        bp.front.scaleX = bp.front.scaleY = 1;
      }
    }
    // 垂れている血・走査ノイズを片付ける。Shape はプールの持ち物なので
    // removeChild せず、隠して空き箱(free)へ戻すだけでよい
    for (var di = dripActive.length - 1; di >= 0; di--) {
      dripActive[di].s.visible = false;
      dripFree.push(dripActive[di]);
    }
    dripActive.length = 0;
    for (var gi = glitchActive.length - 1; gi >= 0; gi--) {
      glitchActive[gi].s.visible = false;
      glitchFree.push(glitchActive[gi]);
    }
    glitchActive.length = 0;
    PP.audio.crisis(0);
  }

  function reset() {
    stop();
    for (var pi = 0; pi < parts.length; pi++) {
      var bp = PP.barrels && PP.barrels[pi];
      if (bp && bp.skull) {
        bp.skull.scaleX = bp.skull.scaleY = 1;
        PP.setSkullColor(bp.skull, "#f0e6c8");
      }
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
    relocate: relocate,
    // 今の危機の深さ(0=平常 〜 2=樽あふれ寸前。滑らかに追従する内部値)。
    // 骸骨玉が「危機中は撃たない」判定に使う(skull.js)
    level: function () { return st.level; }
  };
})();
