/* =========================================================
 * hud.js — HUD(スコア等・生存ゲージ・パワーアップ)とオーバーレイ
 *
 * 真鍮×グラスの重厚モダン。上部バーは暗いガラス板に真鍮のトリムとリベットを
 * 乗せ、各ステータスは彫金プレート風のスロットに置く。数値は Cinzel、日本語
 * ラベルはシステムフォントにフォールバックする。スコアはカウントアップ、コンボ
 * はポップ+色段階、生存ゲージは金の流動フィル+残り僅少で赤パルス。
 * 公開 API(build/update/updateEffects/buildOverlay/showOverlay/hideOverlay)は
 * 従来どおり。バーの高さ 44px は盤面の上端境界なので変えない。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;
  var W = PP.W;

  var hudLevel, hudScore, hudWave, hudCombo, hudEffects, effectsChip, hudCoinLife;
  var gaugeBar, gaugeGlow, gaugeText;
  var overlayTitle, overlaySub, overlayBg, overlayPanel, overlayGlow, overlayDiv;
  // 難易度ボタン(【課題1】)。難易度は「1回の出航(ラン)」単位で選ぶものなので、
  // 新しいランが始まる画面(タイトル / ゲームオーバー / 全ステージ制覇後)だけに出す。
  // ステージクリア画面では出さない = キャンペーンの途中では変えられない。
  var diffCont, diffShapes = [], diffRects = [];
  var DIFF_BTN = { w: 172, h: 56, gap: 16 };
  // ゲームオーバー画面の進路ボタン(⚓再挑戦 / 🏠タイトルへ)。over 画面だけに出す
  var overCont, overRects = [];
  var OVER_BTN = { w: 250, h: 54, gap: 28 };
  // ポーズボタン(⏸)。プレイ中だけバーの下・右端に出す。クリック判定は
  // 難易度ボタンと同じ「矩形当たり判定」方式(発射クリックと混ざらないため)
  var pauseBtn = null;
  var PAUSE_RECT = { x: W - 46, y: 74, w: 36, h: 36 };
  // ⇄ 交換はタッチ端末では DOM の仮想ボタン(index.html の #tSwap)が担当する。
  // キャンバス内ボタンは廃止したが、判定関数(hitSwapBtn)は互換のため残してある
  var swapBtn = null;
  var SWAP_RECT = { x: W - 116, y: PP.H - 104, w: 92, h: 80 };
  // タッチ端末では見た目はそのまま、当たり判定だけ指の太さぶん広げる
  var TOUCH_PAD = PP.TOUCH ? 12 : 0;

  // レイアウト(バーは 62px。1段目 y=104 に触れない高さで、文字を大きく取る)
  var BAR = 62;
  var GAUGE_X = 500, GAUGE_W = 182, GAUGE_H = 18, GAUGE_Y = 30;

  // フォント(数値・ラベルは Cinzel、絵文字はシステム絵文字、効果は Meiryo)
  var F_LBL  = '600 12px "Cinzel", serif';
  var F_VAL  = '700 24px "Cinzel", serif';
  var F_ICON = '19px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  var F_GT   = '800 22px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif';
  var F_EFF  = 'bold 16px "Meiryo", sans-serif';

  var C_LBL = "#caa96a", C_VAL = "#f7ecce", C_TEAL = "#8ef0d0";

  // 内部アニメ用
  var dispScore = 0, lastCombo = 0, animT = 0, lastNow = 0;
  // 前フレームに描いた値(同じ値ならテキスト差し替え・チップ再描画を飛ばす)
  var lastScoreDrawn = null, lastEffectsText = null;
  // 生存ゲージの形状キー(同じ形なら clear→グラデ生成→再描画を飛ばす)と
  // 僅少グローの点灯状態(消灯への切り替わりで一度だけ clear する)
  var lastGaugeKey = null, gaugeGlowOn = false;
  // チップ構築の間引き用(初回は必ず構築する)
  var effAcc = 1;

  // 桁区切り
  function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function build() {
    var L = PP.layers.hud;
    var mid = BAR / 2;

    // ---- 上部バー(半透明ガラス + 真鍮トリム + リベット) ----
    // 帯は海が透けて見える半透明。下端の真鍮トリムだけははっきり残して縁を締める
    var bar = new createjs.Shape();
    var g = bar.graphics;
    g.beginLinearGradientFill(["rgba(24,32,46,0.55)", "rgba(8,12,20,0.5)"], [0, 1], 0, 0, 0, BAR)
      .drawRect(0, 0, W, BAR);
    // 上端のガラスの照り
    g.beginLinearGradientFill(["rgba(140,170,205,0.15)", "rgba(140,170,205,0)"], [0, 1], 0, 0, 0, 18)
      .drawRect(0, 0, W, 18);
    g.beginFill("rgba(255,255,255,0.08)").drawRect(0, 0, W, 1);
    // 真鍮の下トリム(厚め・金属グラデ)+ その下の影と上の金グロー
    g.beginFill("rgba(240,200,110,0.12)").drawRect(0, BAR - 7, W, 2);
    g.beginLinearGradientFill(["#6e5018", "#e8c877", "#f6e6ac", "#ca9d47", "#5f4614"],
        [0, 0.28, 0.5, 0.72, 1], 0, BAR - 5, 0, BAR).drawRect(0, BAR - 5, W, 5);
    g.beginFill("rgba(0,0,0,0.42)").drawRect(0, BAR, W, 2);
    // セクション仕切り(細い真鍮ライン)
    [98, 292, 384, 490, 812].forEach(function (dx) {
      g.beginLinearGradientFill(["rgba(202,169,106,0)", "rgba(202,169,106,0.35)", "rgba(202,169,106,0)"],
        [0, 0.5, 1], 0, 12, 0, BAR - 8).drawRect(dx, 12, 1.4, BAR - 20);
    });
    // リベット
    [14, W - 14].forEach(function (rx) {
      g.beginRadialGradientFill(["#f6e2a0", "#8a6a2a"], [0, 1], rx - 1.2, mid - 2, 1, rx, mid, 6)
        .drawCircle(rx, mid, 5.4);
      g.beginFill("rgba(255,248,220,0.6)").drawCircle(rx - 1.6, mid - 2, 1.5);
    });
    L.addChild(bar);

    // ---- ステータス(絵文字アイコン + ラベル + 数値) ----
    function stat(icon, label, x, valColor) {
      var ic = new createjs.Text(icon, F_ICON, "#ffffff");
      ic.x = x; ic.y = mid; ic.textBaseline = "middle";
      var lb = new createjs.Text(label, F_LBL, C_LBL);
      lb.x = x + 27; lb.y = 9;
      var v = new createjs.Text("", F_VAL, valColor || C_VAL);
      v.x = x + 27; v.y = 25;
      v.shadow = new createjs.Shadow("rgba(0,0,0,0.65)", 0, 1, 3);
      L.addChild(ic, lb, v);
      return v;
    }
    hudLevel = stat("⚓", "LEVEL", 18);
    hudScore = stat("💰", "SCORE", 106);
    hudWave  = stat("🌊", "WAVE", 302);
    hudCombo = stat("🔥", "COMBO", 396);

    // ---- 生存ゲージ ----
    var gl = new createjs.Text("SURVIVAL", F_LBL, C_LBL);
    gl.x = GAUGE_X; gl.y = 9;
    L.addChild(gl);
    gaugeGlow = new createjs.Shape();       // 低下時の赤/teal グロー(枠の外)
    gaugeGlow.x = GAUGE_X; gaugeGlow.y = GAUGE_Y;
    L.addChild(gaugeGlow);
    gaugeBar = new createjs.Shape();
    gaugeBar.x = GAUGE_X; gaugeBar.y = GAUGE_Y;
    L.addChild(gaugeBar);
    gaugeText = new createjs.Text("", F_GT, C_VAL);
    gaugeText.x = GAUGE_X + GAUGE_W + 12; gaugeText.y = mid;
    gaugeText.textBaseline = "middle";
    gaugeText.shadow = new createjs.Shadow("rgba(0,0,0,0.6)", 0, 1, 3);
    L.addChild(gaugeText);

    // ---- 有効パワーアップ(ピル型チップ + アイコン+残り秒) ----
    effectsChip = new createjs.Shape();
    L.addChild(effectsChip);
    hudEffects = new createjs.Text("", F_EFF, C_TEAL);
    hudEffects.x = 826; hudEffects.y = mid; hudEffects.textBaseline = "middle";
    hudEffects.shadow = new createjs.Shadow("rgba(20,120,110,0.7)", 0, 0, 8);
    L.addChild(hudEffects);

    // 【課題5】コインとライフの表示(右端)
    hudCoinLife = new createjs.Text("", '800 18px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', C_VAL);
    hudCoinLife.x = W - 70; hudCoinLife.y = mid;   // 右上の全画面ボタン(⛶)を避ける
    hudCoinLife.textAlign = "right"; hudCoinLife.textBaseline = "middle";
    hudCoinLife.shadow = new createjs.Shadow("rgba(0,0,0,0.65)", 0, 1, 3);
    L.addChild(hudCoinLife);

    // ---- ポーズボタン(全画面ボタン⛶の下に置く真鍮の小ボタン) ----
    pauseBtn = new createjs.Container();
    var pb = new createjs.Shape();
    var r = PAUSE_RECT;
    pb.graphics
      .beginLinearGradientFill(["rgba(40,30,14,0.72)", "rgba(16,11,5,0.72)"], [0, 1], r.x, r.y, r.x, r.y + r.h)
      .drawRoundRect(r.x, r.y, r.w, r.h, 9)
      .setStrokeStyle(1).beginStroke("rgba(210,168,96,0.5)")
      .drawRoundRect(r.x, r.y, r.w, r.h, 9);
    // ⏸ の縦二本線(絵文字だと環境で見た目が揺れるので図形で描く)
    pb.graphics.beginFill("#f4e2a0")
      .drawRoundRect(r.x + 11, r.y + 10, 5, 16, 2)
      .drawRoundRect(r.x + 20, r.y + 10, 5, 16, 2);
    pauseBtn.addChild(pb);
    pauseBtn.visible = false;
    L.addChild(pauseBtn);

    dispScore = PP.game.score;
  }

  function update() {
    var g = PP.game;
    hudLevel.text = String(g.level);
    // 波番号はレーンごとに進むので、一番進んでいるレーンの波数を表示する
    var wave = 0;
    for (var wi = 0; wi < g.lanes.length; wi++) if (g.lanes[wi].wave > wave) wave = g.lanes[wi].wave;
    // ボス戦は補給が絶え間ない(波の番号に意味がない)ので「∞」を出す
    hudWave.text = g.bossMode ? "∞" : String(wave);
    hudCombo.text = g.combo >= 2 ? "x" + g.combo : "-";
    // コンボの色段階(2→黄 / 4→橙 / 6→ピンク / 8+→赤)
    hudCombo.color = g.combo < 2 ? C_VAL
      : g.combo < 4 ? "#ffd15a" : g.combo < 6 ? "#ff9a3c"
      : g.combo < 8 ? "#ff5d8f" : "#ff3b5b";
    // コンボが上がった瞬間にポップ
    if (g.combo > lastCombo && g.combo >= 2) {
      createjs.Tween.get(hudCombo, { override: true })
        .to({ scaleX: 1.55, scaleY: 1.55 }, 0)
        .to({ scaleX: 1, scaleY: 1 }, 260, createjs.Ease.backOut);
    }
    lastCombo = g.combo;
    // 【課題5】コインとライフ(ライフ0は "-"、ライフ回復なしの難易度では "✕")。
    // 必要枚数は【強化】「換金術」で減ることがあるので PP.coinsPerLife() を読む
    hudCoinLife.text = "🪙 " + g.coins + "/" + PP.coinsPerLife() +
      "   ❤ " + (PP.diff().useLives === false ? "✕" : (g.lives > 0 ? g.lives : "-"));
  }

  // パワーアップ・状態異常のチップ行を組み立てて差し替える(0.25秒に1回)
  function rebuildEffectChips(g) {
    var parts = [];
    PP.POWERUPS.forEach(function (p) {
      if (p.dur > 0 && g.effects[p.id] > 0) parts.push(p.icon + Math.ceil(g.effects[p.id]));
    });
    // 状態異常(骸骨玉の被弾・パワーダウン)のチップ。ボス戦は boss.js の
    // updateChips が専用表示を持つので、こちらには出さない(二重表示防止)
    if (!g.bossMode) {
      var bfx = g.bossFx;
      // freeze は ⛓(パワーアップ「錨⚓」のチップと同じ行に並ぶので記号を分ける)
      if (bfx.freeze > 0) parts.push("⛓" + Math.ceil(bfx.freeze));
      if (bfx.addle > 0) parts.push("🌀" + Math.ceil(bfx.addle));
      if (bfx.ink > 0) parts.push("🦑" + Math.ceil(bfx.ink));
      if (bfx.shotSlow > 0) parts.push("⏳" + Math.ceil(bfx.shotSlow));
    }
    if (g.special) {
      var spIcon = g.special === "missile" ? "🚀" : "💣";
      parts.unshift(spIcon + (g.specialLoaded ? " 装填" : " 待機"));
    }
    // 【新】虹玉のストック表示。装填中(加護で砲身に入っている)は「装填」表記、
    // それ以外は残数のみ。0個のときは出さない(枠の圧迫を避ける)
    if (PP.upgrades.wildArmed()) parts.unshift("🌈 装填 x" + PP.game.wildCharges);
    else if ((PP.game.wildCharges || 0) > 0) parts.unshift("🌈x" + PP.game.wildCharges);
    // 表示文字列(残り秒は Math.ceil なので約1秒に1回しか変わらない)が同じなら、
    // 文字幅の計測(getMeasuredWidth はキャンバスでの実測=重い)とチップの
    // 再描画を丸ごと飛ばす。チップの形は文字列の幅だけで決まるので絵は同一。
    var effText = parts.join("   ");
    if (effText !== lastEffectsText) {
      lastEffectsText = effText;
      hudEffects.text = effText;
      effectsChip.graphics.clear();
      if (parts.length) {
        var tw = hudEffects.getMeasuredWidth();
        effectsChip.graphics
          .beginFill("rgba(18,58,54,0.5)")
          .drawRoundRect(hudEffects.x - 12, 15, tw + 24, 32, 16)
          .beginStroke("rgba(142,240,208,0.5)").setStrokeStyle(1.2)
          .drawRoundRect(hudEffects.x - 12, 15, tw + 24, 32, 16);
      }
    }
  }

  // 毎tick: スコアのカウントアップ、生存ゲージ、時間制パワーアップの残り
  function updateEffects() {
    var g = PP.game;
    var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var dt = lastNow ? Math.min((now - lastNow) / 1000, 0.05) : 0;
    lastNow = now; animT += dt;

    // updateEffects はプレイ中しか呼ばれないので、ここでボタンを出す
    // (プレイ以外の画面では showOverlay() が隠す)
    if (pauseBtn) pauseBtn.visible = true;
    if (swapBtn) swapBtn.visible = true;

    // スコアのカウントアップ(急変・減少時は即反映)
    if (g.score < dispScore || Math.abs(g.score - dispScore) > 200000) dispScore = g.score;
    else dispScore += (g.score - dispScore) * Math.min(1, dt * 9);
    if (Math.abs(g.score - dispScore) < 0.6) dispScore = g.score;
    // 丸めた表示値が前フレームと同じなら、カンマ整形(正規表現)と差し替えを飛ばす
    var rounded = Math.round(dispScore);
    if (rounded !== lastScoreDrawn) {
      lastScoreDrawn = rounded;
      hudScore.text = comma(rounded);
    }

    // パワーアップのチップ。表示値は Math.ceil の秒なので、配列構築+join は
    // 0.25 秒に1回で十分(最終的な描画スキップは従来通り文字列比較で判定)
    effAcc += dt;
    if (effAcc >= 0.25) { effAcc = 0; rebuildEffectChips(g); }

    // 生存ゲージ
    // テキスト(残り秒など)は毎フレーム更新するが、バー形状は「描画キー」が
    // 前フレームと変わったときだけ再構築する。線形グラデの生成はフレームごとに
    // 行うと無駄が大きい(特にボス戦は表示が完全に不変なのに毎フレーム作っていた)
    var ratio = 0, low = false, fillW = 0, gKey;
    if (g.bossMode) {
      // ボス戦: 生存ゲージの代わりに討伐の合図(深紅で満たして
      // 「時間切れ待ちではない」ことを示す)。1戦につき1回しか描かない
      gKey = "boss";
      gaugeText.text = "討伐せよ!";
      gaugeText.color = "#ffb0a0";
    } else if (g.finishing) {
      gKey = "fin";
      var left = 0;
      for (var li = 0; li < g.lanes.length; li++) left += g.lanes[li].balls.length;
      gaugeText.text = "残り " + left;
      gaugeText.color = C_TEAL;
    } else {
      ratio = g.timeTotal > 0 ? Math.max(0, g.timeLeft / g.timeTotal) : 0;
      low = ratio < 0.25;
      if (ratio > 0.01) fillW = Math.max(6, (GAUGE_W - 3) * ratio);
      gKey = "n:" + Math.round(fillW) + (low ? "L" : "");
      gaugeText.text = Math.max(0, g.timeLeft).toFixed(1) + "s";
      gaugeText.color = low ? "#ff8a6a" : C_VAL;
    }

    // 残り僅少の赤く脈打つグローだけは毎フレーム(点滅アニメ)。消灯は一度だけ clear
    if (fillW > 0 && low) {
      var glow = gaugeGlow.graphics; glow.clear();
      var pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(animT * 7));
      glow.beginStroke("rgba(255,70,60," + pulse.toFixed(3) + ")").setStrokeStyle(3.5)
        .drawRoundRect(-1.5, -1.5, GAUGE_W + 3, GAUGE_H + 3, 8);
      gaugeGlowOn = true;
    } else if (gaugeGlowOn) {
      gaugeGlow.graphics.clear();
      gaugeGlowOn = false;
    }

    if (gKey === lastGaugeKey) return;
    lastGaugeKey = gKey;

    var gg = gaugeBar.graphics; gg.clear();
    // 枠(暗ガラス + 真鍮縁)
    gg.beginFill("rgba(4,8,12,0.7)").drawRoundRect(0, 0, GAUGE_W, GAUGE_H, 7);

    if (g.bossMode) {
      gg.beginLinearGradientFill(["#ff9a8a", "#e04848", "#7a1420"], [0, 0.5, 1], 0, 0, 0, GAUGE_H)
        .drawRoundRect(1.5, 1.5, GAUGE_W - 3, GAUGE_H - 3, 5.5);
      gg.setStrokeStyle(1.5).beginStroke("#ff6a5a").drawRoundRect(0, 0, GAUGE_W, GAUGE_H, 7);
      return;
    }

    if (g.finishing) {
      gg.beginLinearGradientFill(["#b6ffe6", "#8ef0d0", "#3fbfa0"], [0, 0.5, 1], 0, 0, 0, GAUGE_H)
        .drawRoundRect(1.5, 1.5, GAUGE_W - 3, GAUGE_H - 3, 5.5);
      gg.setStrokeStyle(1.5).beginStroke("#8ef0d0").drawRoundRect(0, 0, GAUGE_W, GAUGE_H, 7);
      return;
    }

    if (fillW > 0) {
      var cols = low ? ["#ff9a6a", "#ff5b4a", "#c81e1e"] : ["#ffe89a", "#f0c040", "#b8860b"];
      gg.beginLinearGradientFill(cols, [0, 0.5, 1], 0, 0, 0, GAUGE_H)
        .drawRoundRect(1.5, 1.5, fillW, GAUGE_H - 3, 5.5);
      // 上端の照り
      gg.beginFill("rgba(255,255,255,0.28)").drawRoundRect(2.5, 2.5, fillW - 2, 3, 2);
    }
    // 目盛り
    gg.setStrokeStyle(1).beginStroke("rgba(0,0,0,0.35)");
    for (var t = 1; t < 4; t++) { var mx = 1.5 + (GAUGE_W - 3) * (t / 4); gg.moveTo(mx, 2).lineTo(mx, GAUGE_H - 2); }
    gg.endStroke();
    gg.setStrokeStyle(1.5).beginStroke("#c9a86a").drawRoundRect(0, 0, GAUGE_W, GAUGE_H, 7);
  }

  // ---------- オーバーレイ ----------
  var SKINS = {
    normal: { bg: "rgba(6,10,18,0.80)", p1: "#2a1f10", p2: "#150e06", edge: "#f0c040",
              glow: "rgba(240,192,64,0.5)", title: "#ffdf8a", sub: "#f5e8c8", fade: 320 },
    doom:   { bg: "rgba(4,0,0,0.6)", p1: "#1a0505", p2: "#0a0202", edge: "#8b0f0f",
              glow: "rgba(200,20,20,0.5)", title: "#ff3030", sub: "#c8a0a0", fade: 1400 }
  };
  var PANEL = { w: 540, h: 250 };
  function panelBox() { return { x: (W - PANEL.w) / 2, y: (PP.H - PANEL.h) / 2 }; }

  function buildOverlay() {
    var O = PP.layers.overlay;
    overlayBg = new createjs.Shape(); O.addChild(overlayBg);
    overlayGlow = new createjs.Shape(); O.addChild(overlayGlow);
    overlayPanel = new createjs.Shape(); O.addChild(overlayPanel);
    overlayDiv = new createjs.Shape(); O.addChild(overlayDiv);
    overlayTitle = new createjs.Text("", 'bold 38px "Cinzel Decorative","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffdf8a");
    overlayTitle.textAlign = "center";
    overlayTitle.x = W / 2; overlayTitle.y = panelBox().y + 34;
    overlayTitle.shadow = new createjs.Shadow("rgba(0,0,0,0.7)", 0, 3, 8);
    O.addChild(overlayTitle);
    overlaySub = new createjs.Text("", '17px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#f5e8c8");
    overlaySub.textAlign = "center"; overlaySub.lineHeight = 27;
    overlaySub.x = W / 2; overlaySub.y = panelBox().y + 108;
    O.addChild(overlaySub);
    buildDiffButtons(O);   // 難易度ボタン(【課題1】)はオーバーレイと一緒に表示される
    buildOverButtons(O);   // ゲームオーバーの進路ボタン(over 画面だけ visible)
    O.visible = false;
    // 最下段(クリック促し等)をゆっくり明滅させる
    // (ignoreGlobalPause: ポーズ中も Ticker.paused に巻き込まれず明滅を続ける)
    createjs.Tween.get(overlaySub, { loop: true, ignoreGlobalPause: true })
      .to({ alpha: 0.55 }, 900, createjs.Ease.quadInOut)
      .to({ alpha: 1 }, 900, createjs.Ease.quadInOut);
  }

  // ---------- 難易度ボタン(【課題1】) ----------
  // パネルの下に4つ並べる。クリック判定は main.js が hitDifficulty で行う
  // (CreateJS のイベントではなく矩形判定にして、発射クリックと混ざらないようにする)。
  function buildDiffButtons(O) {
    diffCont = new createjs.Container();
    var keys = PP.DIFFICULTY_ORDER;
    var total = keys.length * DIFF_BTN.w + (keys.length - 1) * DIFF_BTN.gap;
    var x0 = (W - total) / 2;
    var y = panelBox().y + PANEL.h + 34;
    var cap = new createjs.Text("難易度をえらぶ(1〜4 キーでも選べる)", '13px "Meiryo", sans-serif', C_LBL);
    cap.textAlign = "center"; cap.x = W / 2; cap.y = y - 22;
    diffCont.addChild(cap);
    keys.forEach(function (key, i) {
      var bx = x0 + i * (DIFF_BTN.w + DIFF_BTN.gap);
      var s = new createjs.Shape();
      diffCont.addChild(s);
      var t1 = new createjs.Text((i + 1) + "  " + key.toUpperCase(), F_LBL, C_LBL);
      t1.textAlign = "center"; t1.x = bx + DIFF_BTN.w / 2; t1.y = y + 9;
      var t2 = new createjs.Text(PP.DIFFICULTY[key].name, 'bold 17px "Meiryo", sans-serif', C_VAL);
      t2.textAlign = "center"; t2.x = bx + DIFF_BTN.w / 2; t2.y = y + 27;
      diffCont.addChild(t1, t2);
      diffShapes.push(s);
      diffRects.push({ key: key, x: bx, y: y, w: DIFF_BTN.w, h: DIFF_BTN.h });
    });
    O.addChild(diffCont);
    redrawDiffButtons();
  }

  // ---------- ゲームオーバーの進路ボタン ----------
  // パネルの下に2つ並べる(難易度ボタンと同じ「矩形当たり判定」方式)。
  // 「再挑戦」= コンティニュー(この海域から、スコア0・強化維持)、
  // 「タイトルへ」= ランを畳んで最初の画面に帰る。クリック判定は input.js。
  function buildOverButtons(O) {
    overCont = new createjs.Container();
    var defs = [
      { id: "continue", label: "⚓ この海域から再挑戦", hot: true },
      { id: "title",    label: "🏠 タイトルへ戻る",     hot: false }
    ];
    var total = defs.length * OVER_BTN.w + (defs.length - 1) * OVER_BTN.gap;
    var x0 = (W - total) / 2;
    var y = panelBox().y + PANEL.h + 34;
    if (!PP.TOUCH) {
      var cap = new createjs.Text("R / T キーでも選べる", '13px "Meiryo", sans-serif', C_LBL);
      cap.textAlign = "center"; cap.x = W / 2; cap.y = y - 22;
      overCont.addChild(cap);
    }
    defs.forEach(function (d, i) {
      var bx = x0 + i * (OVER_BTN.w + OVER_BTN.gap);
      var s = new createjs.Shape();
      s.graphics
        .beginLinearGradientFill(
          d.hot ? ["#3a2c12", "#241806"] : ["rgba(20,28,40,0.85)", "rgba(8,12,20,0.85)"],
          [0, 1], bx, y, bx, y + OVER_BTN.h)
        .drawRoundRect(bx, y, OVER_BTN.w, OVER_BTN.h, 12)
        .setStrokeStyle(d.hot ? 2.5 : 1.2)
        .beginStroke(d.hot ? "#f0c040" : "rgba(202,169,106,0.5)")
        .drawRoundRect(bx, y, OVER_BTN.w, OVER_BTN.h, 12);
      overCont.addChild(s);
      var t = new createjs.Text(d.label, 'bold 17px "Meiryo", sans-serif', d.hot ? "#ffdf8a" : C_VAL);
      t.textAlign = "center";
      t.x = bx + OVER_BTN.w / 2; t.y = y + OVER_BTN.h / 2 - 9;
      overCont.addChild(t);
      overRects.push({ id: d.id, x: bx, y: y, w: OVER_BTN.w, h: OVER_BTN.h });
    });
    O.addChild(overCont);
    overCont.visible = false;
  }

  // (x, y) が進路ボタンの上なら "continue" / "title"(外れ・非表示中は null)
  function hitOverChoice(x, y) {
    if (!PP.layers.overlay.visible || !overCont || !overCont.visible) return null;
    for (var i = 0; i < overRects.length; i++) {
      var r = overRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  // 難易度を選び直せる画面か(= ここから新しいランが始まる画面か)。
  // over 画面はコンティニュー(同ラン継続)になったので難易度は変えられない
  function canPickDifficulty() {
    var st = PP.game.state;
    return st === "title" || st === "gameclear";
  }

  // 選択中のボタンだけ金縁で光らせる
  function redrawDiffButtons() {
    var sel = PP.game.difficulty;
    diffRects.forEach(function (r, i) {
      var g = diffShapes[i].graphics;
      var on = r.key === sel;
      g.clear();
      g.beginLinearGradientFill(
        on ? ["#3a2c12", "#241806"] : ["rgba(20,28,40,0.85)", "rgba(8,12,20,0.85)"],
        [0, 1], r.x, r.y, r.x, r.y + r.h)
        .drawRoundRect(r.x, r.y, r.w, r.h, 12);
      g.setStrokeStyle(on ? 2.5 : 1.2)
        .beginStroke(on ? "#f0c040" : "rgba(202,169,106,0.5)")
        .drawRoundRect(r.x, r.y, r.w, r.h, 12);
    });
  }

  // (x, y) が難易度ボタンの上なら、その難易度キーを返す(外れなら null)。
  // ボタンが出ていない画面(ステージクリア等)では常に null
  function hitDifficulty(x, y) {
    if (!PP.layers.overlay.visible || !diffCont || !diffCont.visible) return null;
    for (var i = 0; i < diffRects.length; i++) {
      var r = diffRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.key;
    }
    return null;
  }

  // 難易度が変わったのでボタンのハイライトを描き直す(main.js から呼ばれる)
  function setDifficulty() { redrawDiffButtons(); }

  function showOverlay(title, sub, skin) {
    var O = PP.layers.overlay;
    var s = SKINS[skin] || SKINS.normal;
    var b = panelBox();
    // 難易度ボタンは新しいランが始まる画面だけ(呼び出し側で state を先に確定させている)
    if (diffCont) diffCont.visible = canPickDifficulty();
    // 進路ボタン(再挑戦 / タイトルへ)はゲームオーバー画面だけ
    if (overCont) overCont.visible = PP.game.state === "over";

    overlayBg.graphics.clear();
    overlayBg.graphics.beginFill(s.bg).drawRect(0, 0, W, PP.H);
    // 中央へ寄せるヴィネット
    overlayBg.graphics.beginRadialGradientFill(
      ["rgba(0,0,0,0)", "rgba(0,0,0,0.4)"], [0.35, 1], W / 2, PP.H / 2, 120, W / 2, PP.H / 2, W * 0.6)
      .drawRect(0, 0, W, PP.H);

    // 外周のソフトグロー
    overlayGlow.graphics.clear();
    overlayGlow.graphics.beginRadialGradientFill([s.glow, "rgba(0,0,0,0)"], [0, 1],
      W / 2, b.y + PANEL.h / 2, 40, W / 2, b.y + PANEL.h / 2, PANEL.w * 0.62)
      .drawRoundRect(b.x - 30, b.y - 30, PANEL.w + 60, PANEL.h + 60, 40);

    // パネル(ガラス地 + 二重の金縁 + 内側の照り)
    var pg = overlayPanel.graphics; pg.clear();
    pg.beginLinearGradientFill([s.p1, s.p2], [0, 1], b.x, b.y, b.x, b.y + PANEL.h)
      .drawRoundRect(b.x, b.y, PANEL.w, PANEL.h, 18);
    pg.beginFill("rgba(255,240,200,0.05)").drawRoundRect(b.x + 3, b.y + 3, PANEL.w - 6, PANEL.h * 0.4, 14);
    pg.setStrokeStyle(3).beginStroke(s.edge).drawRoundRect(b.x, b.y, PANEL.w, PANEL.h, 18);
    pg.setStrokeStyle(1).beginStroke("rgba(255,246,210,0.35)").drawRoundRect(b.x + 5, b.y + 5, PANEL.w - 10, PANEL.h - 10, 14);
    // 四隅の飾り点
    [[b.x + 14, b.y + 14], [b.x + PANEL.w - 14, b.y + 14],
     [b.x + 14, b.y + PANEL.h - 14], [b.x + PANEL.w - 14, b.y + PANEL.h - 14]].forEach(function (c) {
      pg.beginFill(s.edge).drawCircle(c[0], c[1], 3);
    });

    // タイトル下の装飾ディバイダ(菱形 + 横線)
    overlayDiv.graphics.clear();
    var dy = b.y + 66, cx = W / 2;
    overlayDiv.graphics.beginStroke(s.edge).setStrokeStyle(1.5)
      .moveTo(cx - 130, dy).lineTo(cx - 12, dy).moveTo(cx + 12, dy).lineTo(cx + 130, dy).endStroke();
    overlayDiv.graphics.beginFill(s.edge)
      .moveTo(cx, dy - 6).lineTo(cx + 7, dy).lineTo(cx, dy + 6).lineTo(cx - 7, dy).closePath();

    overlayTitle.color = s.title; overlayTitle.text = title;
    overlaySub.color = s.sub; overlaySub.text = sub;

    if (pauseBtn) pauseBtn.visible = false;   // 全画面パネルの上にボタンを残さない
    if (swapBtn) swapBtn.visible = false;

    O.visible = true; O.alpha = 0;
    createjs.Tween.get(O, { override: true }).to({ alpha: 1 }, s.fade);
    // 金縁のシマー(スケールを僅かに脈動)
    createjs.Tween.get(overlayGlow, { loop: true, override: true, ignoreGlobalPause: true })
      .to({ alpha: 0.65 }, 1400, createjs.Ease.quadInOut)
      .to({ alpha: 1 }, 1400, createjs.Ease.quadInOut);
  }

  function hideOverlay() { PP.layers.overlay.visible = false; }

  // ---------- ポーズ画面(pause.js から呼ばれる) ----------
  // 既存のオーバーレイをそのまま使う。Ticker.paused 中はフェードインの
  // Tween が凍結して真っ暗なままになるので、Tween を殺して即座に全表示する
  function showPause(reason) {
    showOverlay("⚓ PAUSE ⚓",
      reason === "auto"
        ? "船の外に出ていたので錨を下ろして停泊中\n用が済んだら、" + (PP.TOUCH ? "タップで再開" : "クリックか P キーで再開")
        : "錨を下ろして停泊中…\n" + (PP.TOUCH ? "タップで再開" : "クリックか P キーで再開"),
      "normal");
    var O = PP.layers.overlay;
    createjs.Tween.removeTweens(O);
    O.alpha = 1;
    // カード選択 UI とリトライ暗幕は stage 直下(overlay より上)に積まれる。
    // それらの最中にポーズしても板が隠れないよう、overlay を最前面へ引き上げる
    // (addChild は再追加=最前面への移動)
    PP.stage.addChild(O);
  }
  function hidePause() { hideOverlay(); }

  // (x, y) がポーズボタンの上か。プレイ中に出ているときだけ当たる
  function hitPauseBtn(x, y) {
    if (!pauseBtn || !pauseBtn.visible || PP.game.state !== "playing") return false;
    var r = PAUSE_RECT, p = TOUCH_PAD;
    return x >= r.x - p && x <= r.x + r.w + p && y >= r.y - p && y <= r.y + r.h + p;
  }

  // (x, y) が ⇄ 交換ボタンの上か。タッチ端末のプレイ中だけ当たる
  function hitSwapBtn(x, y) {
    if (!swapBtn || !swapBtn.visible || PP.game.state !== "playing") return false;
    var r = SWAP_RECT, p = TOUCH_PAD;
    return x >= r.x - p && x <= r.x + r.w + p && y >= r.y - p && y <= r.y + r.h + p;
  }

  PP.hud = {
    build: build, update: update, updateEffects: updateEffects,
    buildOverlay: buildOverlay, showOverlay: showOverlay, hideOverlay: hideOverlay,
    showPause: showPause, hidePause: hidePause, hitPauseBtn: hitPauseBtn,
    hitSwapBtn: hitSwapBtn,
    hitDifficulty: hitDifficulty, setDifficulty: setDifficulty,
    hitOverChoice: hitOverChoice
  };
})();
