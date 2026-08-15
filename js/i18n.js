/* =========================================================
 * 🏴‍☠️ 海賊の秘宝 — i18n.js(日本語/英語の切り替え)
 *
 * ゲーム中の全文言を「キー → 言語別の文字列」の辞書で持つ。
 * 使い方:
 *   PP.i18n.t("main.combo")                  … 現在の言語の文字列
 *   PP.i18n.t("hud.remain", { n: 12 })      … {n} が 12 に置き換わる
 *   PP.i18n.set("en")                        … 言語を切り替えて保存
 *   PP.i18n.onChange(fn)                     … 切り替え時に呼ばれる(再描画用)
 *
 * なぜ「連結」ではなく {n} の穴埋めにするか: 英語と日本語では語順が違う
 * ("あと3個" と "3 left")。文字列を分割して足し算すると言語ごとに
 * 並べ替えが必要になるが、テンプレートなら辞書側だけで語順を変えられる。
 *
 * このファイルは config.js より【前】に読み込む(config がデータ定義の
 * 時点で文言を引くため)。エディタ(editor.js)は今回対象外だが、
 * 対応するときは editor.* の名前空間をこの辞書に足せばよい。
 * ========================================================= */
(function () {
  "use strict";
  // 読み込み順の先頭なので、PP 名前空間はここで生まれることがある。
  // 「window.PP || {}」で守らないと、後から読むファイルが上書きしてしまう
  var PP = window.PP = window.PP || {};

  var LS_KEY = "pp.lang";   // 保存キー(コース保存の "pp.course.*" と同じ流儀)

  // ---------------- 辞書 ----------------
  var DICT = {};

  DICT.ja = {
    // ---- 共通 ----
    "common.tap": "タップ",
    "common.click": "クリック",
    // 言語ボタンは「切り替え先」の言語名を出す(日本語のとき→ English)
    "hud.langBtn": "🌐 English",

    // ---- index.html(静的文言) ----
    "html.title": "🏴‍☠️ 海賊の秘宝",
    "html.h1": "海賊の秘宝",
    "html.fsBtn": "全画面表示 (F キー)",
    "html.fsBtnAria": "全画面表示",
    "html.rotate": "📱 端末を横向きにしてください<br>この海賊船は横長の海でしか戦えません",
    "html.hint": "マウスで大砲を左右に移動、クリックで真上に発射!右クリックか Space で玉を交換。<b>Q キーか画面の 🌈 ボタンで虹玉(万能玉)を装填</b>。落ちてくる宝やパワーアップは大砲でキャッチ!<br>BGM と効果音は最初のクリックで鳴り始めます(M キーで消音)。<br>🛠 <b>E キー</b>か下のボタンで<b>コースエディタ</b>を開いて、自分だけの航路を作れます。",

    // ---- config.js: 難易度 ----
    "diff.easy.name": "みならい海賊",
    "diff.normal.name": "一人前の海賊",
    "diff.hard.name": "海賊船長",
    "diff.hardcore.name": "深海の悪魔",

    // ---- config.js: コース名 ----
    "course.route": "航路",
    "course.bridge": "橋を渡る道",
    "course.weave": "エディタのコース",
    "course.cavern": "洞窟の橋道",
    "course.quad": "四叉の激流",
    "course.kraken": "クラーケンの海域",

    // ---- config.js: パワーアップ / パワーダウン ----
    "pu.slow": "凪の鎖",
    "pu.reverse": "引き潮",
    "pu.stop": "海神の錨",
    "pu.bomb": "爆弾",
    "pu.missile": "ミサイル",
    "pu.colorbomb": "カラーボム",
    "pu.spyglass": "羅針の眼",
    "pd.ink": "墨壺",
    "pd.shotSlow": "時凪の呪い",

    // ---- config.js: 宝玉の力(強化カード) ----
    "ug.autogun.name": "自動機銃",
    "ug.autogun.desc": "ペアの無い孤立玉を\n自動で狙い撃つ",
    "ug.autobomb.name": "自動装填(ボム)",
    "ug.autobomb.desc": "数十秒ごとに爆弾が\nスロットへ届く",
    "ug.automissile.name": "自動装填(ミサイル)",
    "ug.automissile.desc": "数十秒ごとにミサイルが\nスロットへ届く",
    "ug.droprate.name": "戦利品の嗅覚",
    "ug.droprate.desc": "アイテムのドロップ率が\n上がる",
    "ug.cluster.name": "同色の潮流",
    "ug.cluster.desc": "補給される玉に\n同色の塊が増える",
    "ug.bombw.name": "火薬の目利き",
    "ug.bombw.desc": "ドロップ率が少し上がり\n爆弾が出やすくなる",
    "ug.missw.name": "火筒の目利き",
    "ug.missw.desc": "ドロップ率が少し上がり\nミサイルが出やすくなる",
    "ug.barrelcap.name": "深い樽底",
    "ug.barrelcap.desc": "樽が呑み込める玉の数が\n1個増える",
    "ug.recoil.name": "砲撃の重み",
    "ug.recoil.desc": "消したときの押し戻しが\n強くなる",
    "ug.combo.name": "コンボの余韻",
    "ug.combo.desc": "コンボの継続時間が\n延びる",
    "ug.coin.name": "換金術",
    "ug.coin.desc": "ライフ回復に必要な\nコインが1枚減る",
    "ug.bombradius.name": "大口径火薬",
    "ug.bombradius.desc": "爆弾の爆風が\n広がる",
    "ug.wildshot.name": "七海の虹玉",
    "ug.wildshot.desc": "虹玉の最大数が1増え\nその場で全回復する",

    // ---- upgrades.js: カード選択 UI・効果プレビュー ----
    "ug.ui.maxed": "💎 制覇の証 +1000",
    "ug.ui.pick": "💎 宝玉の力を選べ!",
    "ug.ui.remaining": "残りの選択 あと {n} 回",
    "ug.ui.pickTouch": "カードをタップで選択",
    "ug.ui.pickMouse": "カードをクリック(1〜3 キーでも選べる)",
    "ug.prev.interval0": "{v} 秒ごとに発動",
    "ug.prev.interval": "{a}秒 → {b}秒",
    "ug.prev.cluster": "同色率 +{n}%",
    "ug.prev.barrelcap": "許容 {a}個 → {b}個",
    "ug.prev.coin": "必要 {a}枚 → {b}枚",
    "ug.prev.wildshot": "最大 {a}個 → {b}個(全回復)",
    "ug.ui.autoload": "{icon} 自動装填!",
    "ug.ui.rescueOn": "🌊 海神の加護!",
    "ug.ui.rescueTwo": "⚔ 加護の間は2個で消える!",
    "ug.ui.rescueWildTouch": "🌈 ボタンで虹玉が使える!",
    "ug.ui.rescueWildKey": "🌈 Qキーで虹玉が使える!",
    "ug.ui.rescueOff": "加護が解けた",
    "ug.ui.wildEmpty": "🌈 在庫なし",
    "ug.ui.wildArmed": "🌈 虹玉 装填!",

    // ---- hud.js ----
    "hud.wildArmed": "装填中",
    "hud.chipLoaded": " 装填",
    "hud.chipWait": " 待機",
    "hud.wildChip": "🌈 装填 x{n}",
    "hud.bossGauge": "討伐せよ!",
    "hud.remain": "残り {n}",
    "hud.diffCaption": "難易度をえらぶ(1〜4 キーでも選べる)",
    "hud.overContinue": "⚓ この海域から再挑戦",
    "hud.overTitle": "🏠 タイトルへ戻る",
    "hud.overCaption": "R / T キーでも選べる",
    "hud.pauseTitle": "⚓ PAUSE ⚓",
    "hud.resumeTouch": "タップで再開",
    "hud.resumeMouse": "クリックか P キーで再開",
    "hud.pauseAuto": "船の外に出ていたので錨を下ろして停泊中\n用が済んだら、{resume}",
    "hud.pauseManual": "錨を下ろして停泊中…\n{resume}",

    // ---- cannon.js ----
    "cannon.next": "つぎ",
    "cannon.swapTouch": "砲をタップで交換",
    "cannon.swapKey": "Spaceで交換",
    "cannon.loaded": "装填中",
    "cannon.wait": "待機",
    "cannon.swapped": "入れ替え!",

    // ---- chain.js ----
    "chain.bigRecoil": "大反動 x{n}",
    "chain.treasureFree": "お宝解放!",
    "chain.treasureCrushed": "宝が砕けた…",
    "chain.combo": "コンボ x{n}!",
    "chain.skullReward": "☠ 撃破! +{n}",

    // ---- crisis.js ----
    "crisis.mouthOpen": "樽が口を開けた!",
    "crisis.swallowedLeft": "呑まれた!  あと {n} 個",
    "crisis.swallowed": "呑まれた!",
    "crisis.pushedBack": "押し戻した!",

    // ---- skull.js / 迎撃(boss.js と共用) ----
    "skull.freeze": "⛓ 動けない!",
    "skull.addle": "🌀 操作が逆に!",
    "fx.intercept": "迎撃!",

    // ---- boss.js ----
    "boss.atk.ink": "―― 漆黒の墨獄 ――",
    "boss.atk.addle": "―― 惑乱の逆潮 ――",
    "boss.atk.freeze": "―― 深淵の錨鎖 ――",
    "boss.atk.shotSlow": "―― 時凪の呪縛 ――",
    "boss.atk.randomize": "―― 運命のルーレット ――",
    "boss.atk.tentacle": "―― 海淵の大触腕 ――",
    "boss.atk.tsunami": "―― 終焉の大海嘯 ――",
    "boss.atk.barrage": "―― 妖星の豪雨 ――",
    "boss.atk.cross": "―― 両舷斉射 ――",
    "boss.hpLabel": "🐙 クラーケン",
    "boss.hitsLeft": "あと{n}",
    "boss.tentacleCut": "触手を斬り払った!",
    "boss.stopped": "攻撃を阻止した!!",
    "boss.rage": "クラーケンが怒り狂う!!",
    "boss.slain": "クラーケン撃破!!",
    "boss.banner": "最終海域 ―― 深淵の主 クラーケン",
    "boss.intro": "討ち取って海に平穏を!",
    "boss.hint": "🎯 頭に玉を当てて HP を削れ!   ⚡ 予兆中に当てれば攻撃を阻止!   🛡 妖弾は自弾で迎撃できる",

    // ---- main.js ----
    "main.finishing": "補給が止まった! 残りを掃討せよ!",
    "main.gcNoContinue": "🏅 ノーコンティニュー制覇!\n",
    "main.gcContinues": "🔱 コンティニュー {n}回 (ステージ {stages} で再起)\n",
    "main.gcTitleBoss": "🏆 クラーケン討伐! 全海域制覇!",
    "main.gcTitle": "🏆 全海域制覇!",
    "main.gcBody": "全 {total} ステージを生き延びた! 秘宝は我らのものだ!\n{honor}制覇ボーナス +5000\n最終スコア {score} 点\n{tap}で最初の海へ",
    "main.clearTitle": "⚓ ステージ {level}/{total} 制覇!",
    "main.clearBossBody": "生存ボーナス +1000 / スコア {score} 点 ――深淵の主が目を覚ました…\n🎯 クラーケンの頭に玉を当てて HP を削り切れば勝利!\n⚡ 予兆(チャージ)中に当てれば攻撃を阻止できる\n🛡 妖弾は自弾で迎撃できる(ミサイルは貫通)。樽への玉列も守り続けろ!\n{tap}で最終決戦へ",
    "main.clearBody": "耐え切って残りも掃討した! 生存ボーナス +1000\nスコア {score} 点\n{tap}で次のステージへ",
    "main.introGo": "⚓ 出 航 !",
    "main.introHint": "玉の通り道を見極めよ",
    "main.introSkip": "{tap}でスキップ",
    "main.battleStart": "⚔ 戦闘開始!",
    "main.sweepStart": "✨ 距離ボーナス!",
    "main.sweepBonus": "距離ボーナス +{n}",
    "main.retryLives": "❤ 残りライフ {n}",
    "main.retrySub": "同じ海域の最初から再挑戦",
    "main.retryGo": "❤ ライフを使って再挑戦!",
    "main.overTitle": "☠ ゲームオーバー",
    "main.overBody": "船は宝もろとも呑まれた…\n最終スコア {score} 点 (ステージ {level})\n再挑戦はスコア0から――\n宝玉の力は引き継がれる\n下のボタンで進路を選べ",
    "main.collectItems": "残ったアイテムを回収せよ!",
    "main.titleTitle": "🏴‍☠️ Are you ready?",
    "main.titleTouch": "タップで出航!\n◀ ▶ ボタンで大砲を移動(押し続けると加速)\nFIRE ボタンで発射(長押しで連射)、⇄ ボタンで玉を交換\n特殊弾は左下のスロットをタップで交換",
    "main.titleMouse": "クリックで出航!\nマウスで大砲を移動、クリックで発射\n右クリック / Space で玉を交換、M で消音\n特殊弾は左下のスロットをクリックで交換",
    "main.loadingTitle": "🏴‍☠️ 海賊の秘宝",
    "main.loading": "音楽を読み込み中…",
    "main.loadingN": "音楽を読み込み中… {loaded} / {total}",

    // ---- powerups.js ----
    "pw.treasure": "💎 宝玉を回収! +{n}",
    "pw.ink": "🦑 墨をかぶった!",
    "pw.shotSlow": "⏳ 弾が鈍い…",
    "pw.life": "❤ ライフ +1!",
    "pw.colorbomb": "🎨 この色を全撃破! {n}個",
    "pw.colorbombNone": "🎨 その色はもう残っていない…",

    // ---- input.js ----
    "in.mute": "🔇 消音",
    "in.unmute": "🔊 音あり",

    // ---- course-api.js(バリデーション。エディタ経由でユーザーに見える) ----
    "api.defaultName": "無名の航路",
    "api.lane": "レーン{n}: ",
    "api.tooFewPoints": "制御点が少なすぎます(最低 {n} 点)",
    "api.nan": "数値でない座標が含まれています",
    "api.tooShort": "コースが短すぎます(全長 {len}px。目安 {min}px 以上)",
    "api.outOfPlay": "{n} 個の制御点が遊べる領域からはみ出しています",
    "api.selfCross": "道が自分自身と交差しています。overpass:true で立体交差(橋)になります",
    "api.laneCross": "レーン同士が交差しています。上にするレーンへ raised:[{from,to}] か raisedOver:[相手レーンindex] を付けると橋になります",
    "api.speedWarn": "speed.entry(洞窟側)が speed.hole(樽の直前)以下です。手前ほど速くなります",
    "api.invalid": "コースが不正です: {errors}",
    "api.saveFailed": "保存に失敗しました(localStorage 不可): {msg}",
    "api.slotMissing": "スロットが見つかりません: {slot}"
  };

  DICT.en = {
    "common.tap": "Tap",
    "common.click": "Click",
    "hud.langBtn": "🌐 日本語",

    "html.title": "🏴‍☠️ Pirate's Treasure",
    "html.h1": "Pirate's Treasure",
    "html.fsBtn": "Fullscreen (F key)",
    "html.fsBtnAria": "Fullscreen",
    "html.rotate": "📱 Please turn your device sideways<br>This pirate ship only sails in landscape seas",
    "html.hint": "Move the cannon with your mouse, click to fire straight up! Right-click or Space to swap balls. <b>Press Q or the on-screen 🌈 button to load a rainbow (wild) ball</b>. Catch falling treasure and power-ups with the cannon!<br>Music and sounds start after your first click (M to mute).<br>🛠 Press <b>E</b> or the button below to open the <b>Course Editor</b> and build your own sea route.",

    "diff.easy.name": "Apprentice Pirate",
    "diff.normal.name": "Seasoned Pirate",
    "diff.hard.name": "Pirate Captain",
    "diff.hardcore.name": "Devil of the Deep",

    "course.route": "The Sea Route",
    "course.bridge": "The Bridge Road",
    "course.weave": "The Editor's Course",
    "course.cavern": "The Cavern Bridges",
    "course.quad": "The Four-Way Rapids",
    "course.kraken": "The Kraken's Waters",

    "pu.slow": "Chain of Calm",
    "pu.reverse": "Ebb Tide",
    "pu.stop": "Sea God's Anchor",
    "pu.bomb": "Bomb",
    "pu.missile": "Missile",
    "pu.colorbomb": "Color Bomb",
    "pu.spyglass": "Compass Eye",
    "pd.ink": "Ink Pot",
    "pd.shotSlow": "Curse of Still Time",

    "ug.autogun.name": "Auto Turret",
    "ug.autogun.desc": "Automatically snipes\nlone unpaired balls",
    "ug.autobomb.name": "Auto-Load: Bomb",
    "ug.autobomb.desc": "A bomb is delivered to\nyour slot periodically",
    "ug.automissile.name": "Auto-Load: Missile",
    "ug.automissile.desc": "A missile is delivered to\nyour slot periodically",
    "ug.droprate.name": "Nose for Loot",
    "ug.droprate.desc": "Items drop\nmore often",
    "ug.cluster.name": "Same-Color Current",
    "ug.cluster.desc": "Incoming balls form\nbigger same-color runs",
    "ug.bombw.name": "Powder Connoisseur",
    "ug.bombw.desc": "Slightly better drops,\nmore bombs among them",
    "ug.missw.name": "Rocket Connoisseur",
    "ug.missw.desc": "Slightly better drops,\nmore missiles among them",
    "ug.barrelcap.name": "Deep Barrel",
    "ug.barrelcap.desc": "The barrel can swallow\none more ball",
    "ug.recoil.name": "Cannon's Weight",
    "ug.recoil.desc": "Clearing balls pushes\nthe chain back harder",
    "ug.combo.name": "Combo Afterglow",
    "ug.combo.desc": "Combos stay alive\nlonger",
    "ug.coin.name": "Coin Alchemy",
    "ug.coin.desc": "One fewer coin needed\nto restore a life",
    "ug.bombradius.name": "Heavy Powder",
    "ug.bombradius.desc": "Bomb blasts reach\nwider",
    "ug.wildshot.name": "Rainbow of Seven Seas",
    "ug.wildshot.desc": "Max rainbow balls +1,\nrestocked on the spot",

    "ug.ui.maxed": "💎 Proof of Mastery +1000",
    "ug.ui.pick": "💎 Choose a gem power!",
    "ug.ui.remaining": "{n} more picks waiting",
    "ug.ui.pickTouch": "Tap a card to choose",
    "ug.ui.pickMouse": "Click a card (keys 1–3 also work)",
    "ug.prev.interval0": "Fires every {v}s",
    "ug.prev.interval": "{a}s → {b}s",
    "ug.prev.cluster": "Same-color rate +{n}%",
    "ug.prev.barrelcap": "Capacity {a} → {b}",
    "ug.prev.coin": "Needs {a} → {b} coins",
    "ug.prev.wildshot": "Max {a} → {b} (restocked)",
    "ug.ui.autoload": "{icon} Auto-loaded!",
    "ug.ui.rescueOn": "🌊 The Sea God's blessing!",
    "ug.ui.rescueTwo": "⚔ Pairs of 2 clear while blessed!",
    "ug.ui.rescueWildTouch": "🌈 The button loads a rainbow ball!",
    "ug.ui.rescueWildKey": "🌈 Press Q for a rainbow ball!",
    "ug.ui.rescueOff": "The blessing fades",
    "ug.ui.wildEmpty": "🌈 None left",
    "ug.ui.wildArmed": "🌈 Rainbow ball armed!",

    "hud.wildArmed": "Armed",
    "hud.chipLoaded": " loaded",
    "hud.chipWait": " ready",
    "hud.wildChip": "🌈 armed x{n}",
    "hud.bossGauge": "Slay the beast!",
    "hud.remain": "{n} left",
    "hud.diffCaption": "Choose your difficulty (keys 1–4 also work)",
    "hud.overContinue": "⚓ Retry this sea",
    "hud.overTitle": "🏠 Back to title",
    "hud.overCaption": "R / T keys also work",
    "hud.pauseTitle": "⚓ PAUSE ⚓",
    "hud.resumeTouch": "tap to resume",
    "hud.resumeMouse": "click or press P to resume",
    "hud.pauseAuto": "You left the ship, so the anchor is down\nWhen you are back, {resume}",
    "hud.pauseManual": "Anchored and resting…\n{resume}",

    "cannon.next": "NEXT",
    "cannon.swapTouch": "Tap cannon to swap",
    "cannon.swapKey": "Space to swap",
    "cannon.loaded": "Loaded",
    "cannon.wait": "Ready",
    "cannon.swapped": "Swapped!",

    "chain.bigRecoil": "Big recoil x{n}",
    "chain.treasureFree": "Treasure freed!",
    "chain.treasureCrushed": "The treasure shattered…",
    "chain.combo": "Combo x{n}!",
    "chain.skullReward": "☠ Destroyed! +{n}",

    "crisis.mouthOpen": "The barrel gapes open!",
    "crisis.swallowedLeft": "Swallowed!  {n} more to doom",
    "crisis.swallowed": "Swallowed!",
    "crisis.pushedBack": "Pushed it back!",

    "skull.freeze": "⛓ Can't move!",
    "skull.addle": "🌀 Controls reversed!",
    "fx.intercept": "Intercepted!",

    "boss.atk.ink": "―― Jet-Black Ink Prison ――",
    "boss.atk.addle": "―― Maddening Countertide ――",
    "boss.atk.freeze": "―― Anchor Chains of the Abyss ――",
    "boss.atk.shotSlow": "―― Binding of Still Time ――",
    "boss.atk.randomize": "―― Roulette of Fate ――",
    "boss.atk.tentacle": "―― Great Tentacle of the Deep ――",
    "boss.atk.tsunami": "―― Tsunami of the End ――",
    "boss.atk.barrage": "―― Rain of Baleful Stars ――",
    "boss.atk.cross": "―― Broadside Volley ――",
    "boss.hpLabel": "🐙 Kraken",
    "boss.hitsLeft": "{n} more",
    "boss.tentacleCut": "Tentacle severed!",
    "boss.stopped": "Attack interrupted!!",
    "boss.rage": "The Kraken is enraged!!",
    "boss.slain": "Kraken defeated!!",
    "boss.banner": "Final Waters ―― Kraken, Lord of the Abyss",
    "boss.intro": "Slay it and bring peace to the seas!",
    "boss.hint": "🎯 Hit the head to deal damage!   ⚡ Hit during a charge-up to interrupt!   🛡 Shoot down orbs with your own balls",

    "main.finishing": "Supply cut! Clear out the rest!",
    "main.gcNoContinue": "🏅 Conquered without a single continue!\n",
    "main.gcContinues": "🔱 {n} continue(s) (rallied at stage {stages})\n",
    "main.gcTitleBoss": "🏆 Kraken Vanquished!",
    "main.gcTitle": "🏆 Seas Conquered!",
    "main.gcBody": "All {total} stages survived! The treasure is ours!\n{honor}Conquest bonus +5000\nFinal score: {score}\n{tap} to return to the first sea",
    "main.clearTitle": "⚓ Stage {level}/{total} clear!",
    "main.clearBossBody": "Survival bonus +1000 / Score {score} ― the Abyss stirs…\n🎯 Whittle the Kraken's head down to zero HP to win!\n⚡ Hit it during a charge-up to interrupt the attack\n🛡 Shoot down orbs (missiles pierce). Guard the barrel!\n{tap} to enter the final battle",
    "main.clearBody": "You held out and swept the rest! Survival bonus +1000\nScore: {score}\n{tap} for the next stage",
    "main.introGo": "⚓ Set Sail!",
    "main.introHint": "Study the path of the balls",
    "main.introSkip": "{tap} to skip",
    "main.battleStart": "⚔ Battle begins!",
    "main.sweepStart": "✨ Distance bonus!",
    "main.sweepBonus": "Distance bonus +{n}",
    "main.retryLives": "❤ Lives left: {n}",
    "main.retrySub": "Retrying this sea from the start",
    "main.retryGo": "❤ Spent a life to retry!",
    "main.overTitle": "☠ GAME OVER",
    "main.overBody": "The ship sank, treasure and all…\nFinal score: {score} (stage {level})\nRetrying starts from score 0 ――\nyour gem powers carry over\nChoose your course with the buttons below",
    "main.collectItems": "Collect the remaining items!",
    "main.titleTitle": "🏴‍☠️ Are you ready?",
    "main.titleTouch": "Tap to set sail!\nMove the cannon with ◀ ▶ (hold to speed up)\nFIRE to shoot (hold for rapid fire), ⇄ to swap balls\nTap the lower-left slot to swap special shots",
    "main.titleMouse": "Click to set sail!\nMove the cannon with the mouse, click to fire\nRight-click / Space to swap balls, M to mute\nClick the lower-left slot to swap special shots",
    "main.loadingTitle": "🏴‍☠️ Pirate's Treasure",
    "main.loading": "Loading music…",
    "main.loadingN": "Loading music… {loaded} / {total}",

    "pw.treasure": "💎 Gem collected! +{n}",
    "pw.ink": "🦑 Covered in ink!",
    "pw.shotSlow": "⏳ Sluggish shots…",
    "pw.life": "❤ Life +1!",
    "pw.colorbomb": "🎨 That color wiped out! ×{n}",
    "pw.colorbombNone": "🎨 None of that color remains…",

    "in.mute": "🔇 Muted",
    "in.unmute": "🔊 Sound on",

    "api.defaultName": "Unnamed Route",
    "api.lane": "Lane {n}: ",
    "api.tooFewPoints": "Too few control points (minimum {n})",
    "api.nan": "Contains non-numeric coordinates",
    "api.tooShort": "Course too short (length {len}px; aim for at least {min}px)",
    "api.outOfPlay": "{n} control point(s) lie outside the playable area",
    "api.selfCross": "The path crosses itself. Set overpass:true to turn it into a bridge",
    "api.laneCross": "Lanes cross each other. Give the upper lane raised:[{from,to}] or raisedOver:[other lane index] to form a bridge",
    "api.speedWarn": "speed.entry (cave side) is not above speed.hole (near the barrel). Chains should run faster upstream",
    "api.invalid": "Invalid course: {errors}",
    "api.saveFailed": "Save failed (localStorage unavailable): {msg}",
    "api.slotMissing": "Slot not found: {slot}"
  };

  // ---------------- 本体 ----------------

  // {n} や {score} を params の値で置き換える(値が無い穴はそのまま残す=
  // キーの書き間違いに画面で気づける)
  function fmt(s, params) {
    if (!params) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return (params[k] === undefined || params[k] === null) ? m : String(params[k]);
    });
  }

  // localStorage はプライベートブラウズ等で例外を投げることがあるので
  // 必ず try/catch で包む(course-api.js の保存と同じ作法)
  function loadSaved() {
    try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
  }
  function save(lang) {
    try { localStorage.setItem(LS_KEY, lang); } catch (e) {}
  }

  // 初期言語: 保存があればそれ、無ければブラウザの言語設定で自動判定
  function initialLang() {
    var saved = loadSaved();
    if (saved === "ja" || saved === "en") return saved;
    var nav = (navigator.language || navigator.userLanguage || "ja");
    return nav.indexOf("ja") === 0 ? "ja" : "en";
  }

  var listeners = [];

  PP.i18n = {
    lang: initialLang(),

    // 現在の言語の文言を引く。無ければ日本語 → それも無ければキーそのもの
    // (欠落キーは画面にキー名が出る=デバッグで即発見できる)
    t: function (key, params) {
      var s = DICT[PP.i18n.lang][key];
      if (s === undefined) s = DICT.ja[key];
      if (s === undefined) return key;
      return fmt(s, params);
    },

    // 言語を切り替えて保存し、登録済みの再描画コールバックを全部呼ぶ
    set: function (lang) {
      if (lang !== "ja" && lang !== "en") return;
      if (lang === PP.i18n.lang) return;
      PP.i18n.lang = lang;
      save(lang);
      relabelDom();
      for (var i = 0; i < listeners.length; i++) listeners[i]();
    },

    // 切り替え時に呼び直したい処理(ビルド済みラベルの貼り替え)を登録する
    onChange: function (fn) { listeners.push(fn); },

    // コース名: 組み込みコースは nameKey で辞書を引き、エディタ製・自作
    // コースは name をそのまま出す(開集合なので辞書化できない)
    courseName: function (course) {
      if (!course) return "";
      if (course.nameKey) return PP.i18n.t(course.nameKey);
      return course.name || PP.i18n.t("api.defaultName");
    }
  };

  // ---- index.html の静的文言の差し替え ----
  // canvas の外にある DOM(見出し・操作説明・回転の案内)はここで直接書き換える。
  // 初回ロード時にも実行するので、英語ブラウザの初回訪問者には最初から英語が出る
  function relabelDom() {
    var t = PP.i18n.t;
    document.title = t("html.title");
    document.documentElement.lang = PP.i18n.lang;
    var el;
    if ((el = document.getElementById("titleText"))) el.textContent = t("html.h1");
    if ((el = document.getElementById("hintText"))) el.innerHTML = t("html.hint");
    if ((el = document.getElementById("rotateHint"))) el.innerHTML = t("html.rotate");
    if ((el = document.getElementById("fsBtn"))) {
      el.title = t("html.fsBtn");
      el.setAttribute("aria-label", t("html.fsBtnAria"));
    }
  }

  // このスクリプトは <head> 内ではなく </body> 直前で読まれるので、
  // DOM は出来上がっている。初回の差し替えを即実行する
  relabelDom();
})();
