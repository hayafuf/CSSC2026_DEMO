/* =========================================================
 * powerups.js — 落下アイテム(宝・パワーアップ)
 *
 * 玉が消えると確率でアイテムがその場から落下する。
 * 大砲を横に動かしてキャッチすると、宝はスコア、
 * パワーアップは効果が発動する(原作準拠)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var items = []; // {x, y, vx, vy, kind, def, color, view}

  // アイテムの登場: その場で上向きに「ポンッ」とはじけ飛び、横に散りながら
  // 放物線を描いて落ちてくる(x・y 両方が動く。玉が弾けた勢いを引き継ぐ見せ方)。
  // 横速度は控えめにして、狙って取りに行ける範囲に収める
  function popVel() {
    return {
      vx: (Math.random() - 0.5) * 180,          // 横に ±90 px/s ほど散る
      vy: -(140 + Math.random() * 100)          // まず上へ 140〜240 px/s で短く鋭く跳ぶ
    };
  }

  // 玉が消えたときに呼ばれる。コンボ中はドロップ率が上がる
  // (ドロップ率は難易度で変えない。拾う気持ちよさは全難易度共通)。
  // コース定義の dropMult でコース単位の倍率を掛けられる(例: コース5は
  // 4レーン同時防衛が忙しいぶん、道具を多めに配って捌かせる)
  var downCd = 0;   // パワーダウンのクールダウン残り秒(連発防止)

  function maybeDrop(x, y) {
    var g = PP.game;
    // パワーダウン(取ってはいけない物)は独立の別ロール。
    // コンボボーナスも dropMult も掛けない: 上手いプレイの報酬が罠では本末転倒だし、
    // コース5(dropMult 2.5)が罠だらけになるのも防ぐ。ボス戦にも出さない。
    // クールダウン中も出さない(連鎖のたびに罠が降ってくるのを防ぐ)
    if (!g.bossMode && downCd <= 0 && Math.random() < PP.ITEMS.downChance) dropDown(x, y);
    var chance = PP.ITEMS.dropChance + Math.min(g.combo, 5) * PP.ITEMS.comboBonus;
    chance *= (g.builtCourse && g.builtCourse.dropMult) || 1;
    // 【強化】「戦利品の嗅覚」等のドロップ率倍率(救済中のブースト込み。上限3倍)
    chance *= PP.upgrades.dropMult();
    // 危機ボーナス: 樽に呑まれ始めるほど加算で上がる(あふれ寸前で +crisisDropBonus)。
    // crisis.level() は 0(平常)〜2(あふれ寸前)の滑らかな値
    var crisisLv = (PP.crisis && PP.crisis.level) ? PP.crisis.level() : 0;
    chance += PP.ITEMS.crisisDropBonus * (crisisLv / 2);
    // ピティ(追い詰め救済): GameOver後の再挑戦や連続失敗が続くプレイヤーに
    // 道具を厚く配る。倍率の外側で加算するので dropMult の上限(2.2)に食われない
    var pity = 0;
    if (g.continues > 0) pity += PP.ITEMS.pityContinueBonus;
    if (g.failStreak >= PP.ITEMS.pityFailFrom) {
      pity += (g.failStreak - PP.ITEMS.pityFailFrom + 1) * PP.ITEMS.pityFailBonus;
    }
    chance += Math.min(PP.ITEMS.pityCap, pity);
    if (Math.random() > chance) return;
    drop(x, y);
  }

  function drop(x, y) {
    var kind, def, color = null;
    if (Math.random() < PP.ITEMS.treasureWeight) {
      // 【課題5】通常ドロップの宝はコイン(🪙)として落ちる。
      // 大砲でキャッチすると PP.game.coins が増える(collect 参照)。
      // ※ チェーン末尾の宝玉を全消しで解放したときの 💎(dropTreasure)は宝のまま。
      kind = "coin";
      def = { icon: "🪙" };
    } else {
      kind = "power";
      // 種類は重み付き抽選(config.js の PP.POWERUPS の w。大きいほど出やすい)。
      // ボス戦では逆風(🌬️)を出さない: 短い2段コースでは風が強すぎて
      // チェーンが洞窟まで戻り切り、緊張感が消えてしまうため
      var pool = PP.POWERUPS;
      if (PP.game.bossMode) {
        pool = pool.filter(function (p) { return p.id !== "reverse"; });
      }
      // 【強化】「目利き」系(💣🚀の重み増)と救済中の ⚓💣 増量を反映
      def = weightedPick(PP.upgrades.adjustPool(pool));
      // カラーボムは「色」を持って落ちる。盤面に今ある色から選ぶので拾い損が無い
      if (def.id === "colorbomb") color = pickBoardColor();
    }
    var view = makeItemView(def.icon, color);
    view.x = x; view.y = y;
    PP.layers.item.addChild(view);
    var v = popVel();
    PP.fx.burst(x, y, "#ffe08a", 8, 1.0);   // 登場の「ポンッ」
    items.push({ x: x, y: y, vx: v.vx, vy: v.vy, kind: kind, def: def, color: color, view: view });
  }

  // パワーダウンアイテムの落下: 暗い紫の見た目で「避けるべき物」と分かる。
  // 落下・キャッチの仕組みはパワーアップと共通(update のループがそのまま捌く)
  function dropDown(x, y) {
    downCd = PP.ITEMS.downCooldown;
    var def = weightedPick(PP.POWERDOWNS);
    var view = makeItemView(def.icon, null, true);
    view.x = x; view.y = y;
    PP.layers.item.addChild(view);
    var v = popVel();
    PP.fx.burst(x, y, "#b040ff", 8, 1.0);   // 紫の飛沫=登場の時点で「罠」と分かる
    items.push({ x: x, y: y, vx: v.vx, vy: v.vy, kind: "down", def: def, color: null, view: view });
  }

  // 骸骨玉の撃破報酬: 確率もコインも罠も挟まず、パワーアップを確定で1個落とす
  // (chain.js destroyRange から呼ばれる)。リスクに見合う確実なリターン
  function dropPower(x, y) {
    var pool = PP.POWERUPS;
    if (PP.game.bossMode) {
      pool = pool.filter(function (p) { return p.id !== "reverse"; });
    }
    var def = weightedPick(PP.upgrades.adjustPool(pool));   // 【強化】重み補正を反映
    var color = (def.id === "colorbomb") ? pickBoardColor() : null;
    var view = makeItemView(def.icon, color);
    view.x = x; view.y = y;
    PP.layers.item.addChild(view);
    var v = popVel();
    PP.fx.burst(x, y, "#ffe08a", 10, 1.2);   // 確定報酬は少し豪華にはじける
    items.push({ x: x, y: y, vx: v.vx, vy: v.vy, kind: "power", def: def, color: color, view: view });
  }

  // 盤面(全レーン)に今ある色から1色選ぶ。玉が無ければ使用中の色数から選ぶ
  function pickBoardColor() {
    var present = [];
    var seen = {};
    PP.game.eachLaneBall(function (b) {
      if (b.color === null || b.color === undefined || seen[b.color]) return;
      seen[b.color] = true;
      present.push(b.color);
    });
    if (present.length === 0) return Math.floor(Math.random() * PP.game.nColors);
    return present[Math.floor(Math.random() * present.length)];
  }

  // 波を全消しして解放された宝玉の落下(chain.js から呼ばれる)
  function dropTreasure(x, y) {
    var def = { icon: "💎", value: 500 };
    var view = makeItemView(def.icon);
    view.x = x; view.y = y;
    view.scaleX = view.scaleY = 1.25;
    PP.layers.item.addChild(view);
    var v = popVel();
    PP.fx.burst(x, y, "#ffe08a", 12, 1.4);
    items.push({ x: x, y: y, vx: v.vx, vy: v.vy - 40, kind: "treasure", def: def, view: view });
  }

  // 重み付き抽選: 各要素の w(相対値)に比例した確率で1つ選ぶ。
  // 合計で正規化するので、w の合計が1になっていなくてもよい(学生が気軽に変えられる)
  function weightedPick(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += (list[i].w > 0 ? list[i].w : 0);
    if (total <= 0) return list[Math.floor(Math.random() * list.length)];
    var r = Math.random() * total;
    var acc = 0;
    for (i = 0; i < list.length; i++) {
      acc += (list[i].w > 0 ? list[i].w : 0);
      if (r < acc) return list[i];
    }
    return list[list.length - 1];
  }

  // colorIndex を渡すと、その色の玉として塗られる(カラーボム用)。
  // 「何色が消えるか」がアイテムの見た目だけで分かるようにする。
  // dark=true はパワーダウン用: 毒々しい紫のグロー+☠バッジ+棘付きの縁で
  // 「取ってはいけない」を遠目でも一瞬で伝える(パワーアップの金縁と明確に区別)
  function makeItemView(icon, colorIndex, dark) {
    var cont = new createjs.Container();
    var pal = (colorIndex !== null && colorIndex !== undefined) ? PP.PALETTE[colorIndex] : null;
    if (dark) {
      // 外周の警告グロー(強めに脈動させる。金色と絶対に見間違えない紫)
      var glow = new createjs.Shape();
      glow.graphics
        .beginRadialGradientFill(["rgba(176,64,255,0.55)", "rgba(176,64,255,0)"], [0.4, 1],
          0, 0, 6, 0, 0, 44)
        .drawCircle(0, 0, 44);
      cont.addChild(glow);
      createjs.Tween.get(glow, { loop: true })
        .to({ alpha: 0.25, scaleX: 0.8, scaleY: 0.8 }, 340, createjs.Ease.quadInOut)
        .to({ alpha: 1, scaleX: 1.15, scaleY: 1.15 }, 340, createjs.Ease.quadInOut);
      cont.pulse = glow;   // 後始末用(update が removeChild する前に止める)
    }
    var bg = new createjs.Shape();
    bg.graphics.beginFill(pal ? pal.main : (dark ? "#1a0e26" : "rgba(10,16,26,0.78)"))
      .beginStroke(pal ? pal.light : (dark ? "#b040ff" : "#f0c040")).setStrokeStyle(dark ? 4 : 3)
      .drawCircle(0, 0, 26);
    cont.addChild(bg);
    var t = new createjs.Text(icon, "30px serif", "#fff");
    t.textAlign = "center";
    t.textBaseline = "middle";
    t.shadow = pal ? new createjs.Shadow("rgba(0,0,0,0.8)", 0, 1, 4) : null;
    // 文字は生成後に変わらないので一度だけ焼く(Shadow 付き Text を素のまま
    // 置くと、落下中ずっと毎フレーム shadowBlur 付きの再ラスタライズが走る)
    t.cache(-28, -28, 56, 58);
    cont.addChild(t);
    if (dark) {
      // 右上の☠バッジ: 骸骨玉と同じ記号で「呪い系」だと直感で繋がるようにする
      var badge = new createjs.Text("☠", "18px serif", "#ff6b6b");
      badge.textAlign = "center";
      badge.textBaseline = "middle";
      badge.x = 19; badge.y = -19;
      badge.shadow = new createjs.Shadow("rgba(0,0,0,0.9)", 0, 1, 3);
      badge.cache(-18, -18, 36, 38);
      cont.addChild(badge);
    }
    return cont;
  }

  // アイテムの落下・キャッチ判定と、時間制エフェクトのタイマー更新
  function update(dt) {
    var g = PP.game;
    if (downCd > 0) downCd -= dt;
    for (var k in g.effects) {
      if (g.effects[k] > 0) g.effects[k] = Math.max(0, g.effects[k] - dt);
    }
    // 状態異常(bossFx)タイマーの減算はここ1か所だけ。
    // ボスの妖弾・骸骨玉の弾幕・パワーダウンアイテムの全員がここへ相乗りする
    // (powerups.update は全コースで毎フレーム呼ばれるので、通常コースでも減る)
    var bfx = g.bossFx;
    for (var bk in bfx) {
      if (bfx[bk] > 0) bfx[bk] = Math.max(0, bfx[bk] - dt);
    }
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      it.vy += PP.ITEMS.fallGravity * dt;
      it.y += it.vy * dt;
      // 横移動: はじけ飛んだ勢いは空気抵抗でゆっくり減衰し、落下は素直な放物線に
      // なる(横に流れ続けるとキャッチの狙いが付けられないため)。
      // 画面端では跳ね返して、取れない場所へ消えていかないようにする
      it.x += (it.vx || 0) * dt;
      it.vx = (it.vx || 0) * Math.max(0, 1 - dt * 0.9);
      if (it.x < 28) { it.x = 28; it.vx = Math.abs(it.vx); }
      else if (it.x > PP.W - 28) { it.x = PP.W - 28; it.vx = -Math.abs(it.vx); }
      it.view.x = it.x;
      it.view.y = it.y;
      var caught = Math.abs(it.x - PP.cannon.x) <= 46 &&
                   it.y >= PP.cannon.y - 34 && it.y <= PP.cannon.y + 26;
      if (caught) {
        collect(it);
      }
      if (caught || it.y > PP.H + 24) {
        // 掃討完了後のクリア待ち(main.js が「空中のアイテムが無くなるまで」
        // 走査の開始を待つ)中に 💎 を取り損ねても失われないように、
        // 画面外へ落ちた宝玉だけは自動回収する(従来 levelClear が持っていた保証)
        if (!caught && it.kind === "treasure" && g.finishing) {
          g.score += it.def.value;
          PP.upgrades.requestChoice();
          PP.fx.floatText(PP.i18n.t("pw.treasure", { n: it.def.value }), it.x, PP.H - 60, "#ffe08a", 20);
          PP.audio.treasure();
          PP.hud.update();
        }
        if (it.view.pulse) createjs.Tween.removeTweens(it.view.pulse);   // 明滅の後始末
        PP.layers.item.removeChild(it.view);
        items.splice(i, 1);
      }
    }
  }

  // 携帯のバイブレーション。対応していない端末(iPhone など)では何も起きない
  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  function collect(it) {
    PP.audio.catchItem();
    // 爆弾・ミサイルは特大、それ以外のアイテムは中くらいの振動
    var isBig = it.kind === "power" && (it.def.id === "bomb" || it.def.id === "missile");
    vibrate(isBig ? [140, 60, 220] : 60);
    if (it.kind === "coin") {
      // 【課題5】コインをキャッチ。枚数を増やして、ライフ回復の判定へ
      PP.game.coins++;
      // 必要枚数は【強化】「換金術」で減ることがあるので PP.coinsPerLife() を読む
      PP.fx.floatText("🪙 " + PP.game.coins + " / " + PP.coinsPerLife(), it.x, it.y - 22, "#ffe08a", 18);
      checkCoinLife();
      PP.hud.update();
    } else if (it.kind === "down") {
      // パワーダウンを取ってしまった: 効果はどちらも「取らなければ無害」。
      // 拾う位置取りのミスに対する、致命的でないペナルティに留める
      var g = PP.game;
      if (it.def.id === "ink") {
        g.bossFx.ink = it.def.dur;
        if (PP.skull) PP.skull.splatInk(3, it.def.dur);
        PP.fx.screenFlash("rgba(20,10,30,0.4)", 0.4, 400);
        PP.fx.floatText(PP.i18n.t("pw.ink"), it.x, it.y - 22, "#c890f0", 18);
      } else if (it.def.id === "shotSlow") {
        g.bossFx.shotSlow = it.def.dur;
        PP.fx.screenFlash("rgba(138,32,216,0.22)", 0.22, 600);
        PP.fx.floatText(PP.i18n.t("pw.shotSlow"), it.x, it.y - 22, "#c890f0", 18);
      }
      PP.audio.debuff();   // 状態異常がかかった合図(骸骨玉の被弾と同じ音)
      vibrate([80, 40, 160]);
    } else if (it.kind === "treasure") {
      PP.game.score += it.def.value;
      PP.fx.floatText("+" + it.def.value, it.x, it.y - 22, "#ffe08a", 18);
      // 【強化】宝玉の力: 選択の権利を1つ積む。ここでは state を変えず、
      // main.js の tick 末尾(まだ playing のとき)が3択を開く(遅延オープン)
      PP.upgrades.requestChoice();
      PP.hud.update();
    } else if (it.def.id === "colorbomb") {
      // カラーボムはキャッチした瞬間に発動: アイテムと同じ色の玉が全部消える
      colorBomb(it.color);
    } else {
      activate(it.def);
      PP.fx.floatText(it.def.icon + " " + PP.i18n.t("pu." + it.def.id) + "!", it.x, it.y - 22, "#8ef0d0", 18);
    }
  }

  // コインを拾うたびに呼ばれる。「コインがたまったらライフに変える」係。
  function checkCoinLife() {
    var g = PP.game;
    // 難易度「深海の悪魔」(useLives: false)ではライフ回復なし(救済のない1発ゲームオーバー)
    if (PP.diff().useLives === false) return;
    // 【課題5-1】コインが PP.LIFE.coinsPerLife 枚たまったらライフに変える。
    // ライフが上限(maxLives)のときは増やさず、コインは取っておく
    // (あふれた分は次の回復にそのまま使える)。
    // 必要枚数は【強化】「換金術」で減ることがあるので PP.coinsPerLife() を読む
    if (g.coins >= PP.coinsPerLife() && g.lives < PP.LIFE.maxLives) {
      g.coins -= PP.coinsPerLife();
      g.lives++;
      PP.fx.floatText(PP.i18n.t("pw.life"), PP.W / 2, 96, "#ff5d8f", 24);
    }
  }

  function activate(def) {
    var g = PP.game;
    if (def.dur > 0) {
      g.effects[def.id] = def.dur; // 取り直しで延長(リフレッシュ)
      if (def.id === "stop") PP.audio.chainStop();       // ⚓ 錨: チェーン停止の音
      else if (def.id === "slow") PP.audio.slow();       // 🐌 囚人の歩み: 発動音
      else if (def.id === "reverse") PP.audio.wind();    // 🌬️ 逆風: 発動音
      return;
    }
    if (def.id === "bomb") PP.cannon.loadSpecial("bomb");
    else if (def.id === "missile") PP.cannon.loadSpecial("missile");
  }

  // 玉の参照で持った run 群を後ろから消す(指定レーン内)。
  // popRun は連鎖判定で他の玉も巻き込むことがあるため、
  // 消す直前にインデックスを引き直し、消えた run は飛ばす。
  function popRuns(lane, runs) {
    var balls = lane.balls;
    for (var r = runs.length - 1; r >= 0; r--) {
      var a = balls.indexOf(runs[r][0]);
      var b = balls.indexOf(runs[r][1]);
      if (a < 0 || b < a) continue;
      PP.chain.popRun(lane, a, b);
    }
  }

  // 接触している同色の塊を列挙する {color, from, to, n}(指定レーン)。
  // 離れて並んでいるだけの玉は別の塊として扱う(見た目どおりに切る)
  function sameColorGroups(lane) {
    var balls = lane.balls;
    var D = PP.D;
    var groups = [];
    var i = 0;
    while (i < balls.length) {
      if (balls[i].treasure) { i++; continue; }
      var j = i;
      while (j + 1 < balls.length && !balls[j + 1].treasure &&
             balls[j + 1].color === balls[i].color &&
             balls[j].d - balls[j + 1].d <= D + 1) j++;
      groups.push({ color: balls[i].color, from: i, to: j, n: j - i + 1 });
      i = j + 1;
    }
    return groups;
  }

  // カラーボム: アイテム自体が「色」を持って落ちてくる(ドロップ時に盤面の色から
  // 選ばれる)。キャッチした瞬間、その色の玉が全レーンからすべて消える。
  function colorBomb(color) {
    var total = 0;
    var textP = null;
    var hitPts = [];   // 消える玉の画面座標(消す前に取っておく)
    PP.game.eachLane(function (lane) {
      var runs = [];
      sameColorGroups(lane).forEach(function (gr) {
        if (gr.color !== color) return;
        runs.push([lane.balls[gr.from], lane.balls[gr.to]]);
        total += gr.n;
        for (var i = gr.from; i <= gr.to; i++) {
          hitPts.push(lane.rail.posAt(lane.balls[i].d));
        }
      });
      if (runs.length) {
        if (!textP) textP = lane.rail.posAt(runs[0][0].d);
        popRuns(lane, runs);
      }
    });
    var pal = PP.PALETTE[color] || { light: "#8ef0d0" };
    if (total > 0) {
      // 「特別な力を使った」を全画面で伝える: その色の閃光 + 揺れ + 発動音
      PP.audio.colorBomb();
      PP.fx.screenFlash(pal.light, 0.35, 300);
      PP.fx.shake(Math.min(40, 10 + total * 2), 0.5);
      // 消えた場所を時間差の波で二次爆発させ、「掃かれていく」爽快感を出す
      // (多すぎると重いので最大30点に間引く)
      if (hitPts.length > 30) {
        var step = hitPts.length / 30, thin = [];
        for (var k = 0; k < 30; k++) thin.push(hitPts[Math.floor(k * step)]);
        hitPts = thin;
      }
      hitPts.forEach(function (p, i) {
        PP.fx.particles(p.x, p.y, color, i * 40);
      });
      PP.fx.floatText(PP.i18n.t("pw.colorbomb", { n: total }), textP.x, textP.y - 34, pal.light, 24);
    } else {
      // 落ちてくる間にその色が消え切っていた(拾い損の稀ケース)
      PP.fx.floatText(PP.i18n.t("pw.colorbombNone"), PP.W / 2, 96, pal.light, 18);
    }
  }

  // 【強化】ステージクリアの瞬間、空中に残っている 💎 を自動回収する
  // (main.js levelClear から)。最後の波の宝玉は「全消し=盤面が空」と同時に
  // 解放されるため、落下を待つ前にクリア判定が走り、今までは必ず取り損ねていた。
  // スコアと選択の権利(requestChoice)を両方与える。権利は次のステージの
  // 最初の playing フレームで3択として開く(キューの仕組みがそのまま面倒を見る)
  function collectTreasures() {
    var got = 0;
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (it.kind !== "treasure") continue;
      PP.game.score += it.def.value;
      PP.upgrades.requestChoice();
      PP.fx.floatText(PP.i18n.t("pw.treasure", { n: it.def.value }), it.x, it.y - 22, "#ffe08a", 20);
      if (it.view.pulse) createjs.Tween.removeTweens(it.view.pulse);
      PP.layers.item.removeChild(it.view);
      items.splice(i, 1);
      got++;
    }
    if (got) PP.audio.treasure();
    return got;
  }

  // レベル開始時のリセット
  function clear() {
    items.forEach(function (it) {
      if (it.view.pulse) createjs.Tween.removeTweens(it.view.pulse);
      PP.layers.item.removeChild(it.view);
    });
    items = [];
    downCd = 0;
    var eff = PP.game.effects;
    for (var k in eff) eff[k] = 0;
  }

  PP.powerups = {
    maybeDrop: maybeDrop,
    dropPower: dropPower,
    dropTreasure: dropTreasure,
    collectTreasures: collectTreasures,
    colorBomb: colorBomb,
    update: update,
    clear: clear,
    // 空中に残っているアイテム数(クリア時、走査開始を待つ判定に使う)
    count: function () { return items.length; }
  };
})();
