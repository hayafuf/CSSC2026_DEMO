/* =========================================================
 * upgrades.js — 【強化】宝玉の力(ローグライト強化)+ 手詰まり救済(海神の加護)
 *
 * ■ 宝玉の力
 * 波を全消しして解放された 💎 をキャッチすると requestChoice() が権利を1つ積み、
 * main.js の tick 末尾(まだ playing のとき)が openChoice() で盤面を凍らせて
 * カード3枚の選択画面を開く(state = "choosing")。選ぶと PP.game.upgrades の
 * 段数が上がり、各所のフックが val()/has() で現在値を読む。効果はランの間
 * ずっと有効で、ゲームオーバー / 全海域制覇のときだけ onRunReset() で消える。
 * 設計表(種類・重み・式)は config.js の PP.UPGRADES。
 *
 * ■ 海神の加護(手詰まり救済)
 * 手詰まりの本体は「危機レーンの先頭グループ(樽に食い込んでいる塊)に、狙える
 * 同色の隣接ペアが1つも無い」状態。挿入の重なり解消は常に樽側へ押すので
 * (chain.js insertShot)、ペアを自作する行為自体が先頭を死線へ押し込む。
 * そこで「先頭が実際に樽へ呑まれ始めていて(PP.RESCUE.start=1.0 なので
 * 先頭の玉が樽の口以深)、かつ局所ペア枯渇」と判定されたら、その場で
 * (時間条件なしに):
 *   1) 🌈 ボタンが点滅して虹玉(万能玉)の使用を「提案」する … 装填は
 *      プレイヤーの操作(Qキー / 🌈 ボタンの toggleWild)だけ。当たった
 *      連なりを色に関係なく炸裂で吹き飛ばす(chain.js wildBlast。最大
 *      PP.WILD.blastCap 個)。ストック制(PP.game.wildCharges)で、
 *      回復はカード「七海の虹玉」(最大+1&全回復)とラン開始時、そして
 *      ゲームオーバーからのコンティニュー(こちらも最大+1&全回復。input.js)。
 *      最大数の計算は加算元が2つあるので recalcWildMax() の1か所に集約する。
 *      ※自動装填にしないのは「切り札をいつ切るか」のリスクとリターンを
 *        機械ではなくプレイヤーの判断に残すため
 *   2) 撃った弾の割り込みに限り2個で消える(chain.js resolveMatchAt)
 *   3) ドロップ率と ⚓💣 の出現重みが上がる(powerups.js)
 * 「+1D 挿入 → 即 -2D 消去+反動」が常に成立し、どこへ当てるかは腕への報酬。
 * 回復(ペアあり/樽直前から脱出)が recover 秒続いたら解除される(即時解除だと
 * 発動⇄解除の明滅が起きる)。解除されても装填済みの万能玉は撃つまで残す。
 * しきい値は config.js の PP.RESCUE。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // ---------- 定義の索引と現在値 ----------
  var byId = {};
  PP.UPGRADES.forEach(function (d) { byId[d.id] = d; });

  function level(id) { return PP.game.upgrades[id] || 0; }
  function has(id) { return level(id) > 0; }

  // 段数 lv のときの効果値(カードの「→」プレビューでも使うので段数を引数に取る)。
  // kind の意味は config.js の PP.UPGRADES を参照。
  function valAt(def, lv) {
    if (!lv) return def.kind === "interval" ? Infinity : 1;
    if (def.kind === "interval") {
      return Math.max(def.floor, def.base * Math.pow(def.decay, lv - 1));
    }
    if (def.kind === "mult") {
      var m = 1;
      for (var i = 0; i < lv && i < def.steps.length; i++) m += def.steps[i];
      return m;
    }
    return lv;   // "add"
  }
  function val(id) {
    var def = byId[id];
    return def ? valAt(def, level(id)) : 1;
  }

  // ---------- 揮発状態(段数以外はランに残さない=レベル開始で仕切り直し) ----------
  var queued = 0;                // 未消化の 💎(選択の権利)。リトライを跨いで残す
  var autogunT = 0;              // 自動機銃の次弾までの残り秒
  // 自動装填(ボム/ミサイル別カード)の次着荷までの残り秒。
  // 両方持っていても待機スロット(g.special)は1つなので、先に満了した方が
  // 勝ち、負けた方は 0 で待つ=合計スループットに自然な上限がかかる(意図)
  var autoDeliverT = { autobomb: 0, automissile: 0 };
  // パリィの構え: 受付窓の残り秒・次に構えられるまでの残り秒・
  // この構えで弾き返し(反射)の当たりを引いているか(押した瞬間に抽選)
  var parryWindowT = 0, parryCdT = 0, parryReflectArmed = false;
  // 強化圧(動的難易度)用: 全カードの合計段数から事前計算した倍率。
  // speedAt は毎フレーム×玉数で呼ばれるホットパスなので、カード取得時にだけ
  // 再計算してここに置く(chain.js は関数呼び出し1回で読むだけ)
  var pressureSpeedMul = 1, pressureSkullMul = 1;
  function recalcPressure() {
    var P = PP.UPGRADE_PRESSURE;
    var total = 0, ups = PP.game.upgrades;
    for (var k in ups) total += ups[k];
    pressureSpeedMul = 1 + Math.min(P.speedCap, P.speedPer * total);
    pressureSkullMul = 1 + Math.min(P.skullCap, P.skullPer * total);
  }
  var rescue = {
    active: false,   // 救済(2個消し・ドロップブースト)発動中か
    wild: false,     // 万能玉が装填されているか(装填はプレイヤー操作のみ)
    suggest: false,  // 「今 虹玉を使うと効果的」の提案中か(🌈 ボタンが点滅する)
    recoverT: 0,     // 発動中、回復(枯渇でない)が続いている秒数(解除のデバウンス)
    scanT: 0,        // 次のペア走査までの秒数
    grace: 0,        // 解除後の猶予秒(飛行中の弾・割り込み待ちの2個消しを守る)
    pulseT: 0,       // 発動中の脈動リングの周期タイマー
    droughted: false // 直近の走査で「危機レーンの先頭グループがペア枯渇」だったか
  };
  var choice = null;             // 選択UI {cont, rects, guardT}

  // ---------- 各所のフックが読む合成値 ----------
  // 強化によるドロップ率の上乗せポイント(powerups.js maybeDrop が足す)。
  // 嗅覚は dropPt/段、「目利き」系も副効果として dropPt/段 を「足し算」で積む
  // (掛け算の倍率合成はしない。1段=+何pt が定義表からそのまま読める)。
  // 救済(海神の加護)中の増配は倍率のまま maybeDrop 側で最後に掛ける(意図)
  function dropBonus() {
    var b = level("droprate") * (byId.droprate.dropPt || 0);
    b += level("bombw") * (byId.bombw.dropPt || 0);
    b += level("missw") * (byId.missw.dropPt || 0);
    return b;
  }

  // パリィの段数ごとの受付秒(定義表 windows から引く)
  function parryWindow(lv) {
    if (!lv) return 0;
    var w = byId.parry.windows;
    return w[Math.min(lv, w.length) - 1];
  }

  // パリィの段数ごとの弾き返し確率(定義表 reflectChances から引く)
  function parryReflectChance(lv) {
    if (!lv) return 0;
    var c = byId.parry.reflectChances;
    return c[Math.min(lv, c.length) - 1];
  }

  // 【新】パリィの構え(input.js: PC は Shift キー、タッチ端末は #tParry が呼ぶ)。
  // 押した瞬間から受付窓が開き、窓の間に大砲へ届いた敵弾を tryParry が弾く。
  // 押すたびに固定のクールダウンを払う=連打・押しっぱなしで常時ガードには
  // できない(空振りにもコストがある「読みの技」にする)
  function pressParry() {
    if (!has("parry")) return;
    if (PP.game.state !== "playing") return;   // タッチの #tParry は状態を見ずに呼ぶため
    if (parryCdT > 0) {
      // まだ構え直せない: 低い空振り音だけ返す(無反応だと故障に見える)
      PP.audio.beep(220, 0.05, "triangle", 0.04);
      return;
    }
    parryWindowT = parryWindow(level("parry"));
    parryCdT = PP.PARRY.cooldown;
    // 弾き返せるかは「構えた瞬間」に1回だけ抽選する(弾ごとに引き直さない):
    // 同じ構えで弾いた弾幕は全弾同じ結果になり、挙動が読みやすい
    parryReflectArmed = Math.random() < parryReflectChance(level("parry"));
    // 構えの合図: シールドの傘を即座に立てる(位置・alpha は update が毎フレーム追従)
    ensureParryShield();
    parryShield.visible = true;
    parryShield.x = PP.cannon.x;
    parryShield.y = PP.cannon.y - 8;
    parryShield.alpha = 1;
    PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 6, 60, 260);
    PP.audio.beep(660, 0.05, "square", 0.06);
  }

  // skull.js / boss.js の被弾判定が呼ぶ。0=不発 / 1=ガード / 2=弾き返し。
  // ガードは受付窓内なら必ず成功し、弾き返しは pressParry で引いた確率の
  // 当たりが出ているときだけ(Lv1 は確率 0=常にガード止まり)。
  // 窓は消費しない: 同時に降ってきた弾幕を1回の構えでまとめて弾けるのが
  // このカードの本領(弾幕の同時被弾がそもそもの導入動機)。
  // どの攻撃に効くか(ボス大技の除外など)は呼び出し側の知識なのでここでは見ない
  function tryParry() {
    if (!has("parry") || parryWindowT <= 0) return 0;
    return parryReflectArmed ? 2 : 1;
  }

  // 【新】🛡 パリィボタン(#tParry)と HUD が読む表示用の状態
  function parryInfo() {
    return { lv: level("parry"), ready: parryCdT <= 0, active: parryWindowT > 0 };
  }

  // ---------- 【強化】パリィの構えシールド(受付窓の可視化) ----------
  // 「いま弾ける状態か」を目で読めるようにする: 受付窓の間だけ大砲に teal の
  // 光の傘を被せ、残り時間はフェードで示す(薄くなりきったら窓も閉じる)。
  // boss.js のシールドの泡と同じ「描くのは1回、毎フレームは alpha と座標だけ」
  // の作法(lighter 合成なので cache はしない: 発色が変わってしまう)
  var parryShield = null;
  // 泡の半径: 大砲の見た目の全部(砲身の上端 -62 / 砲架と車輪の下端 +47 /
  // 幅 ±62。cannon.js build の cache 範囲)を余白込みで包む。中心は
  // cannon.y - 8(上下の中点)に置く=pressParry / update と揃える
  var PARRY_RX = 76, PARRY_RY = 68;
  function ensureParryShield() {
    if (parryShield) return;
    parryShield = new createjs.Shape();
    parryShield.graphics
      .beginRadialGradientFill(
        ["rgba(142,240,208,0)", "rgba(142,240,208,0.10)", "rgba(142,240,208,0.30)"],
        [0, 0.8, 1], 0, 0, 20, 0, 0, PARRY_RX)
      .drawEllipse(-PARRY_RX, -PARRY_RY, PARRY_RX * 2, PARRY_RY * 2)
      .setStrokeStyle(2.5).beginStroke("rgba(190,255,230,0.85)")
      .drawEllipse(-PARRY_RX, -PARRY_RY, PARRY_RX * 2, PARRY_RY * 2);
    parryShield.compositeOperation = "lighter";
    parryShield.visible = false;
    PP.layers.fx.addChild(parryShield);
  }
  // プレイ以外の画面へ移るとき(hud.showOverlay)と レベル開始時に隠す
  function hideParryShield() {
    if (parryShield) parryShield.visible = false;
  }

  // パワーアップ抽選プールの重み補正(powerups.js drop / dropPower)。
  // 「目利き」系は重みへ wAdd×段数 を「足す」(掛け算にしない: 足し算なら
  // 積んだときの伸びが線形で、他アイテムの取り分の痩せ方も緩やかに頭打ちする)。
  // 救済中のブースト(rescuePoolMult)は緊急措置なので倍率のまま。
  // 補正が無ければ元の配列をそのまま返す(浅いコピーは補正時のみ)
  function adjustPool(pool) {
    var bw = level("bombw") * (byId.bombw.wAdd || 0);
    var mw = level("missw") * (byId.missw.wAdd || 0);
    var boost = rescueActive() ? PP.RESCUE.rescuePoolMult : 1;
    if (bw === 0 && mw === 0 && boost === 1) return pool;
    return pool.map(function (p) {
      var w = p.w;
      if (p.id === "bomb") w = (w + bw) * boost;   // 救済中は立て直しの道具を厚く
      else if (p.id === "missile") w = w + mw;
      else if (p.id === "reverse") w *= boost;     // 救済中は風系(引き潮)も厚く
      return { id: p.id, icon: p.icon, dur: p.dur, w: w };
    });
  }

  // 補給の塊率の底上げ(ball.js spawnColor)。1-(1-c)×0.85^lv なので
  // コース側の spawnCluster 上書き(コース5=0.75)にも自然に逓減が掛かる
  function clusterBoost(cluster) {
    var lv = level("cluster");
    if (!lv) return cluster;
    return 1 - (1 - cluster) * Math.pow(0.85, lv);
  }

  // ---------- 選択フロー ----------
  // 💎 キャッチの瞬間(powerups.js collect)。ここでは権利を積むだけで state は
  // 変えない: collect は tick 内の powerups.update で走り、同フレーム直後の
  // 樽あふれ判定(main.js)が state を上書きし得る。開くのは tick 末尾で
  // 「まだ playing なら」(pendingChoice → openChoice)。
  function requestChoice() { queued++; }
  function pendingChoice() { return queued > 0; }

  function openChoice() {
    var g = PP.game;
    var cards = rollCards();
    if (!cards.length) {
      // 全カンスト: 選ぶものが無いのでスコアに変換(権利は消費)
      queued = Math.max(0, queued - 1);
      g.score += 1000;
      PP.fx.floatText(PP.i18n.t("ug.ui.maxed"), PP.W / 2, 96, "#ffe08a", 24);
      PP.hud.update();
      return;
    }
    g.state = "choosing";
    buildChoiceUI(cards);
    PP.audio.treasure();
  }

  // max 到達を除き、w の重み付き非復元抽選で3枚(候補が少なければその枚数)
  function rollCards() {
    var pool = PP.UPGRADES.filter(function (d) {
      if (level(d.id) >= d.max) return false;
      // ライフ回復の無い難易度(深海の悪魔)では「換金術」は無意味なので出さない
      if (d.id === "coin" && PP.diff().useLives === false) return false;
      return true;
    });
    var out = [];
    while (out.length < 3 && pool.length) {
      var total = 0, i;
      for (i = 0; i < pool.length; i++) total += pool[i].w;
      var r = Math.random() * total;
      for (i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) break; }
      if (i >= pool.length) i = pool.length - 1;
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  function choose(id) {
    var g = PP.game;
    if (g.state !== "choosing" || !byId[id]) return;
    g.upgrades[id] = level(id) + 1;
    queued = Math.max(0, queued - 1);
    var def = byId[id];
    // 自動系: 初取得は満タンから数え始め(即発動させない)、重ね取りは
    // 「新しい短い間隔の方が先に来るなら」残り時間を詰める
    if (id === "autogun") autogunT = (g.upgrades[id] === 1) ? val(id) : Math.min(autogunT, val(id));
    if (id === "autobomb" || id === "automissile") {
      autoDeliverT[id] = (g.upgrades[id] === 1) ? val(id) : Math.min(autoDeliverT[id], val(id));
    }
    // 【新】七海の虹玉: 最大ストック+1、そしてその場で全回復
    if (id === "wildshot") {
      recalcWildMax();
      g.wildCharges = g.wildMax;
    }
    recalcPressure();   // 強化を取るほど海も牙を剥く(chain.js が読む倍率を更新)
    closeChoiceUI();
    g.state = "playing";
    PP.audio.catchItem();
    PP.fx.floatText(def.icon + " " + PP.i18n.t("ug." + id + ".name") + " Lv." + g.upgrades[id] + "!",
      PP.W / 2, 96, "#ffdf8a", 24);
    PP.hud.update();
    // queued が残っていれば、次の tick 末尾の pendingChoice() がまた開く
  }

  // (x, y) がカードの上ならその id(開いた直後の入力猶予中と外れは null)
  var PAD = PP.TOUCH ? 12 : 0;
  function hitChoice(x, y) {
    if (!choice || choice.guardT > 0) return null;
    for (var i = 0; i < choice.rects.length; i++) {
      var r = choice.rects[i];
      if (x >= r.x - PAD && x <= r.x + r.w + PAD &&
          y >= r.y - PAD && y <= r.y + r.h + PAD) return r.id;
    }
    return null;
  }

  // 1〜3 キー用(main.js keydown から)
  function chooseIndex(i) {
    if (!choice || choice.guardT > 0) return;
    var r = choice.rects[i];
    if (r) choose(r.id);
  }

  // choosing 中の tick 担当(main.js から)。入力猶予の計時だけ行う。
  // カードの出現アニメは Tween 任せ(choosing 中も Ticker は生きている)
  function updateChoice(dt) {
    if (!choice) { PP.game.state = "playing"; return; }   // UI が無いのに choosing の保険
    if (choice.guardT > 0) choice.guardT -= dt;
  }

  // 強制クローズ(PP.playCourse 等の保険)。権利(queued)は消さない
  function closeChoice() { closeChoiceUI(); }

  // ---------- 選択UIの作画 ----------
  // PP.layers.overlay は使わない: hud.hideOverlay がレイヤーごと visible=false に
  // する設計なので、共用すると古いタイトルパネルが一緒に出てしまう。
  // リトライの暗幕(main.js buildRetryVeil)と同じく stage 直下の最前面に置く。
  var CARD = { w: 300, h: 340, gap: 40, y: 170 };

  function buildChoiceUI(cards) {
    closeChoiceUI();
    var cont = new createjs.Container();
    cont.mouseEnabled = false;   // クリックは main.js の onStageDown が矩形判定で拾う

    // 暗幕(中央がわずかに明るい放射グラデ。揺れ中でも端が出ないよう一回り大きく)
    var veil = new createjs.Shape();
    veil.graphics.beginRadialGradientFill(
      ["rgba(10,14,24,0.72)", "rgba(3,4,8,0.84)"], [0, 1],
      PP.W / 2, PP.H / 2, 140, PP.W / 2, PP.H / 2, PP.W * 0.72)
      .drawRect(-140, -140, PP.W + 280, PP.H + 280);
    cont.addChild(veil);

    var title = new createjs.Text(PP.i18n.t("ug.ui.pick"),
      '800 34px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffdf8a");
    title.textAlign = "center"; title.textBaseline = "middle";
    title.x = PP.W / 2; title.y = 104;
    title.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 3, 8);
    cont.addChild(title);

    // 2個目以降の 💎 が待っているときだけ残数を出す
    var subText = queued > 1 ? PP.i18n.t("ug.ui.remaining", { n: queued - 1 })
      : PP.i18n.t(PP.TOUCH ? "ug.ui.pickTouch" : "ug.ui.pickMouse");
    var sub = new createjs.Text(subText, '14px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#caa96a");
    sub.textAlign = "center"; sub.textBaseline = "middle";
    sub.x = PP.W / 2; sub.y = 138;
    cont.addChild(sub);

    var n = cards.length;
    var total = n * CARD.w + (n - 1) * CARD.gap;
    var x0 = (PP.W - total) / 2;
    var rects = [];
    cards.forEach(function (def, i) {
      var bx = x0 + i * (CARD.w + CARD.gap);
      var card = buildCard(def, i);
      // ポップ演出のため中心基準で置く(buildCard は中心原点で描いてある)
      card.x = bx + CARD.w / 2; card.y = CARD.y + CARD.h / 2;
      card.scaleX = card.scaleY = 0.85; card.alpha = 0;
      createjs.Tween.get(card).wait(i * 80)
        .to({ alpha: 1, scaleX: 1, scaleY: 1 }, 220, createjs.Ease.backOut);
      cont.addChild(card);
      rects.push({ id: def.id, x: bx, y: CARD.y, w: CARD.w, h: CARD.h });
    });

    PP.stage.addChild(cont);   // HUD より手前(リトライの暗幕と同じ)
    // 開いた直後 0.25 秒は入力を無視する(FIRE 連打の誤選択防止)
    choice = { cont: cont, rects: rects, guardT: 0.25 };
  }

  // カード1枚(中心原点)。真鍮×ガラスの意匠は hud.js のオーバーレイと揃える
  function buildCard(def, i) {
    var c = new createjs.Container();
    var w = CARD.w, h = CARD.h, hw = w / 2, hh = h / 2;
    var lv = level(def.id);

    var s = new createjs.Shape();
    var g = s.graphics;
    g.beginLinearGradientFill(["#2a1f10", "#150e06"], [0, 1], 0, -hh, 0, hh)
      .drawRoundRect(-hw, -hh, w, h, 16);
    g.beginFill("rgba(255,240,200,0.05)").drawRoundRect(-hw + 3, -hh + 3, w - 6, h * 0.4, 12);
    g.setStrokeStyle(2.5).beginStroke("#f0c040").drawRoundRect(-hw, -hh, w, h, 16);
    g.setStrokeStyle(1).beginStroke("rgba(255,246,210,0.3)")
      .drawRoundRect(-hw + 5, -hh + 5, w - 10, h - 10, 12);
    c.addChild(s);

    function line(str, y, font, color) {
      var t = new createjs.Text(str, font, color);
      t.textAlign = "center"; t.textBaseline = "middle";
      t.x = 0; t.y = y;
      t.shadow = new createjs.Shadow("rgba(0,0,0,0.7)", 0, 2, 5);
      c.addChild(t);
      return t;
    }
    line(def.icon, -hh + 62,
      '48px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",serif', "#ffffff");
    line(PP.i18n.t("ug." + def.id + ".name"), -hh + 122,
      'bold 24px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#f7ecce");
    line(lv === 0 ? "NEW!" : "Lv." + lv + " → Lv." + (lv + 1), -hh + 158,
      '600 16px "Cinzel","Meiryo",serif', lv === 0 ? "#8ef0d0" : "#ffd15a");
    line(preview(def, lv), -hh + 190,
      'bold 17px "Meiryo",sans-serif', "#ffdf8a");
    var desc = new createjs.Text(PP.i18n.t("ug." + def.id + ".desc"),
      '15px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#e6d3b8");
    desc.textAlign = "center"; desc.lineHeight = 24;
    desc.x = 0; desc.y = -hh + 228;
    c.addChild(desc);
    // 下部のキー刻印(タッチ端末ではキーが無いので出さない)
    if (!PP.TOUCH) line(String(i + 1), hh - 34, '700 22px "Cinzel",serif', "#caa96a");
    return c;
  }

  // 効果の数値プレビュー(「今 → 取ったら」)。文言は連結ではなくテンプレート
  // (t の {a}/{b} 穴埋め)で組む: 英語と日本語で単位や語順が違うため
  function preview(def, lv) {
    var id = def.id;
    var t = PP.i18n.t;
    if (def.kind === "interval") {
      return lv === 0 ? t("ug.prev.interval0", { v: valAt(def, 1).toFixed(1) })
        : t("ug.prev.interval", { a: valAt(def, lv).toFixed(1), b: valAt(def, lv + 1).toFixed(1) });
    }
    if (id === "cluster") {
      // 塊率の基準はコースごとに違う(コース5は 0.75)ので、絶対値ではなく
      // 「今のコースでどれだけ増えるか」の +% で見せる
      var base = (PP.game.builtCourse && PP.game.builtCourse.spawnCluster) || PP.SPAWN_CLUSTER;
      var cur = 1 - (1 - base) * Math.pow(0.85, lv);
      var nx = 1 - (1 - base) * Math.pow(0.85, lv + 1);
      return t("ug.prev.cluster", { n: Math.round((nx - cur) * 100) });
    }
    if (id === "barrelcap") return t("ug.prev.barrelcap", { a: PP.barrelCap(), b: PP.barrelCap() + 1 });
    if (id === "coin") {
      var c0 = Math.max(2, PP.LIFE.coinsPerLife - lv);
      var c1 = Math.max(2, PP.LIFE.coinsPerLife - lv - 1);
      return t("ug.prev.coin", { a: c0, b: c1 });
    }
    if (id === "combo") {
      return t("ug.prev.interval", { a: (PP.COMBO_WINDOW * valAt(def, lv)).toFixed(1),
                                     b: (PP.COMBO_WINDOW * valAt(def, lv + 1)).toFixed(1) });
    }
    if (id === "wildshot") {
      return t("ug.prev.wildshot", { a: PP.WILD.baseMax + lv, b: PP.WILD.baseMax + lv + 1 });
    }
    if (id === "parry") {
      // レベルの主役は弾き返し確率(ユーザー体感の「当たり」)。受付秒も
      // 静かに広がるが、プレビューは確率の伸びで見せる
      var pc = function (lvl) { return Math.round(def.reflectChances[lvl - 1] * 100); };
      return lv === 0 ? t("ug.prev.parry0", { v: def.windows[0].toFixed(2) })
        : t("ug.prev.parry", { a: pc(lv), b: pc(lv + 1) });
    }
    if (id === "droprate") {
      // ドロップ率への上乗せポイント(足し算)を絶対値で見せる: +2.5% → +5%
      var fmtPt = function (lvl) {
        return String(+(lvl * def.dropPt * 100).toFixed(1));
      };
      return t("ug.prev.percent", { a: fmtPt(lv), b: fmtPt(lv + 1) });
    }
    if (id === "bombw" || id === "missw") {
      // 重みの足し算は素の数値だと意味が伝わらないので、素の状態と比べて
      // 「どれだけ出やすくなるか」の +% で見せる: +0% → +26%。
      // (絶対値の出現率表示にしないのは、コースや救済で条件が変わると
      //  実際の確率がズレて嘘の数字になるため。相対なら常に正しい)
      var target = id === "bombw" ? "bomb" : "missile";
      var sum = 0, wBase = 0;
      PP.POWERUPS.forEach(function (p) {
        sum += p.w;
        if (p.id === target) wBase = p.w;
      });
      var rel = function (lvl) {
        var share = (wBase + lvl * def.wAdd) / (sum + lvl * def.wAdd);
        return Math.round((share / (wBase / sum) - 1) * 100);
      };
      return t("ug.prev.percent", { a: rel(lv), b: rel(lv + 1) });
    }
    // 倍率(mult)カードの汎用プレビュー。「×1.45」の掛け算表記ではなく
    // 「+45%」の加算表記で見せる(ドロップ率の内部処理もポイント加算に
    // 統一済みなので、表示も「どれだけ上乗せされるか」で揃える)
    return t("ug.prev.percent", {
      a: Math.round((valAt(def, lv) - 1) * 100),
      b: Math.round((valAt(def, lv + 1) - 1) * 100)
    });
  }

  function closeChoiceUI() {
    if (!choice) return;
    PP.stage.removeChild(choice.cont);
    choice = null;
  }

  // ---------- 自動機銃 / 自動装填 / 救済(playing 中の毎 tick) ----------
  function update(dt) {
    if (has("autogun")) tickAutogun(dt);
    if (has("autobomb")) tickAutoDeliver(dt, "autobomb", "bomb", "💣");
    if (has("automissile")) tickAutoDeliver(dt, "automissile", "missile", "🚀");
    // パリィの構え: 窓・クールダウンの進行と、構えシールドの追従
    if (parryWindowT > 0) {
      parryWindowT -= dt;
      if (parryWindowT <= 0) hideParryShield();
      else if (parryShield) {
        parryShield.x = PP.cannon.x;
        parryShield.y = PP.cannon.y - 8;
        // 残り時間をフェードで示す(完全に薄くなる前に窓が閉じる)
        parryShield.alpha = 0.30 + 0.70 * (parryWindowT / parryWindow(level("parry")));
      }
    }
    if (parryCdT > 0) {
      parryCdT -= dt;
      // 構え直せるようになった合図(小さな teal リング。音は付けない:
      // 1.2 秒ごとに毎回鳴ると耳障りで、目で分かれば十分)
      if (parryCdT <= 0 && has("parry")) {
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 4, 44, 220);
      }
    }
    tickRescue(dt);
  }

  // 「最危険レーンの先頭側から見て、前後に同色の隣接が無い孤立玉」を返す
  // (無ければ null)。孤立玉を撃ち抜くと、左右の同色グループが磁力巻き戻し
  // (chain.js)で合体して連鎖の種になる=自動破壊がプレイヤーのお膳立てになる。
  // 旧仕様「大砲の真上を撃つ」は、狙いたい玉の下へわざわざ移動する手間が
  // 落下アイテムのキャッチと動線衝突して使いづらかったため廃止した。
  // 適格の規準はプレイヤーの弾(cannon.js firstHitY)と同じ:
  // 宝玉・洞窟内・樽内・トンネル内は対象外。
  function findGunTarget() {
    // レーンを危険度(先頭が樽へ迫っている割合)の高い順に見る。
    // main.js の leadD 記録と同じ量 = balls[0].d / holeD
    var lanes = [];
    PP.game.eachLane(function (lane) {
      if (lane.balls.length) lanes.push(lane);
    });
    lanes.sort(function (a, b) {
      return b.balls[0].d / b.rail.holeD - a.balls[0].d / a.rail.holeD;
    });
    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li], balls = lane.balls;
      for (var i = 0; i < balls.length; i++) {   // index 0 = 先頭(樽側)から走査
        var b = balls[i];
        if (b.treasure || b.d < PP.R || b.d > lane.rail.holeD) continue;
        if (lane.rail.tunnelAt(b.d)) continue;
        // 孤立判定: 前後どちらにも「同色かつ接触距離(D+1 以内)」の隣がいない。
        // 宝玉は color を持たないので自然に不一致=境界として働く
        var prev = balls[i - 1], next = balls[i + 1];
        if (prev && prev.color === b.color && prev.d - b.d <= PP.D + 1) continue;
        if (next && next.color === b.color && b.d - next.d <= PP.D + 1) continue;
        var p = lane.rail.posAt(b.d);
        return { lane: lane, ball: b, x: p.x, y: p.y };
      }
    }
    // 孤立玉ゼロ = 盤面がペアと塊だけ。ペアを割る撃ち方は連鎖を壊すだけの
    // マイナス行動なので、無理に撃たない(少し待って索敵し直す)
    return null;
  }

  function tickAutogun(dt) {
    autogunT -= dt;
    if (autogunT > 0) return;
    var target = findGunTarget();
    // 孤立玉が無い間は retryDelay 秒後に索敵し直す。旧仕様の
    // 「大砲の真上に的が来るまで待機」という位置取り依存は廃止した
    if (!target) { autogunT = PP.GUN.retryDelay; return; }
    autogunT = val("autogun");
    fireGun(target);
  }

  // 銃弾を砲口から目標へ飛ばし、着弾で1個撃ち抜く。
  // 挿入(通常弾)にしないのは、勝手な発射が盤面にゴミ色を混ぜてプレイヤーの
  // 邪魔をするため。popRun も使わない: コンボを 1 に上書きして継続コンボを
  // 踏み潰し、maybeDrop まで回ってしまう。destroySingle は純粋な1個破壊+連鎖判定
  function fireGun(target) {
    var mx = PP.cannon.x, my = PP.cannon.y - 52;
    var lane = target.lane, ball = target.ball;
    // 弾道(トレーサー): 砲口から着弾点へ金の線が一瞬走り、すっと消える。
    // 斜めに走る線が「どの孤立玉を摘んだか」をひと目で伝える
    var tracer = new createjs.Shape();
    tracer.graphics.setStrokeStyle(2.5).beginStroke("rgba(255,214,140,0.55)")
      .moveTo(mx, my).lineTo(target.x, target.y);
    tracer.graphics.setStrokeStyle(1).beginStroke("rgba(255,246,220,0.8)")
      .moveTo(mx, my).lineTo(target.x, target.y);
    PP.layers.fx.addChild(tracer);
    // 弾丸: 金の弾頭 + 尾を引く光条(進行方向は着弾点へ向けて回す)
    var b = new createjs.Shape();
    b.graphics.beginLinearGradientFill(["rgba(255,210,74,0)", "rgba(255,210,74,0.85)"],
      [0, 1], 0, 26, 0, -4)
      .drawRect(-2, -4, 4, 30);                                    // 尾の光条
    b.graphics.beginFill("#ffd24a").drawEllipse(-4, -12, 8, 16);   // 弾頭
    b.graphics.beginFill("rgba(255,244,200,0.95)").drawEllipse(-2.5, -11, 5, 8);
    b.x = mx; b.y = my;
    b.rotation = Math.atan2(target.x - mx, my - target.y) * 180 / Math.PI;
    PP.layers.shot.addChild(b);
    PP.fx.flash(mx, my, "rgba(255,214,140,0.9)", 22);
    PP.audio.beep(880, 0.06, "square", 0.06);
    // 飛行時間は実距離ベース(旧の「高さ差だけ」は真上撃ち専用の式で、
    // 斜め射だと距離を過小に見積もって弾が瞬着してしまう)
    var dx = target.x - mx, dy = target.y - my;
    var time = Math.max(40, Math.sqrt(dx * dx + dy * dy) / PP.GUN.speed * 1000);
    createjs.Tween.get(b).to({ x: target.x, y: target.y }, time).call(function () {
      PP.layers.shot.removeChild(b);
      // トレーサーは着弾後にすっとフェードして消える
      createjs.Tween.get(tracer).to({ alpha: 0 }, 200)
        .call(function () { PP.layers.fx.removeChild(tracer); });
      // 着弾。選択画面・リトライ中に届いた弾は不発(凍った盤面を壊さない)
      if (PP.game.state !== "playing") return;
      var i = lane.balls.indexOf(ball);   // 飛んでいる間に消えていたら空振り
      if (i < 0) { PP.fx.burst(target.x, target.y, "#ffd24a", 4); return; }
      var p = lane.rail.posAt(ball.d);    // 着弾時点の実位置で演出を出す
      PP.chain.destroySingle(lane, i);
      PP.game.score += PP.GUN.score;
      PP.fx.ring(p.x, p.y, "#ffd24a", 6, 60, 300);
      PP.fx.floatText("🔫 +" + PP.GUN.score, p.x, p.y - 20, "#ffd24a", 14);
      PP.hud.update();
    });
  }

  // 自動装填の共通ロジック(autobomb / automissile の2カードで共用)
  function tickAutoDeliver(dt, id, kind, icon) {
    var g = PP.game;
    autoDeliverT[id] -= dt;
    if (autoDeliverT[id] > 0) return;
    // 特殊弾を所持中は「完成品を持って待つ」(空いた瞬間に届く)
    if (g.special) { autoDeliverT[id] = 0; return; }
    autoDeliverT[id] = val(id);
    // loadSpecial は使わない: あちらは砲身へ押し込み(specialLoaded=true)、
    // 狙い中の色玉を勝手に引っ込めてしまう。待機スロットへ静かに届ける
    g.special = kind;
    g.specialLoaded = false;
    PP.cannon.refreshBalls();
    PP.fx.floatText(PP.i18n.t("ug.ui.autoload", { icon: icon }), 86, PP.H - 120, "#8ef0d0", 18);
    PP.audio.specialLoad();   // 特殊弾の装填音(手動キャッチの loadSpecial と同じ音)
  }

  // ---------- 手詰まり救済(海神の加護) ----------
  // 局所判定: 樽直前のレーン(先頭が PP.RESCUE.start を越えた)に限り、
  // 「先頭の連結グループ(樽に食い込んでいる塊)」の狙える玉 frontBalls 個の中に
  // 同色の隣接ペアがあるかだけを見る。危機の解消に効くのは先頭グループを
  // 消すことだけなので、後方の離れたペアは数えない(全域判定だと塊率35%の
  // 盤面ではどこかにほぼ必ずペアが残り、実戦でまったく発動しなかった)。
  // 「狙える玉」の規準は cannon.js の命中判定と同じ: 宝玉でない・洞窟の外・
  // 樽に沈んでいない・トンネル内でない。届かない玉を挟んだら連なりは切れる。
  // ※ 立体交差で桁に隠れた玉(occludedByDeck)までは見ない — 隠れペアがあると
  //   発動がやや早まるだけで安全側なので、走査コストに見合わない
  function scanCrisisDrought() {
    var drought = false;
    PP.game.eachLane(function (lane) {
      var balls = lane.balls;
      if (!balls.length) return;
      var holeD = lane.rail.holeD;
      // このレーンは呑まれ始めているか(PP.RESCUE.start=1.0 なので先頭の玉が
      // 樽の口以深=実際に飲み込みが始まったレーンだけを救済の対象にする)
      if (balls[0].d < holeD * PP.RESCUE.start) return;
      var prev = null, seen = 0, pair = false;
      for (var i = 0; i < balls.length && seen < PP.RESCUE.frontBalls; i++) {
        var b = balls[i];
        if (b.d < PP.R) break;                        // ここから後ろは洞窟内
        // 先頭の連結グループの終わり(隙間)で打ち切る。後方の別グループを
        // 消しても、樽に食い込んでいる先頭グループは沈み続けるため
        if (i > 0 && balls[i - 1].d - b.d > PP.D + 1) break;
        var ok = !b.treasure && b.d <= holeD && !lane.rail.tunnelAt(b.d);
        if (ok) {
          seen++;
          if (prev && prev.color === b.color && prev.d - b.d <= PP.D + 1) {
            pair = true;
            break;
          }
        }
        prev = ok ? b : null;
      }
      // ペアが無ければ枯渇(狙える玉がゼロ=全部沈んでいる場合も含む)
      if (!pair) { drought = true; return false; }
    });
    return drought;
  }

  function tickRescue(dt) {
    var g = PP.game;
    var RS = PP.RESCUE;
    if (rescue.grace > 0) rescue.grace -= dt;

    rescue.scanT -= dt;
    if (rescue.scanT <= 0) {
      rescue.scanT = RS.scanInterval;
      rescue.droughted = scanCrisisDrought();
    }

    // なだれ込み中・樽直前レーン無し・先頭グループにペアあり → 枯渇ではない
    if (!g.rolloutDone || !rescue.droughted) {
      // 発動中でも即時には解除しない: 反動で先頭が樽直前ラインを行き来したり、
      // 万能玉の着弾で一瞬だけペアが生まれたりするたびに解除⇄再発動が起きると、
      // 装填玉が虹⇄通常色で明滅してしまう。「回復が recover 秒続いたら解除」に均す
      if (rescue.active) {
        rescue.recoverT += dt;
        if (rescue.recoverT >= RS.recover) deactivateRescue();
      }
      return;
    }
    rescue.recoverT = 0;

    // 枯渇は玉の並びで決まる「状態」なので、時間条件は重ねない:
    // 樽直前+先頭グループにペア無し、と判定されたその場で発動する
    if (!rescue.active) activateRescue();

    if (rescue.active) {
      // 【新】自動再武装はしない。かわりに「未装填かつ在庫あり」の間は
      // 提案フラグを立て続ける(🌈 ボタンが点滅する)。撃って外しても
      // 枯渇が続く限り提案は再点灯する=判断の主導権はプレイヤーのまま
      rescue.suggest = !rescue.wild && (g.wildCharges || 0) > 0;
      // 発動中の合図: 大砲位置で teal のリングが約2秒周期で脈動
      rescue.pulseT -= dt;
      if (rescue.pulseT <= 0) {
        rescue.pulseT = 2.0;
        PP.fx.ring(PP.cannon.x, PP.cannon.y - 40, "#8ef0d0", 10, 70, 200);
      }
    }
  }

  function activateRescue() {
    rescue.active = true;
    rescue.pulseT = 0;
    rescue.recoverT = 0;
    PP.fx.floatText(PP.i18n.t("ug.ui.rescueOn"), PP.W / 2, 96, "#8ef0d0", 24);
    PP.fx.floatText(PP.i18n.t("ug.ui.rescueTwo"), PP.W / 2, 128, "#8ef0d0", 17);
    // 【新】虹玉は自動装填しない: 在庫があれば使用を「提案」するだけ
    // (🌈 ボタンの点滅は tickRescue が維持する)。既に装填中なら何も言わない
    if (!rescue.wild && (PP.game.wildCharges || 0) > 0) {
      rescue.suggest = true;
      PP.fx.floatText(PP.i18n.t(PP.TOUCH ? "ug.ui.rescueWildTouch" : "ug.ui.rescueWildKey"),
        PP.W / 2, 158, "#8ef0d0", 17);
    }
    PP.audio.treasure();
  }

  function deactivateRescue() {
    rescue.active = false;
    rescue.suggest = false;
    // 飛行中の弾・割り込みアニメ待ち(INSERT_TIME)の2個消しを守る猶予。
    // これが無いと「万能玉を当てたのに、着弾までの間に走った走査が解除して
    // 3個ルールに戻り、約束の2個消しが起きない」レースが生まれる
    // (飛行 ~0.3秒 + 割り込みアニメ 0.14秒 を覆う長さ)
    rescue.grace = 0.5;
    // 装填済みの万能玉は取り上げない: 一度授けた玉を没収すると、狙いを
    // 定めている間に虹⇄通常色が入れ替わって理不尽に見える。撃つまで有効の
    // まま残し、解除は「以後の再武装をやめる」ことだけを意味する
    PP.fx.floatText(PP.i18n.t("ug.ui.rescueOff"), PP.W / 2, 96, "#b0d8cc", 16);
  }

  // 【新】虹玉の手動トグル(input.js: PC は Qキー、タッチ端末は #tWild が呼ぶ)。
  // 「装填はトグル・在庫の消費は発射の瞬間」: 装填したまま気が変わったら
  // もう一度押せば無償で解除できる(切り札を構える行為自体は無料)。
  function toggleWild() {
    var g = PP.game;
    if (g.state !== "playing") return;
    if (rescue.wild) {
      // 解除(在庫は発射時にしか減らないので返却処理は不要)
      rescue.wild = false;
      PP.cannon.refreshBalls();
      PP.audio.beep(300, 0.06, "sine", 0.05);
      return;
    }
    if ((g.wildCharges || 0) <= 0) {
      // 在庫切れ: 空撃ち音と表示で「無い」ことだけ伝える
      PP.audio.beep(160, 0.09, "square", 0.04);
      PP.fx.floatText(PP.i18n.t("ug.ui.wildEmpty"), PP.cannon.x, PP.cannon.y - 72, "#b0d8cc", 14);
      return;
    }
    rescue.wild = true;
    rescue.suggest = false;   // 提案に応えた(枯渇が続けば tickRescue がまた点す)
    PP.cannon.refreshBalls(); // 装填玉の見た目を虹へ(cannon.js が wildArmed を見る)
    PP.audio.specialLoad();
    PP.fx.floatText(PP.i18n.t("ug.ui.wildArmed"), PP.cannon.x, PP.cannon.y - 72, "#8ef0d0", 16);
  }

  // 虹玉の最大ストックを組み直す。加算元が2つ(カード「七海の虹玉」の段数と、
  // コンティニュー報酬 wildBonus)あるので、代入は必ずここ1か所に集める。
  // 別々の場所で g.wildMax へ代入すると、あとから走った側が相手の加算を消してしまう
  function recalcWildMax() {
    var g = PP.game;
    g.wildMax = PP.WILD.baseMax + level("wildshot") + (g.wildBonus || 0);
    return g.wildMax;
  }

  // HUD(キャンバス内 🌈 ボタン)と DOM(#tWild)が毎フレーム読む表示用の状態
  function wildInfo() {
    return {
      charges: PP.game.wildCharges || 0,
      max: PP.game.wildMax || 0,
      armed: rescue.wild,
      suggested: rescue.suggest
    };
  }

  // cannon.js fire が呼ぶ: 発射する通常色弾を万能玉として撃ち出す
  function wildArmed() { return rescue.wild; }
  function consumeWild() {
    if (!rescue.wild) return false;
    rescue.wild = false;
    // 【新】発射した瞬間に在庫を1消費(残数は HUD の 🌈 ボタンが見せる)
    PP.game.wildCharges = Math.max(0, (PP.game.wildCharges || 0) - 1);
    PP.hud.update();
    return true;
  }

  // chain.js resolveMatchAt が読む: 撃った弾の割り込みは2個で消えるか
  function rescueActive() { return rescue.active || rescue.grace > 0; }

  // ---------- リセット ----------
  // レベル開始(startLevel)ごと: タイマーと救済を仕切り直す。段数と queued は残す
  function onLevelStart() {
    autogunT = has("autogun") ? val("autogun") : 0;
    autoDeliverT.autobomb = has("autobomb") ? val("autobomb") : 0;
    autoDeliverT.automissile = has("automissile") ? val("automissile") : 0;
    parryWindowT = 0;
    parryCdT = 0;
    parryReflectArmed = false;
    hideParryShield();
    rescue.active = false;
    rescue.wild = false;
    rescue.suggest = false;
    rescue.recoverT = 0;
    rescue.scanT = 0;
    rescue.grace = 0;
    rescue.pulseT = 0;
    rescue.droughted = false;
    closeChoiceUI();
  }

  // ランの終わり(全海域制覇のクリック / タイトルからの再出航)だけ: 段数ごと全部消す。
  // ゲームオーバーからのコンティニューでは呼ばれない(強化・虹玉ストックは持ち越す)
  function onRunReset() {
    PP.game.upgrades = {};
    queued = 0;
    PP.game.wildBonus = 0;   // コンティニュー報酬もランの終わりで消える
    recalcWildMax();
    PP.game.wildCharges = PP.game.wildMax;
    recalcPressure();   // 段数が消えたので強化圧も平常へ戻す
    onLevelStart();
  }

  PP.upgrades = {
    level: level,
    has: has,
    val: val,
    dropBonus: dropBonus,
    adjustPool: adjustPool,
    clusterBoost: clusterBoost,
    tryParry: tryParry,       // 【新】パリィの成否判定(skull.js / boss.js の被弾処理)
    pressParry: pressParry,   // 【新】パリィの構え(input.js: Shift キー / #tParry)
    parryInfo: parryInfo,     // 【新】🛡 ボタン表示用の状態(hud.js)
    hideParryShield: hideParryShield,   // 【新】構えシールドの後始末(hud.showOverlay)
    requestChoice: requestChoice,
    pendingChoice: pendingChoice,
    openChoice: openChoice,
    choose: choose,
    chooseIndex: chooseIndex,
    hitChoice: hitChoice,
    updateChoice: updateChoice,
    closeChoice: closeChoice,
    update: update,
    rescueActive: rescueActive,
    wildArmed: wildArmed,
    consumeWild: consumeWild,
    toggleWild: toggleWild,   // 【新】虹玉の手動装填トグル(Qキー / 🌈 ボタン)
    wildInfo: wildInfo,       // 【新】🌈 ボタン表示用の状態(残数・装填・提案)
    recalcWildMax: recalcWildMax, // 【新】虹玉の最大ストックを組み直す(input.js のコンティニュー)
    // 強化圧(動的難易度)。chain.js が毎フレーム読むので事前計算値を返すだけ
    speedPressure: function () { return pressureSpeedMul; },
    skullPressure: function () { return pressureSkullMul; },
    onLevelStart: onLevelStart,
    onRunReset: onRunReset
  };
})();
