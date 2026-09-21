/* boss-view.js — クラーケンの本体作画と触手のアニメーション。
 * 描画パーツをbattleに保持し、時計はboss.jsから受け取る。 */
(function () {
  "use strict";
  var PP = window.PP;
  PP.createBossView = function (battle, getTime) {
    function buildBody() {
      battle.body = new createjs.Container();
      battle.body.scaleX = battle.body.scaleY = 1.12;   // ひと回り大きく(当たり判定は config で別管理)

      // 触手(頭より下に描くので先に追加)
      battle.tentShape = new createjs.Shape();
      battle.body.addChild(battle.tentShape);

      // 頭(外套膜): 上へ膨らむドーム+下すぼまり。深緑〜青黒の放射グラデ
      var head = new createjs.Shape();
      var hg = head.graphics;
      hg.beginRadialGradientFill(["#2e5c4a", "#1a3028", "#0c1a14"], [0, 0.55, 1],
          -24, -46, 10, 0, -20, 110)
        .moveTo(-78, 26)
        .curveTo(-96, -40, -52, -88)    // 左肩 → 頭頂へ
        .curveTo(0, -122, 52, -88)      // 頭頂の丸み
        .curveTo(96, -40, 78, 26)       // 右肩へ
        .curveTo(40, 46, 0, 46)         // あご下
        .curveTo(-40, 46, -78, 26)
        .closePath();
      // 輪郭(闇に沈み切らないよう黒で締める)
      hg.setStrokeStyle(2.5).beginStroke("rgba(0,0,0,0.9)")
        .moveTo(-78, 26)
        .curveTo(-96, -40, -52, -88)
        .curveTo(0, -122, 52, -88)
        .curveTo(96, -40, 78, 26);
      // 頭頂の照り返し(月光。嵐の海なので鈍く)
      hg.endStroke().beginFill("rgba(180,220,200,0.10)")
        .drawEllipse(-52, -100, 62, 30);
      // 額の斑点(深海生物の模様)
      hg.beginFill("rgba(6,18,12,0.55)");
      hg.drawCircle(-30, -66, 7).drawCircle(6, -80, 5).drawCircle(34, -60, 6)
        .drawCircle(-6, -52, 4).drawCircle(48, -34, 4).drawCircle(-48, -38, 5);
      // 歴戦の傷跡: 頭を斜めに横切る太い裂傷+瘢痕、小傷2本
      hg.setStrokeStyle(4, "round").beginStroke("#41604f")
        .moveTo(-58, -84).lineTo(-38, -70).lineTo(-44, -58).lineTo(-24, -44).endStroke();
      hg.setStrokeStyle(1.5, "round").beginStroke("rgba(150,180,160,0.35)")
        .moveTo(-61, -82).lineTo(-41, -68).lineTo(-47, -56).lineTo(-27, -42).endStroke();
      hg.setStrokeStyle(2.5, "round").beginStroke("#3a564a")
        .moveTo(44, -92).lineTo(56, -74).endStroke()
        .setStrokeStyle(2, "round").beginStroke("#3a564a")
        .moveTo(60, -50).lineTo(74, -38).endStroke();
      // 刺さったままの銛の折れ先(討ち損じの証)
      hg.setStrokeStyle(3.5, "butt").beginStroke("#6a5238")
        .moveTo(58, -70).lineTo(72, -88).endStroke();
      hg.beginFill("#8a8a92").moveTo(70, -85).lineTo(78, -96).lineTo(75, -83).closePath();
      // 頭は完全に静的なのに、cache しないと放射グラデ+曲線+傷跡の全パスを
      // 毎フレーム再ラスタライズしてしまう(ボス戦中ずっと)。一度だけ焼いて
      // 以後はビットマップ1枚の blit にする。境界はパスの最遠点+ストローク幅
      // (x±96, y-122〜46)に余白を足した値
      head.cache(-100, -128, 200, 180);
      battle.body.addChild(head);

      // 生体発光の斑点(通常=青緑 / 怒り=血赤 の2セットを重ね、alpha で切替+明滅)
      battle.biolumA = new createjs.Shape();
      battle.biolumB = new createjs.Shape();
      var spots = [[-62, -52, 3], [-40, -84, 2.5], [-14, -98, 3], [16, -96, 2.5],
                   [42, -78, 3], [64, -46, 2.5], [-70, -20, 2], [70, -14, 2]];
      for (var si = 0; si < spots.length; si++) {
        battle.biolumA.graphics.beginFill("#39d8b8").drawCircle(spots[si][0], spots[si][1], spots[si][2]);
        battle.biolumB.graphics.beginFill("#ff5030").drawCircle(spots[si][0], spots[si][1], spots[si][2]);
      }
      battle.biolumA.compositeOperation = battle.biolumB.compositeOperation = "lighter";
      battle.biolumB.alpha = 0;
      // 斑点も静的(明滅は alpha 操作のみ)。cache 後も compositeOperation と
      // alpha はビットマップの描画時に効くので、見た目は変わらない
      battle.biolumA.cache(-76, -104, 152, 96);
      battle.biolumB.cache(-76, -104, 152, 96);
      battle.body.addChild(battle.biolumA, battle.biolumB);

      // 怒りフェーズの赤いリムライト(普段は透明。enterPhase2 で灯る)
      battle.rageRim = new createjs.Shape();
      battle.rageRim.graphics.setStrokeStyle(5).beginStroke("rgba(255,60,40,0.55)")
        .moveTo(-78, 26)
        .curveTo(-96, -40, -52, -88)
        .curveTo(0, -122, 52, -88)
        .curveTo(96, -40, 78, 26);
      battle.rageRim.compositeOperation = "lighter";
      battle.rageRim.alpha = 0;
      battle.rageRim.cache(-102, -128, 204, 162);   // 静的ストローク。灯すのは alpha だけ
      battle.body.addChild(battle.rageRim);

      // 目(血赤の眼球+縦スリット瞳)。瞳は update で大砲の方を向く。
      // 目の奥のグローが明滅して「見られている」圧を作る
      function makeEye(ex) {
        var glow = new createjs.Shape();
        glow.graphics.beginRadialGradientFill(
            ["rgba(255,60,40,0.7)", "rgba(255,60,40,0)"], [0, 1], 0, 0, 0, 0, 0, 30)
          .drawCircle(0, 0, 30);
        glow.compositeOperation = "lighter";
        glow.x = ex; glow.y = -18;
        // 目の各層も描画内容は静的(動くのは x/y と alpha)。放射グラデを
        // 毎フレーム描き直さないよう、それぞれ一度だけ焼く
        glow.cache(-32, -32, 64, 64);
        battle.eyeGlows.push(glow);
        var eye = new createjs.Shape();
        eye.graphics
          .beginRadialGradientFill(["#ffb090", "#cc2222", "#5a0505"], [0, 0.55, 1],
            0, 0, 2, 0, 0, 17)
          .drawEllipse(-15, -17, 30, 34)
          .setStrokeStyle(2).beginStroke("#050a08").drawEllipse(-15, -17, 30, 34);
        eye.x = ex; eye.y = -18;
        eye.cache(-18, -20, 36, 40);
        var pupil = new createjs.Shape();
        pupil.graphics.beginFill("#050202").drawEllipse(-2.8, -13, 5.6, 26);
        pupil.x = ex; pupil.y = -18;
        pupil.cache(-5, -15, 10, 30);
        battle.body.addChild(glow, eye, pupil);
        return pupil;
      }
      battle.eyeGlows.length = 0;
      battle.pupilL = makeEye(-36);
      battle.pupilR = makeEye(36);

      // 怒り眉(目の上に深く落ちる影のヒレ)
      var browL = new createjs.Shape();
      browL.graphics.beginFill("#06120c").moveTo(-62, -48).lineTo(-12, -38).lineTo(-54, -24).closePath();
      var browR = new createjs.Shape();
      browR.graphics.beginFill("#06120c").moveTo(62, -48).lineTo(12, -38).lineTo(54, -24).closePath();
      browL.cache(-64, -50, 54, 28);
      browR.cache(10, -50, 54, 28);
      battle.body.addChild(browL, browR);

      // くちばし(大きく裂けた口+骨白の牙)。妖弾はここから吐き出される
      var beak = new createjs.Shape();
      beak.graphics
        .beginFill("#0a0f0c").moveTo(-14, 14).lineTo(0, 34).lineTo(14, 14).closePath()
        .beginFill("rgba(200,40,30,0.4)").moveTo(-8, 17).lineTo(0, 28).lineTo(8, 17).closePath()
        // 牙(上あご2本+下あご2本)
        .beginFill("#d8d2b8")
        .moveTo(-12, 15).lineTo(-8, 24).lineTo(-5, 15).closePath()
        .moveTo(12, 15).lineTo(8, 24).lineTo(5, 15).closePath()
        .moveTo(-4, 30).lineTo(-2, 22).lineTo(1, 29).closePath()
        .moveTo(5, 29).lineTo(3, 22).lineTo(0, 28).closePath();
      beak.cache(-16, 12, 32, 24);
      battle.body.addChild(beak);

      // シールドの泡(3発被弾ごとの無敵中だけ光る。普段は透明)
      battle.shield = new createjs.Shape();
      battle.shield.graphics
        .beginRadialGradientFill(["rgba(120,200,255,0)", "rgba(120,200,255,0.10)", "rgba(160,220,255,0.30)"],
          [0, 0.8, 1], 0, -20, 20, 0, -20, 108)
        .drawEllipse(-108, -128, 216, 216)
        .setStrokeStyle(2.5).beginStroke("rgba(180,230,255,0.8)")
        .drawEllipse(-108, -128, 216, 216);
      battle.shield.compositeOperation = "lighter";
      battle.shield.alpha = 0;
      battle.shield.cache(-112, -132, 224, 224);   // 点灯は alpha 操作のみ
      battle.body.addChild(battle.shield);

      // 被弾の白フラッシュ(普段は透明)
      battle.hurt = new createjs.Shape();
      battle.hurt.graphics.beginFill("#ffffff")
        .moveTo(-78, 26).curveTo(-96, -40, -52, -88).curveTo(0, -122, 52, -88)
        .curveTo(96, -40, 78, 26).curveTo(40, 46, 0, 46).curveTo(-40, 46, -78, 26).closePath();
      battle.hurt.alpha = 0;
      battle.hurt.cache(-100, -128, 200, 180);
      battle.body.addChild(battle.hurt);

      return battle.body;
    }

    // 触手の再描画は PERF.TENT_HZ(PC 20Hz / タッチ 12Hz)に間引き、結果は cache して
    // blit する。太い round ストローク×8本の再ラスタライズは canvas で最も高い
    // 部類のコストで、揺れは sin(t*2) 程度なので 12〜20Hz サンプルでも見分けが
    // 付かない。WebGL では updateCache のたびに 390×245(約 380KB)のテクスチャを
    // GPU へ送り直すので、タッチ端末はさらに間引く。
    // 境界は式の最悪値(ex±sway, ey=34+148+46)+ストローク半幅から算出
    var tentAcc = 1;   // 初回は必ず描く
    function drawTentaclesThrottled(droop, dt) {
      tentAcc += dt;
      if (tentAcc < 1 / (PP.PERF.TENT_HZ || 20)) return;
      tentAcc = 0;
      drawTentacles(droop);
      if (battle.tentShape.cacheCanvas) battle.tentShape.updateCache();
      else battle.tentShape.cache(-195, 8, 390, 245);
    }

    // 触手を描き直す(8本。sin で位相をずらしてうねらせる)。
    // dying 中は droop(0→1)でだらりと垂れ下がる。
    function drawTentacles(droop) {
      var t = getTime();
      var g = battle.tentShape.graphics;
      g.clear();
      for (var i = 0; i < 8; i++) {
        var bx = -70 + i * 20;                       // 付け根(あご下に等間隔)
        var ph = i * 1.7;
        var sway = Math.sin(t * 2.0 + ph) * 24 * (1 - droop * 0.8);
        var reach = 126 + Math.sin(t * 1.3 + ph * 1.3) * 22;
        var ex = bx * 1.7 + sway * 2;                // 先端(外へ開きつつ揺れる)
        var ey = 34 + reach + droop * 46;
        var cx = bx * 1.15 + sway;                   // 中間の制御点
        var cy = 34 + reach * 0.45;
        // 太い根元 → 細い先端の2段描き(ストローク幅は1本の線で変えられないため)
        g.setStrokeStyle(22, "round").beginStroke("#14261e")
          .moveTo(bx, 30).quadraticCurveTo(cx, cy, (cx + ex) / 2, (cy + ey) / 2).endStroke();
        g.setStrokeStyle(12, "round").beginStroke("#1e3830")
          .moveTo((cx + ex) / 2 - 1, (cy + ey) / 2).quadraticCurveTo(ex, ey - 18, ex + sway * 0.4, ey).endStroke();
        // 吸盤(血の気を帯びた赤。生々しさを出す)と先端の丸
        g.beginFill("rgba(200,80,60,0.45)")
          .drawCircle((bx + cx) / 2, (30 + cy) / 2, 3.4)
          .drawCircle(cx, cy + 10, 3.0)
          .drawCircle((cx + ex) / 2, (cy + ey) / 2 + 8, 2.4)
          .drawCircle((cx + ex * 2) / 3, (cy + ey * 2) / 3 + 4, 2.0);
        g.beginFill("#1e3830").drawCircle(ex + sway * 0.4, ey, 6.5);
      }
    }

    // ---------- 組み立て ----------

    return {
      buildBody: buildBody,
      drawTentacles: drawTentacles,
      drawTentaclesThrottled: drawTentaclesThrottled
    };
  };
})();
