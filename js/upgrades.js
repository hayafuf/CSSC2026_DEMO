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
 * そこで「先頭が樽直前(PP.RESCUE.start)まで来ていて、かつ局所ペア枯渇」と
 * 判定されたら、その場で(時間条件なしに):
 *   1) 装填玉が万能玉(🌈)になる … 当たった玉の色を継承して挿入される
 *      (chain.js insertShot)ので、どこに撃っても必ずペアが成立する
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
  var autoloadT = 0;             // 自動装填の次着荷までの残り秒
  var rescue = {
    active: false,   // 救済(2個消し・ドロップブースト)発動中か
    wild: false,     // 万能玉が装填されているか
    recoverT: 0,     // 発動中、回復(枯渇でない)が続いている秒数(解除のデバウンス)
    scanT: 0,        // 次のペア走査までの秒数
    rearmT: 0,       // 万能玉の再武装までの秒数
    grace: 0,        // 解除後の猶予秒(飛行中の弾・割り込み待ちの2個消しを守る)
    pulseT: 0,       // 発動中の脈動リングの周期タイマー
    droughted: false // 直近の走査で「危機レーンの先頭グループがペア枯渇」だったか
  };
  var choice = null;             // 選択UI {cont, rects, guardT}

  // ---------- 各所のフックが読む合成値 ----------
  // ドロップ率の合成倍率(powerups.js maybeDrop)。
  // 「目利き」系は主効果(💣🚀の重み)に加えてドロップ率も 8%/段 底上げする
  function dropMult() {
    var m = val("droprate");
    m *= 1 + 0.08 * (level("bombw") + level("missw"));
    if (rescueActive()) m *= PP.RESCUE.dropBoost;
    return Math.min(3.0, m);   // 全部盛りでも上限3倍(道具の仕事にしすぎない)
  }

  // パワーアップ抽選プールの重み補正(powerups.js drop / dropPower)。
  // 補正が無ければ元の配列をそのまま返す(浅いコピーは補正時のみ)
  function adjustPool(pool) {
    var bw = val("bombw"), mw = val("missw");
    var boost = rescueActive() ? PP.RESCUE.rescuePoolMult : 1;
    if (bw === 1 && mw === 1 && boost === 1) return pool;
    return pool.map(function (p) {
      var w = p.w;
      if (p.id === "bomb") w *= bw * boost;        // 救済中は立て直しの道具を厚く
      else if (p.id === "missile") w *= mw;
      else if (p.id === "stop") w *= boost;
      return { id: p.id, name: p.name, icon: p.icon, dur: p.dur, w: w };
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
      PP.fx.floatText("💎 制覇の証 +1000", PP.W / 2, 96, "#ffe08a", 24);
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
    if (id === "autoload") autoloadT = (g.upgrades[id] === 1) ? val(id) : Math.min(autoloadT, val(id));
    closeChoiceUI();
    g.state = "playing";
    PP.audio.catchItem();
    PP.fx.floatText(def.icon + " " + def.name + " Lv." + g.upgrades[id] + "!", PP.W / 2, 96, "#ffdf8a", 24);
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

    var title = new createjs.Text("💎 宝玉の力を選べ!",
      '800 34px "Cinzel","Hiragino Kaku Gothic ProN","Meiryo",serif', "#ffdf8a");
    title.textAlign = "center"; title.textBaseline = "middle";
    title.x = PP.W / 2; title.y = 104;
    title.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 3, 8);
    cont.addChild(title);

    // 2個目以降の 💎 が待っているときだけ残数を出す
    var subText = queued > 1 ? "残りの選択 あと " + (queued - 1) + " 回"
      : (PP.TOUCH ? "カードをタップで選択" : "カードをクリック(1〜3 キーでも選べる)");
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
    line(def.name, -hh + 122,
      'bold 24px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#f7ecce");
    line(lv === 0 ? "NEW!" : "Lv." + lv + " → Lv." + (lv + 1), -hh + 158,
      '600 16px "Cinzel","Meiryo",serif', lv === 0 ? "#8ef0d0" : "#ffd15a");
    line(preview(def, lv), -hh + 190,
      'bold 17px "Meiryo",sans-serif', "#ffdf8a");
    var desc = new createjs.Text(def.desc,
      '15px "Hiragino Kaku Gothic ProN","Meiryo",sans-serif', "#e6d3b8");
    desc.textAlign = "center"; desc.lineHeight = 24;
    desc.x = 0; desc.y = -hh + 228;
    c.addChild(desc);
    // 下部のキー刻印(タッチ端末ではキーが無いので出さない)
    if (!PP.TOUCH) line(String(i + 1), hh - 34, '700 22px "Cinzel",serif', "#caa96a");
    return c;
  }

  // 効果の数値プレビュー(「今 → 取ったら」)
  function preview(def, lv) {
    var id = def.id;
    if (def.kind === "interval") {
      return lv === 0 ? valAt(def, 1).toFixed(1) + " 秒ごとに発動"
        : valAt(def, lv).toFixed(1) + "秒 → " + valAt(def, lv + 1).toFixed(1) + "秒";
    }
    if (id === "cluster") {
      // 塊率の基準はコースごとに違う(コース5は 0.75)ので、絶対値ではなく
      // 「今のコースでどれだけ増えるか」の +% で見せる
      var base = (PP.game.builtCourse && PP.game.builtCourse.spawnCluster) || PP.SPAWN_CLUSTER;
      var cur = 1 - (1 - base) * Math.pow(0.85, lv);
      var nx = 1 - (1 - base) * Math.pow(0.85, lv + 1);
      return "同色率 +" + Math.round((nx - cur) * 100) + "%";
    }
    if (id === "barrelcap") return "許容 " + PP.barrelCap() + "個 → " + (PP.barrelCap() + 1) + "個";
    if (id === "coin") {
      var c0 = Math.max(2, PP.LIFE.coinsPerLife - lv);
      var c1 = Math.max(2, PP.LIFE.coinsPerLife - lv - 1);
      return "必要 " + c0 + "枚 → " + c1 + "枚";
    }
    if (id === "combo") {
      return (PP.COMBO_WINDOW * valAt(def, lv)).toFixed(1) + "秒 → " +
             (PP.COMBO_WINDOW * valAt(def, lv + 1)).toFixed(1) + "秒";
    }
    return "×" + valAt(def, lv).toFixed(2) + " → ×" + valAt(def, lv + 1).toFixed(2);
  }

  function closeChoiceUI() {
    if (!choice) return;
    PP.stage.removeChild(choice.cont);
    choice = null;
  }

  // ---------- 自動機銃 / 自動装填 / 救済(playing 中の毎 tick) ----------
  function update(dt) {
    if (has("autogun")) tickAutogun(dt);
    if (has("autoload")) tickAutoload(dt);
    tickRescue(dt);
  }

  // 大砲の真上の列で最初に当たる玉を返す(無ければ null)。
  // 「勝手に賢く消える」のではなく、大砲をどこに置くか=何を撃ち抜かせるかが
  // プレイヤーの判断になるようにする(引き金は自分の位置取り)。
  // 当たる/当たらないの規準はプレイヤーの弾(cannon.js firstHitY)と同じ:
  // 宝玉・洞窟内・トンネル内は対象外。横幅 D*0.9、一番手前(y が大きい)の玉。
  function findGunTarget() {
    var x = PP.cannon.x;
    var muzzleY = PP.cannon.y - 52;
    var best = null, bestY = 66;   // HUD 下端(66)より上に玉は無い
    PP.game.eachLaneBall(function (b, lane) {
      if (b.treasure || b.d < PP.R) return;
      if (lane.rail.tunnelAt(b.d)) return;
      var p = lane.rail.posAt(b.d);
      if (Math.abs(p.x - x) <= PP.D * 0.9 && p.y < muzzleY && p.y > bestY) {
        bestY = p.y;
        best = { lane: lane, ball: b, x: p.x, y: p.y };
      }
    });
    return best;
  }

  function tickAutogun(dt) {
    autogunT -= dt;
    if (autogunT > 0) return;
    var target = findGunTarget();
    // 真上に狙える玉が無い間は「装填済み」のまま待つ(タイマーは 0 で止める)。
    // 大砲がチェーンの上を横切った瞬間に発射される=位置取りが引き金になる
    if (!target) { autogunT = 0; return; }
    autogunT = val("autogun");
    fireGun(target);
  }

  // 銃弾を砲口から目標へ飛ばし、着弾で1個撃ち抜く。
  // 挿入(通常弾)にしないのは、勝手な発射が盤面にゴミ色を混ぜてプレイヤーの
  // 邪魔をするため。popRun も使わない: コンボを 1 に上書きして継続コンボを
  // 踏み潰し、maybeDrop まで回ってしまう。destroySingle は純粋な1個破壊+連鎖判定
  var GUN_SPEED = 3000;   // 銃弾の速さ px/s(通常弾の上限 2600 より速い=銃らしい)
  function fireGun(target) {
    var mx = PP.cannon.x, my = PP.cannon.y - 52;
    var lane = target.lane, ball = target.ball;
    // 弾道(トレーサー): 砲口から着弾点へ金の線が一瞬走り、すっと消える。
    // 「どこから撃って何に当たったか」がひと目で分かる=位置取りが引き金だと伝わる
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
    var time = Math.max(40, (my - target.y) / GUN_SPEED * 1000);
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
      PP.game.score += 5;
      PP.fx.ring(p.x, p.y, "#ffd24a", 6, 60, 300);
      PP.fx.floatText("🔫 +5", p.x, p.y - 20, "#ffd24a", 14);
      PP.hud.update();
    });
  }

  function tickAutoload(dt) {
    var g = PP.game;
    autoloadT -= dt;
    if (autoloadT > 0) return;
    // 特殊弾を所持中は「完成品を持って待つ」(空いた瞬間に届く)
    if (g.special) { autoloadT = 0; return; }
    autoloadT = val("autoload");
    // loadSpecial は使わない: あちらは砲身へ押し込み(specialLoaded=true)、
    // 狙い中の色玉を勝手に引っ込めてしまう。待機スロットへ静かに届ける
    g.special = Math.random() < 0.5 ? "bomb" : "missile";
    g.specialLoaded = false;
    PP.cannon.refreshBalls();
    PP.fx.floatText("⚙️ 自動装填! " + (g.special === "bomb" ? "💣" : "🚀"),
      86, PP.H - 120, "#8ef0d0", 18);
    PP.audio.catchItem();
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
      // このレーンは樽直前か(危機演出のライン PP.CRISIS.start より、さらに
      // 樽側の専用しきい値 PP.RESCUE.start。呑まれる寸前だけを救済の対象にする)
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
      // 万能玉を消費(発射)してもまだ枯渇が続くなら再武装(外した場合の保険)
      if (!rescue.wild) {
        rescue.rearmT -= dt;
        if (rescue.rearmT <= 0) armWild();
      }
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
    armWild();
    PP.fx.floatText("🌈 海神の加護! 万能玉!", PP.W / 2, 96, "#8ef0d0", 24);
    PP.fx.floatText("⚔ 加護の間は2個で消える!", PP.W / 2, 128, "#8ef0d0", 17);
    PP.audio.treasure();
  }

  function deactivateRescue() {
    rescue.active = false;
    // 飛行中の弾・割り込みアニメ待ち(INSERT_TIME)の2個消しを守る猶予。
    // これが無いと「万能玉を当てたのに、着弾までの間に走った走査が解除して
    // 3個ルールに戻り、約束の2個消しが起きない」レースが生まれる
    // (飛行 ~0.3秒 + 割り込みアニメ 0.14秒 を覆う長さ)
    rescue.grace = 0.5;
    // 装填済みの万能玉は取り上げない: 一度授けた玉を没収すると、狙いを
    // 定めている間に虹⇄通常色が入れ替わって理不尽に見える。撃つまで有効の
    // まま残し、解除は「以後の再武装をやめる」ことだけを意味する
    PP.fx.floatText("加護が解けた", PP.W / 2, 96, "#b0d8cc", 16);
  }

  function armWild() {
    rescue.wild = true;
    rescue.rearmT = PP.RESCUE.rearm;
    PP.cannon.refreshBalls();   // 装填玉の見た目を虹へ(cannon.js が wildArmed を見る)
  }

  // cannon.js fire が呼ぶ: 発射する通常色弾を万能玉として撃ち出す
  function wildArmed() { return rescue.wild; }
  function consumeWild() {
    if (!rescue.wild) return false;
    rescue.wild = false;
    rescue.rearmT = PP.RESCUE.rearm;
    return true;
  }

  // chain.js resolveMatchAt が読む: 撃った弾の割り込みは2個で消えるか
  function rescueActive() { return rescue.active || rescue.grace > 0; }

  // ---------- リセット ----------
  // レベル開始(startLevel)ごと: タイマーと救済を仕切り直す。段数と queued は残す
  function onLevelStart() {
    autogunT = has("autogun") ? val("autogun") : 0;
    autoloadT = has("autoload") ? val("autoload") : 0;
    rescue.active = false;
    rescue.wild = false;
    rescue.recoverT = 0;
    rescue.scanT = 0;
    rescue.rearmT = 0;
    rescue.grace = 0;
    rescue.pulseT = 0;
    rescue.droughted = false;
    closeChoiceUI();
  }

  // ランの終わり(ゲームオーバー / 全海域制覇のクリック)だけ: 段数ごと全部消す
  function onRunReset() {
    PP.game.upgrades = {};
    queued = 0;
    onLevelStart();
  }

  PP.upgrades = {
    level: level,
    has: has,
    val: val,
    dropMult: dropMult,
    adjustPool: adjustPool,
    clusterBoost: clusterBoost,
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
    onLevelStart: onLevelStart,
    onRunReset: onRunReset
  };
})();
