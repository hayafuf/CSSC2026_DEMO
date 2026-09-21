/* game-state.js — 実行中の状態の定義と初期値。
 * 進行の変更はsession.js、各レーンの物理更新はchain.jsが担当する。 */
(function () {
  "use strict";
  var PP = window.PP;

  /**
   * @typedef {Object} ChainBall
   * @property {number} d 洞窟からのレール距離(px)。先頭ほど大きい。
   * @property {number|null} color パレットの番号。宝玉はnull。
   * @property {boolean} [treasure] 波の末尾に付く宝玉か。
   * @property {number} wave 所属する波の番号。
   * @property {createjs.Container} view 表示物。削除時はTweenも解除する。
   */
  /**
   * @typedef {Object} Lane
   * @property {Object} rail 距離を座標に変換するレール。
   * @property {ChainBall[]} balls 樽側が先頭。dの降順を保つ。
   * @property {Array} pendingMatches 挿入アニメーション後の消去判定。
   * @property {number} pending これから補給する玉の数。
   */
  /**
   * @typedef {Object} Shot
   * @property {number} x 画面座標(px)。
   * @property {number} y 画面座標(px)。
   * @property {number} vx 横速度(px/秒)。
   * @property {number} vy 縦速度(px/秒)。
   * @property {number} wx 横風による追加速度(px/秒)。
   * @property {createjs.Container} view 発射弾の表示物。
   */
  /**
   * @typedef {Object} GameState
   * @property {'loading'|'title'|'intro'|'playing'|'choosing'|'retrying'|'draining'|'over'|'clear'|'gameclear'} state
   * @property {Lane[]} lanes レーンごとに独立したチェーン。
   * @property {Shot[]} shots 全レーン共通の発射弾。
   * @property {number} level 1から始まるステージ番号。
   * @property {number} score 周回中の得点。
   * @property {Object} effects 効果の残り秒数。
   * @property {Object} bossFx 状態異常の残り秒数。
   */

  // ---------- 共有状態 ----------
  // 各モジュールは PP.game を介して状態を読み書きする
  /** @type {GameState} */
  PP.game = {
    state: "loading",
    level: 1,
    difficulty: "normal", // 選択中の難易度(PP.DIFFICULTY のキー。タイトル画面で選ぶ)
    coins: 0,             // 【課題5】拾ったコインの枚数
    lives: PP.LIFE.startLives, // 【課題5】残りライフ(出航時から持っていて、コインで回復する)
    upgrades: {},         // 【強化】ラン単位の強化段数 {autogun:2, ...}。over/gameclear で空へ(upgrades.js)
    wildCharges: PP.WILD.baseMax, // 【新】虹玉の残りストック(リトライ・コンティニューを跨いで持続)
    wildMax: PP.WILD.baseMax,     // 【新】虹玉の最大ストック(「七海の虹玉」とコンティニューで増える)
    wildBonus: 0,                 // 【新】コンティニュー由来の最大ストック加算(ラン単位。upgrades.js recalcWildMax)
    continues: 0,         // 【新】このランで使ったコンティニュー回数(全クリア時の結果表示に出す)
    continueStages: [],   // 【新】コンティニューしたステージ番号の記録
    failStreak: 0,        // 【新】連続失敗回数(ライフ消費リトライ+コンティニュー。クリアで0へ)
    builtCourse: null,    // 現在レールを組んであるコース(同一なら組み直さない)
    speed: PP.speedProfile(null),  // 現在のコースの速度プロファイル(buildCourse で入れ替わる)
    customCourse: null,   // エディタ/共有コースの試遊中はここに入る(null=通常進行)
    score: 0,
    combo: 0,
    comboTimer: 0,
    // レーン(レール1本+そのチェーン)の配列。1本コースなら要素1。
    // 各レーン lane = {
    //   rail,            そのレーン専用のレール幾何インスタンス(rail.create)
    //   balls: [],       このレーンのチェーン。balls[0] が先頭(樽に一番近い)
    //                      通常の玉 {d, color, wave, view, pull, slide, ins}
    //                      宝玉     {d, color:null, treasure:true, wave, view, pull, slide}
    //   recoil: null,    磁力衝突の反動 {anchor, v, moved}(このレーン内)
    //   wave, pending, needTreasure, waveFresh, waveTimer,  波の補給状態(レーン単位)
    //   pendingMatches,  割り込みアニメ完了後に判定する {ball, t}
    //   barrel           このレーンの樽の表示パーツ {back, front, mouth, skull}
    // }
    // pull は磁力の巻き戻り速度、spdD/spdHold は前進速度の基準位置(chain.js 参照)。
    lanes: [],
    hasOverpass: false,   // どこかのレーンに立体交差があるか(buildCourse でメモ)
    ballsDirty: true,     // 玉レイヤーの並びが正準でなくなった=描画側が全積み直しで
                          // 作り直す(main.js renderChains)。通常の増減は差分更新で
                          // 済むので立てない — view の差し替えや宝玉の追加など、
                          // 並びの前提が崩れるまれなイベントだけが立てる
    colorsDirty: true,    // 盤面の色 or 手札が変わった=装填色の見張りを回す(cannon.js syncColors)
    shots: [],            // 飛行中の玉 {x, y, vx, vy, wx, color, roll, view}(全レーン共通。wx は横風による横速度)
    newUnlock: null,      // 全海域制覇で新しく解禁した難易度 id(制覇画面で1回祝ってから null へ)
    finishing: false,     // 掃討フェーズ(ゲージが空。補給は止まり、全レーン消し切ればクリア)
    timeLeft: 0,          // 生存ゲージ残り秒
    timeTotal: 0,
    nColors: 4,
    rolloutBoost: 0,      // レベル開始時のなだれ込み倍率(減衰する。全レーン共通)
    rolloutDone: false,
    currentColor: 0,      // 大砲に装填中の色
    nextColor: 0,         // 次弾の色
    special: null,        // 所持中の特殊弾 null | "bomb" | "missile"(1個まで。新規取得で置き換え)
    specialLoaded: false, // true=砲身に装填中(次の発射は特殊弾)/ false=砲脇スロットで待機
    // 残り秒数(全レーンに効く)。reverseHold は逆風終了後の静止ホールドで、
    // POWERUPS の id ではないので HUD のチップには出ない(hud.js は id しか見ない)
    effects: { slow: 0, reverse: 0, stop: 0, spyglass: 0, reverseHold: 0 },
    bossMode: false,      // ボス戦中か(startLevel がコースの boss フラグから設定)
    // 状態異常の残り秒数(ボスの妖弾・骸骨玉の弾幕・パワーダウンアイテムが使う)。
    // 減算は powerups.js の update ただ1か所で行い(全コースで毎フレーム動く)、
    // 消費側(main.js / cannon.js)は「> 0 か」を読むだけ。終了・リセット時に
    // 必ず 0 へ戻るので、入力・弾速・視界は確実に通常状態へ復帰する。
    // blackout: 裁きの雷霆の「暗闇」。装填中の玉が真っ黒(色不明)になり交換もできない
    bossFx: { ink: 0, addle: 0, freeze: 0, shotSlow: 0, blackout: 0 },

    // 全レーン / 全レーンの全玉を走査する共有ヘルパ(各モジュールの重複ループを集約)。
    // cb が false を返した時点で走査を打ち切る(早期終了用)。
    eachLane: function (cb) {
      for (var i = 0; i < this.lanes.length; i++) {
        if (cb(this.lanes[i], i) === false) return;
      }
    },
    eachLaneBall: function (cb) {
      for (var i = 0; i < this.lanes.length; i++) {
        var lane = this.lanes[i], balls = lane.balls;
        for (var j = 0; j < balls.length; j++) {
          if (cb(balls[j], lane, j, i) === false) return;
        }
      }
    }
  };

  // 前回遊んだ難易度を復元する(input.js が選択のたびに保存する)。
  // 保存が無い/知らないキー/まだ解禁されていない難易度なら既定の "normal" のまま
  // (別ブラウザや保存消去後に "gale" だけ残っていても、ロック中のものは選ばない)
  (function () {
    var saved = PP.store ? PP.store.get("lastDiff", null) : null;
    if (saved && PP.DIFFICULTY[saved] && !PP.diffLocked(saved)) PP.game.difficulty = saved;
  })();

  // ステージとレイヤー(main.js の init で設定)
  PP.stage = null;
  PP.layers = null;
})();
