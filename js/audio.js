/* =========================================================
 * audio.js — 効果音と BGM
 *
 * ・短い電子音は WebAudio(beep)で合成する
 * ・素材のある音(SE/*.mp3)と BGM(BGM/*.mp3)は HTMLAudio で鳴らす
 * ・音源の読み込みには時間がかかるので、main.js は preload() の完了を
 *   待ってからタイトルを出す。ゲーム開始(クリック)と同時に BGM が
 *   頭から鳴るように、読み込み前にゲームを始めてしまわない。
 * ・ブラウザの自動再生制限があるので、最初のクリック/キー入力で
 *   PP.audio.unlock() を呼んでから BGM を流す(main.js から)
 * ・BGM は通常曲と危険曲の2本立て。先頭の玉が樽へ近づくと
 *   クロスフェードで危険曲へ切り替わる。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var audioCtx = null;
  var muted = false;
  var unlocked = false;

  // ---------- WebAudio: SE 用のリバーブ・バス ----------
  // BGM 以外の効果音(beep の合成音も mp3 も)は、この seBus を通して
  // destination へ流す。dry(そのまま)に、短いインパルス応答の convolver を
  // 通した wet を薄く足して「軽いリバーブ」を掛ける。
  // BGM は別系統(HTMLAudio を直接 destination で再生)なので dry のまま。
  var seBus = null, activeSE = [];

  function ensureCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e) {} }
    if (!seBus) buildSeBus();
    return audioCtx;
  }
  function buildSeBus() {
    try {
      seBus = audioCtx.createGain();
      seBus.gain.value = 1;
      var dry = audioCtx.createGain(); dry.gain.value = 1;
      seBus.connect(dry); dry.connect(audioCtx.destination);
      var conv = audioCtx.createConvolver();
      conv.buffer = makeImpulse(0.5, 2.4);        // 約0.5秒で減衰する短い残響
      var wet = audioCtx.createGain(); wet.gain.value = 0.16;   // 軽め
      seBus.connect(conv); conv.connect(wet); wet.connect(audioCtx.destination);
    } catch (e) { seBus = null; }
  }
  function makeImpulse(seconds, decay) {
    var rate = audioCtx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = audioCtx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }
  // HTMLAudio(mp3 の SE)を seBus に載せてリバーブを掛ける。クローンごとに一度だけ
  // MediaElementSource を作る。WebAudio が使えない/失敗した場合は素の再生に戻る。
  // persistent=true(プールで使い回すクローン)は配線を繋ぎっぱなしにする:
  // 停止中の media 要素は無音を出すだけなので、聴こえ方は都度切断と同一。
  function routeSE(el, persistent) {
    if (el._seSrc) return;
    // file:// で直接開くと MediaElementSource が無音化するブラウザがあるため、
    // その場合は配線せず素のまま鳴らす(合成音 beep のリバーブは有効のまま)
    if (location.protocol === "file:") return;
    var ctx = ensureCtx();
    if (!ctx || !seBus) return;
    try {
      var src = ctx.createMediaElementSource(el);
      src.connect(seBus);
      el._seSrc = src;
      activeSE.push(src);
      if (!persistent) {
        el.addEventListener("ended", function () {
          try { src.disconnect(); } catch (e) {}
          var k = activeSE.indexOf(src); if (k >= 0) activeSE.splice(k, 1);
        });
      }
    } catch (e) { /* フォールバック: そのまま destination で鳴る */ }
  }

  function beep(freq, dur, type, vol) {
    if (muted) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol || 0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(seBus || ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch (e) { /* 無音でも続行 */ }
  }

  // beep の兄弟: 周波数が f0 から f1 へ滑らかに動く(ライザー/フォール用)
  function gliss(f0, f1, dur, type, vol) {
    if (muted) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || "sawtooth";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(f1, t + dur);
      gain.gain.setValueAtTime(vol || 0.1, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(seBus || ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch (e) { /* 無音でも続行 */ }
  }

  // ---------- 効果音(mp3) ----------
  var sources = [];   // preload() で読み込み完了を待つ音源
  var sfxAll = [];    // sfx() が作った再生関数(携帯対応の解錠で使う)
  // 携帯対応: iOS(iPhone/iPad の Safari)は audio.volume の変更を無視する。
  // unlock() で実端末を調べて、効かない場合はクロスフェードを即時切替に落とす
  var canVolume = true;

  // 携帯対応: iOS は「ユーザー操作の中で一度 play した要素」しか、あとから
  // (tick やタイマーから)鳴らせない。最初のタップのうちに消音で一瞬
  // play → pause して、以後どこからでも鳴らせるように解錠しておく
  function bless(a) {
    try {
      a.muted = true;
      var p = a.play();
      var fin = function () {
        // 解錠中に本再生が始まった要素(選択難易度のBGM)は止めない
        if (a !== current) { try { a.pause(); a.currentTime = 0; } catch (e) {} }
        a.muted = false;
      };
      if (p && p.then) p.then(fin).catch(function () { a.muted = false; });
      else fin();
    } catch (e) { try { a.muted = false; } catch (e2) {} }
  }

  // 同じ音が重なっても切れないよう、複製した実体をプールして鳴らす。
  // 再生中(= ended でも paused でもない)の実体は絶対に奪わないので、
  // 重なりの聴こえ方は「毎回複製」と同一のまま、Audio 要素と WebAudio 配線の
  // 生成が実同時再生数(通常 2〜4 個)で頭打ちになる。
  // 長い音(ゲームオーバーの吸い込み)はリスタート時に止めたいので、
  // 最後に鳴らした実体を覚えておいて stop() で黙らせられるようにする。
  function sfx(src, vol) {
    var proto = new Audio(src);
    proto.preload = "auto";
    proto.volume = vol;
    sources.push(proto);
    var pool = [];
    var last = null;
    var f = function () {
      if (muted) return;
      try {
        var a = null;
        for (var i = 0; i < pool.length; i++) {
          if (pool[i].ended || pool[i].paused) { a = pool[i]; break; }
        }
        if (a) {
          a.currentTime = 0;        // 使い回し: 頭出しして鳴らし直す
        } else {
          a = proto.cloneNode();    // 全部再生中: 従来どおり複製を増やす
          a.volume = vol;
          routeSE(a, true);         // BGM 以外の SE は軽いリバーブを通す(配線は恒久)
          pool.push(a);
        }
        last = a;
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* 未解錠なら鳴らさない */ });
      } catch (e) { /* 無音でも続行 */ }
    };
    f.stop = function () {
      if (!last) return;
      try { last.pause(); last.currentTime = 0; } catch (e) { /* 無視 */ }
      last = null;
    };
    // 携帯対応: 最初のタップの中で解錠済みのクローンを1つ用意しておく。
    // iOS では解錠済みの実体しか tick からの再生ができないため、これが無いと
    // 「タップ以外のきっかけで鳴る音」(波の補給音など)が鳴らない
    f.prime = function () {
      if (pool.length) return;
      var a = proto.cloneNode();
      a.volume = vol;
      routeSE(a, true);
      pool.push(a);
      bless(a);
    };
    sfxAll.push(f);
    return f;
  }

  // ================================================================
  // TODO【課題4】SE(効果音)のカスタマイズ
  // 書き方: sfx("SE/ファイル名.mp3", 音量)。音量は 0(無音)〜 1(最大)。
  //  ・音量の数値を変えて保存 → 再読み込みで聞き比べてみよう
  //  ・自分の mp3 を SE/ フォルダに入れて、ファイル名を差し替えると
  //    その場面の音が変わる(例: 玉が当たる音を自作の音に)
  // どの変数がどの場面で鳴るかは、各行のコメントと変数名がヒント。
  // ================================================================
  var seHit = sfx("SE/hit_the_ball.mp3", 0.5);
  var seCrush = sfx("SE/broken_treasure.mp3", 0.7);
  var seNewChain = sfx("SE/new_chain2.mp3", 0.45);
  var seStop = sfx("SE/stop.mp3", 0.6);
  // ゲームオーバー: チェーンが樽へ吸い込まれていく音
  var seSuck = sfx("SE/gameover_suck.mp3", 0.9);
  // 追加SE: コンボ(合成音に重ねて厚みを足す)/ 囚人の歩み(スロー)発動
  var seCombo = sfx("SE/Combo_SE.mp3", 0.6);
  var seSlow = sfx("SE/prisoner.mp3", 0.6);
  // 追加SE: 逆風(発動)/ 生存ゲージの時間切れ(掃討フェーズ移行)
  var seWind = sfx("SE/wind.mp3", 0.6);
  var seTimeOver = sfx("SE/time_over.mp3", 0.7);
  // 追加SE: 爆弾の炸裂(合成音に重ねる)/ ミサイル発射
  var seBombBoom = sfx("SE/bomb_explosion.mp3", 0.85);
  var seMissile = sfx("SE/missile.mp3", 0.7);
  // 追加SE: 状態異常(骸骨玉の被弾・パワーダウン・ボスの妖弾直撃)
  var seDebuff = sfx("SE/user_debuff.mp3", 0.7);
  // 追加SE: クラーケン(被弾 / 撃破の断末魔 / 沈みゆく最期)
  var seKrakenDamage = sfx("SE/kraken_damage.mp3", 0.55);
  var seKrakenDeath = sfx("SE/kraken_death.mp3", 0.85);
  var seKrakenDeath2 = sfx("SE/kraken_death2.mp3", 0.85);
  // 追加SE: ステージクリアのファンファーレ(合成アルペジオに重ねる)
  var seStageClear = sfx("SE/stage_clear.mp3", 0.7);
  // 追加SE: ボスの攻撃(同心リング=深淵の錨鎖 / 津波の溜めと発射)
  var seRings = sfx("SE/concentric_rings.mp3", 0.7);
  var seTsunamiCharge = sfx("SE/tsunami_charge.mp3", 0.7);
  var seTsunami = sfx("SE/tsunami.mp3", 0.8);
  // 追加SE: 墨の着弾(ボスの墨獄・パワーダウン🦑)/ 骸骨玉の弾幕発射
  var seInk = sfx("SE/ink.mp3", 0.7);
  var seDarkMagic = sfx("SE/dark_magic.mp3", 0.65);
  // 追加SE: ボスの攻撃(運命のルーレット=水色の掃射 / 海淵の大触腕=触手突き上げ /
  //          惑乱の逆潮=ピンクの同心円リング展開)
  var seBossSweep = sfx("SE/ボス_水色の攻撃.mp3", 0.7);
  var seBossTentacle = sfx("SE/ボス_触手攻撃.mp3", 0.75);
  var seBossAddle = sfx("SE/ボス_魅惑の攻撃_ピンク色の同心円攻撃.mp3", 0.7);
  // カラーボム発動: 選ばれた色が盤面から一掃されるときの炸裂音
  // ================================================================
  // TODO【課題4】カラーボムで再生するSEファイルを指定してみよう
  // 書き方: sfx("SE/ファイル名.mp3", 音量)。音量は 0(無音)〜 1(最大)。
  //  ・自分の mp3 を SE/ フォルダに入れて、下のファイル名を差し替えると
  //    カラーボムの発動音が変わる(例: sfx("SE/自分の音.mp3", 0.8))
  // ================================================================
  var seColorBomb = sfx("SE/broken_treasure.mp3", 0.8);

  // ---------- 危機のループ音 ----------
  // 樽に呑まれかけている間ずっと鳴らし続ける。深さ(0〜1)で音量とピッチが
  // 上がり、逃げ場がなくなる感じを作る。BGM とは別系統なので、
  // 危険曲の上に警報として重なる。
  var loopCrisis = new Audio("SE/crisis.mp3");
  loopCrisis.loop = true;
  loopCrisis.preload = "auto";
  loopCrisis.volume = 0;
  sources.push(loopCrisis);
  // TODO【課題4】危機警報の音量レンジ(min=危機の入り口 / max=樽に呑まれる寸前)
  var CRISIS_VOL = { min: 0.3, max: 0.85 };

  function crisis(x) {
    x = Math.max(0, Math.min(1, x || 0));
    if (x < 0.01 || muted || !unlocked) {
      if (!loopCrisis.paused) { loopCrisis.pause(); loopCrisis.currentTime = 0; }
      loopCrisis.volume = 0;
      return;
    }
    loopCrisis.volume = CRISIS_VOL.min + (CRISIS_VOL.max - CRISIS_VOL.min) * x;
    loopCrisis.playbackRate = 1 + 0.2 * x;    // 深いほど気ぜわしく
    routeSE(loopCrisis);                        // 警報にも軽いリバーブ(一度だけ配線)
    if (loopCrisis.paused) play(loopCrisis);
  }

  // 玉が1個ぶん樽に落ちた。腹に来る重い衝撃
  function swallowed(deep) {
    beep(70 - deep * 12, 0.7, "sine", 0.34);
    beep(180, 0.22, "sawtooth", 0.14);
    setTimeout(function () { beep(52 - deep * 8, 0.9, "sine", 0.28); }, 80);
  }

  // 心拍のたびに地の底から唸る。x=0〜1 で深さ
  function growl(x) {
    beep(36 + Math.random() * 8, 0.55, "sawtooth", 0.07 + 0.13 * x);
    beep(55, 0.42, "square", 0.03 + 0.05 * x);
    setTimeout(function () {
      beep(29 + Math.random() * 5, 0.7, "sine", 0.06 + 0.1 * x);
    }, 110);
  }

  // 押し戻した。短い安堵
  function pushedBack() {
    beep(392, 0.12, "triangle", 0.11);
    setTimeout(function () { beep(587, 0.16, "triangle", 0.1); }, 90);
  }

  // ---------- BGM ----------
  // TODO【課題4】BGM のカスタマイズ
  //  ・BGM_VOL を変えると BGM 全体の音量が変わる(0〜1)
  //  ・プレイ中の曲は「難易度ごと」に指定できる → config.js の PP.DIFFICULTY の
  //    bgm: を差し替えよう(難易度でBGMを変える課題はそちら)
  //  ・危機のとき(bgmDanger)とゲームオーバー(bgmOver)の曲を変えたいときは、
  //    下の track("BGM/…") のファイル名を差し替える
  var BGM_VOL = 0.35;
  var tracks = [];
  function track(src, vol) {
    var a = new Audio(src);
    a.loop = true;
    a.preload = "auto";
    a.volume = 0;
    a.vol = vol || BGM_VOL;      // その曲の再生音量
    sources.push(a);
    tracks.push(a);
    return a;
  }
  var bgmNormal = track("BGM/Game_music.mp3");
  var bgmDanger = track("BGM/Denger.mp3");
  var bgmOver = track("BGM/gameover_BGM.mp3", 0.5);
  var bgmBoss = track("BGM/BOSS_BGM.mp3");    // ボス戦(クラーケンの海域)専用曲
  // 難易度ごとの通常曲(config.js の PP.DIFFICULTY の bgm)を実体化して使い回す。
  // 既定曲は起動時に読み込み済み。学生が追加した曲は最初に鳴らすときに読み込む
  var normalBySrc = { "BGM/Game_music.mp3": bgmNormal };
  function normalTrackFor(src) {
    if (!src) return normalBySrc["BGM/Game_music.mp3"];
    if (!normalBySrc[src]) normalBySrc[src] = track(src);
    return normalBySrc[src];
  }
  var current = null;       // いま鳴らしたい曲(null なら全部消す)
  var fadeTimer = null;
  var fadeMs = 500;

  function play(a) {
    try {
      var p = a.play();
      if (p && p.catch) p.catch(function () { /* 未解錠 */ });
    } catch (e) { /* 無音でも続行 */ }
  }

  // current へクロスフェード(他の曲は 0 まで下げて停止)
  function fade(ms) {
    fadeMs = ms || 500;
    // 携帯対応: iOS など volume の変更が効かない端末ではクロスフェードが
    // 成立しない(全曲が最大音量のまま重なる)ので、即時切り替えで代用する
    if (!canVolume) {
      tracks.forEach(function (a) {
        if (!muted && a === current) { if (a.paused) play(a); }
        else if (!a.paused) a.pause();
      });
      return;
    }
    if (fadeTimer) return;
    fadeTimer = setInterval(function () {
      var done = true;
      var steps = Math.max(1, fadeMs / 33);
      tracks.forEach(function (a) {
        var target = (!muted && a === current) ? a.vol : 0;
        var step = a.vol / steps;
        if (Math.abs(a.volume - target) <= step) {
          a.volume = target;
        } else {
          a.volume += (target > a.volume ? step : -step);
          done = false;
        }
        if (a.volume === 0 && !a.paused) a.pause();
        if (a.volume > 0 && a.paused) play(a);
      });
      if (done) { clearInterval(fadeTimer); fadeTimer = null; }
    }, 33);
  }

  // ---------- ポーズ(pause.js から呼ばれる) ----------
  // ポーズ中は BGM・危機警報・合成音をすべて止める。復帰時は鳴っていた
  // 曲だけ再開し、音量は fade() で目標値へ再収束させる(冪等)。
  var pausedTracks = [];
  var pausedCrisisLoop = false;
  function pauseAll() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    pausedTracks = [];
    tracks.forEach(function (a) {
      if (!a.paused) { pausedTracks.push(a); a.pause(); }
    });
    pausedCrisisLoop = !loopCrisis.paused;
    if (pausedCrisisLoop) loopCrisis.pause();
    if (audioCtx && audioCtx.state === "running") {
      try { audioCtx.suspend(); } catch (e) { /* 無視 */ }
    }
  }
  function resumeAll() {
    if (audioCtx && audioCtx.state === "suspended") {
      try { audioCtx.resume(); } catch (e) { /* 無視 */ }
    }
    pausedTracks.forEach(function (a) { play(a); });
    pausedTracks = [];
    if (pausedCrisisLoop) { play(loopCrisis); pausedCrisisLoop = false; }
    if (unlocked) fade();
  }

  // フェードを待たずに全部の曲を切る(ゲームオーバーの「ぶつ切り」用)
  function cutAll() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    current = null;
    tracks.forEach(function (a) {
      a.volume = 0;
      if (!a.paused) a.pause();
    });
  }

  // 全音源の読み込みを待つ。onProgress(読込済, 総数) を随時呼び、
  // 全部揃うか TIMEOUT を過ぎたら done() を呼ぶ(音が無くても遊べるように)。
  function preload(onProgress, done) {
    var TIMEOUT = 15000;
    var total = sources.length;
    var loaded = 0;
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      done();
    }
    function one() {
      loaded++;
      if (onProgress) onProgress(loaded, total);
      if (loaded >= total) finish();
    }
    sources.forEach(function (a) {
      var settled = false;
      function hit() {
        if (settled) return;
        settled = true;
        a.removeEventListener("canplaythrough", hit);
        a.removeEventListener("error", hit);
        one();
      }
      if (a.readyState >= 4) { hit(); return; }   // HAVE_ENOUGH_DATA
      a.addEventListener("canplaythrough", hit);
      a.addEventListener("error", hit);
      try { a.load(); } catch (e) { hit(); }
    });
    if (total === 0) finish();
    setTimeout(finish, TIMEOUT);
  }

  // 最初のユーザー操作で呼ぶ。ブラウザの自動再生制限を解除するだけで、
  // ここでは BGM を鳴らさない(タイトル画面でのクリック/キー入力だけで
  // 曲が鳴り出さないように)。実際の再生はゲーム開始時の gameStart() が行う。
  var primeIdx = 0;   // 携帯対応: 何番目の効果音まで解錠したか
  function unlock() {
    if (!unlocked) {
      unlocked = true;
      ensureCtx();     // WebAudio(効果音)の解錠。BGM はここでは鳴らさない
      // 携帯対応 その1: volume の変更が効く端末か調べる(iOS は無視される)
      try {
        var probe = new Audio();
        probe.volume = 0.5;
        canVolume = Math.abs(probe.volume - 0.5) < 0.01;
      } catch (e) { /* 判定できなければ従来どおり */ }
      // 携帯対応 その2: 最初のタップのうちに BGM と危機警報を消音で解錠する。
      // これをしないと iOS では、tick から切り替わる危機BGM・ゲームオーバー
      // BGM が鳴らない。PC はページ単位の許可なので不要(=従来と同じ動作)
      if (PP.TOUCH) {
        tracks.forEach(bless);
        bless(loopCrisis);
      }
    }
    // 携帯対応 その3: 効果音のクローンは「タップのたびに少しずつ」解錠する。
    // 1回に全部やると BGM の出だしと読み込みを取り合って曲が遅れて聴こえる。
    // unlock() は操作のたびに呼ばれるので、数タップで全部解錠し終わる
    if (PP.TOUCH) {
      for (var n = 0; n < 2 && primeIdx < sfxAll.length; n++) {
        sfxAll[primeIdx++].prime();
      }
    }
  }

  function setDanger(on) {
    if (!unlocked) return;
    if (current === bgmOver) return;   // ゲームオーバー中は曲を戻さない
    // ボス戦はボス曲を流し続ける: ボス戦は補給が絶え間なく危機を頻繁に往復する
    // ので、そのたびに曲が替わる(しかも復帰でイントロから鳴り直す)と決戦の
    // 緊張感が切れる。危機の緊迫は警報ループ(crisis.mp3)が担っている
    if (PP.game && PP.game.bossMode) on = false;
    var want = on ? bgmDanger : bgmNormal;
    if (want === current) return;
    // 曲を切り替えるときは頭出しして、危険の始まりが分かるようにする
    want.currentTime = 0;
    current = want;
    fade();
  }

  // ゲームオーバーの瞬間: 音楽を断ち切って無音にする。
  // 派手な音を重ねるより、鳴っていた曲が消える方がずっと怖い。
  function overCut() {
    cutAll();
    crisis(0);        // 警報も道連れに黙らせる(無音が一番怖い)
    seSuck.stop();
    // 足元が抜けるような超低音を一発だけ
    beep(46, 1.4, "sine", 0.32);
    beep(31, 1.8, "sine", 0.26);
  }

  // 樽が呑み込んだ瞬間の鈍い衝撃
  function overSnap() {
    beep(38, 1.6, "sine", 0.35);
    beep(120, 0.35, "sawtooth", 0.12);
    setTimeout(function () { beep(28, 2.0, "sine", 0.3); }, 90);
  }

  // 心音(吸い込まれている間、無音の底で打ち続ける)
  function heartbeat() {
    beep(52, 0.16, "sine", 0.3);
    setTimeout(function () { beep(44, 0.22, "sine", 0.24); }, 190);
  }

  // ドクロが顔面まで飛び込んでくる瞬間の刺し音
  function sting() {
    beep(1150, 0.18, "sawtooth", 0.1);
    beep(1720, 0.13, "square", 0.05);
    beep(58, 1.3, "sine", 0.32);
    setTimeout(function () { beep(880, 0.22, "sawtooth", 0.06); }, 70);
  }

  // ゲームオーバー BGM をゆっくり立ち上げる
  function overBgm() {
    if (!unlocked) return;
    bgmOver.currentTime = 0;
    current = bgmOver;
    fade(2200);
  }

  // レベル開始・リスタート: 通常曲へ戻す。
  // 通常曲は難易度ごとに違ってよい(【課題4】config.js の PP.DIFFICULTY の bgm)
  function gameStart() {
    crisis(0);
    if (!unlocked) return;
    seSuck.stop();
    // ボス戦は専用曲。それ以外は選択中の難易度の曲に差し替える。
    // bgmNormal を差し替えておけば、危機(setDanger)からの復帰も同じ曲へ戻る
    bgmNormal = (PP.game && PP.game.bossMode) ? bgmBoss : normalTrackFor(PP.diff().bgm);
    // すでに通常曲が流れているなら止めない(レベル間で曲を切らない)
    if (current === bgmNormal && !bgmNormal.paused) return;
    current = bgmNormal;
    bgmNormal.currentTime = 0;
    bgmNormal.volume = muted ? 0 : bgmNormal.vol;
    play(bgmNormal);
    fade(300);
  }

  function setMuted(on) {
    muted = on;
    if (unlocked) fade();
    return muted;
  }

  PP.audio = {
    beep: beep,
    gliss: gliss,
    preload: preload,
    unlock: unlock,
    setDanger: setDanger,
    setMuted: setMuted,
    toggleMute: function () { return setMuted(!muted); },
    isMuted: function () { return muted; },

    fire: function () { beep(220, 0.1, "square", 0.06); },
    // 発射玉がチェーンに刺さった
    hit: seHit,
    // 宝を持たない分断チェーンが停止した
    chainStop: seStop,
    // 新しい波が洞窟から湧いた
    newWave: seNewChain,
    pop: function (n) { beep(500 + Math.min(n, 8) * 40, 0.18); },
    // コンボ: 元の合成音を重厚化(主音 + 重低音の芯 + さらに下のサブ + 上の煌めき)
    // し、ユーザー追加の combo_SE.mp3 を重ねて鳴らす
    combo: function (c) {
      var f = 600 + Math.min(c, 8) * 120;
      beep(f, 0.26, "triangle", 0.14);          // 元の主音(少し伸ばす)
      beep(f * 0.5, 0.5, "sawtooth", 0.13);     // 重低音の芯(倍音多め)
      beep(f * 0.25, 0.55, "sine", 0.14);       // さらに下のサブベース
      setTimeout(function () { beep(f * 1.5, 0.2, "square", 0.05); }, 55);  // 上の煌めき
      seCombo();                                // 追加のコンボSE
    },
    // 囚人の歩み(スロー)発動音
    slow: seSlow,
    // 逆風の発動音
    wind: seWind,
    // 生存ゲージの時間切れ(掃討フェーズ移行)
    timeOver: seTimeOver,
    swap: function () { beep(440, 0.08, "sine", 0.06); },
    // ---- クリア走査(距離ボーナス)の音 ----
    // 発進: 巻き上がるライザー + 腹に来る号砲(樽口の flash/ring/burst と同時に鳴らす)
    sweepStart: function () {
      gliss(180, 760, 0.5, "sawtooth", 0.12);
      beep(90, 0.4, "sine", 0.2);
    },
    // 走査のチクタク(n = 通過した玉数)。折り返さず頭打ちまで駆け上がり続ける。
    // 毎秒40発近く重なる前提なので1発は小さく、主音+1オクターブ下の胴の2層。
    // 8個ごとの節目(視覚の flash と同じ拍)にだけ上の煌めきを足す
    sweepTick: function (n) {
      var f = 480 + Math.min(n * 12, 1300);
      beep(f, 0.06, "square", 0.06);
      beep(f * 0.5, 0.1, "sawtooth", 0.045);
      if ((n & 7) === 0) beep(f * 2, 0.16, "triangle", 0.05);
    },
    // 走査の終点(レーンごと): 低音の腹 + 立ちのぼるアルペジオで大花火に音を付ける
    sweepFinish: function () {
      beep(70, 0.5, "sawtooth", 0.2);
      beep(140, 0.28, "square", 0.1);
      [784, 1047, 1319, 1568].forEach(function (f, i) {
        setTimeout(function () { beep(f, 0.18, "square", 0.08); }, i * 45);
      });
    },
    catchItem: function () {
      beep(660, 0.08, "triangle", 0.1);
      setTimeout(function () { beep(990, 0.14, "triangle", 0.1); }, 70);
    },
    // 爆弾の炸裂(低音の轟き+破片。ユーザー追加のSEを重ねて厚みを足す)
    explode: function () {
      beep(80, 0.45, "sawtooth", 0.2);
      beep(140, 0.25, "square", 0.1);
      setTimeout(function () { beep(60, 0.4, "sawtooth", 0.14); }, 60);
      setTimeout(function () { beep(300, 0.18, "square", 0.06); }, 110);
      seBombBoom();
    },
    // ミサイル発射
    missile: seMissile,
    // ミサイルが玉を薙ぎ払った(貫通ヒット)。腹に来る低音+既存のヒット音
    missileHit: function () {
      beep(90, 0.3, "sawtooth", 0.16);
      beep(60, 0.4, "sine", 0.14);
      seHit();
    },
    // カラーボム発動: 上昇スイープで「特別な力」を鳴らし、SEを重ねる
    colorBomb: function () {
      [880, 1175, 1568, 2093].forEach(function (f, i) {
        setTimeout(function () { beep(f, 0.14, "square", 0.09); }, i * 45);
      });
      seColorBomb();
    },
    // 宝玉の粉砕
    crush: seCrush,
    // 生存ゲージが空 → 掃討フェーズ開始の合図(補給が止まる)
    finishPhase: function () {
      [784, 988, 784].forEach(function (f, i) {
        setTimeout(function () { beep(f, 0.18, "square", 0.09); }, i * 110);
      });
    },
    // 宝玉の解放(上昇アルペジオ)
    treasure: function () {
      [660, 880, 1175, 1568].forEach(function (f, i) {
        setTimeout(function () { beep(f, 0.16, "triangle", 0.1); }, i * 90);
      });
    },
    clear: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        setTimeout(function () { beep(f, 0.25, "triangle", 0.1); }, i * 120);
      });
      seStageClear();   // クリアのファンファーレを重ねる
    },
    // ---- 状態異常・骸骨玉・ボス(boss.js / skull.js / powerups.js が呼ぶ) ----
    debuff: seDebuff,             // 状態異常がかかった(被弾・パワーダウン取得)
    krakenDamage: seKrakenDamage, // クラーケンに自弾が命中
    krakenDeath: seKrakenDeath,   // クラーケン撃破(断末魔)
    krakenDeath2: seKrakenDeath2, // クラーケンが海へ沈む最期
    rings: seRings,               // 同心リング攻撃(深淵の錨鎖)の展開
    tsunamiCharge: seTsunamiCharge, // 大津波の溜め(予兆)
    tsunami: seTsunami,           // 大津波の発射
    inkSplat: seInk,              // 墨の着弾(墨獄・パワーダウン🦑)
    darkMagic: seDarkMagic,       // 骸骨玉の弾幕発射(暗黒魔法)
    bossSweep: seBossSweep,       // 運命のルーレット(水色の掃射)の発動
    bossTentacle: seBossTentacle, // 海淵の大触腕(触手突き上げ)の発動
    bossAddle: seBossAddle,       // 惑乱の逆潮(ピンクの同心円リング)の展開
    // ---- 危機(crisis.js が毎フレーム呼ぶ) ----
    crisis: crisis,            // 0〜1 の深さで警報ループの音量/ピッチを決める
    swallowed: swallowed,      // 玉が1個ぶん樽に落ちた
    growl: growl,              // 心拍のたびの地鳴り
    pushedBack: pushedBack,    // 押し戻した
    // ---- ゲームオーバー(gameover.js が段階ごとに呼ぶ) ----
    overCut: overCut,          // 音楽を断ち切って無音へ
    overSuck: seSuck,          // 玉が樽へ吸い込まれていく音
    overSnap: overSnap,        // 樽が呑み込んだ衝撃
    overBgm: overBgm,          // ゲームオーバー BGM
    sting: sting,              // ドクロが飛び込んでくる刺し音
    heartbeat: heartbeat,      // 無音の底で打つ心音
    // 玉が1個ずつ呑まれるときの鈍い音(深いほど低く)
    swallow: function (t) {
      beep(150 - Math.min(t, 1) * 80, 0.12, "sine", 0.09);
    },
    gameStart: gameStart,
    // ---- ポーズ(pause.js が呼ぶ) ----
    pauseAll: pauseAll,        // BGM・警報・合成音を止める
    resumeAll: resumeAll       // 鳴っていた曲だけ再開する
  };
})();
