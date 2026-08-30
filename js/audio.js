/* =========================================================
 * audio.js — 効果音と BGM
 *
 * ・短い電子音は WebAudio(beep)で合成する
 * ・素材のある音(SE/*.mp3)は2方式を自動で使い分ける:
 *     "buffer" … fetch + decodeAudioData で AudioBuffer(生のPCM)に展開し、
 *                鳴らすたびに使い捨ての BufferSource で再生する(http 配信=
 *                本番・スマホ向け)。従来方式は SE の数だけ HTMLAudio を常駐させ、
 *                タッチ端末では全クローンが MediaElementSource として WebAudio に
 *                繋ぎっぱなしになり、無音でもオーディオスレッドが全員ぶんの処理を
 *                続けてしまう。端末が発熱でクロックを落とすとこの常設負荷が
 *                処理の締切を割り、「SE がぷつぷつ途切れる」直接の原因になる。
 *                Buffer 方式なら常駐はデコード済み PCM(ただのメモリ)だけで、
 *                鳴っていない SE の実行コストはゼロになる
 *     "html"   … 従来の HTMLAudio クローン方式。file:// で直接開いた開発環境では
 *                Chrome が同じフォルダの fetch も遮断するため、こちらへ自動で落ちる
 *   (判定は preload() の冒頭で1回だけ。?se=html / ?se=buffer で強制切替できる)
 * ・BGM(BGM/*.mp3)は常に HTMLAudio。全7曲・約34MB を PCM に展開すると
 *   数百MB になってモバイルのメモリを食い潰すため、Buffer 化はしない
 *   (HTMLAudio は再生しながら少しずつデコードするストリーミング方式)
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
  // ミュートと BGM/SE の音量(0〜1)は設定パネル(settings.js)から変更でき、
  // PP.store で保存・復元する(store.js は audio.js より前に読み込まれている)
  var muted = !!(PP.store && PP.store.get("muted", false));
  var bgmVol = clamp01(PP.store ? PP.store.get("bgmVol", 1) : 1);
  var seVol = clamp01(PP.store ? PP.store.get("seVol", 1) : 1);
  var unlocked = false;

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
  }

  // ---------- WebAudio: SE 用のリバーブ・バス ----------
  // BGM 以外の効果音(beep の合成音も mp3 も)は、この seBus を通して
  // destination へ流す。dry(そのまま)に、短いインパルス応答の convolver を
  // 通した wet を薄く足して「軽いリバーブ」を掛ける。
  // BGM は別系統(HTMLAudio を直接 destination で再生)なので dry のまま。
  var seBus = null, activeSE = [];

  function ensureCtx() {
    if (!audioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        // latencyHint: タッチ端末は "balanced"(バッファ1段多め)にする。
        // 既定の "interactive" は遅延最小のかわりに余裕もゼロで、発熱で
        // CPU クロックが落ちるとレンダーが締切を割って音が途切れる。
        // 詳しくは config.js の PP.AUDIO を参照
        try {
          audioCtx = new AC({ latencyHint: PP.TOUCH ? PP.AUDIO.LATENCY_TOUCH : "interactive" });
        } catch (e2) {
          audioCtx = new AC();   // オプション引数に未対応の古いブラウザ
        }
      }
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
      // ConvolverNode は毎サンプル 0.5秒×2ch の畳み込みを行う、モバイル
      // Web Audio で最も CPU を食うノード。レンダースレッドが間に合わないと
      // 音がブツ切れになるため、タッチ端末では残響を掛けず dry のみで鳴らす
      // (wet 0.16 の薄い響きが消えるだけで、音そのものは同一)。
      if (!PP.TOUCH) {
        var conv = audioCtx.createConvolver();
        conv.buffer = makeImpulse(0.5, 2.4);        // 約0.5秒で減衰する短い残響
        var wet = audioCtx.createGain(); wet.gain.value = 0.16;   // 軽め
        seBus.connect(conv); conv.connect(wet); wet.connect(audioCtx.destination);
      }
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
      // 台帳(activeSE)に載せるのは使い捨てクローンだけ。恒久配線の
      // クローンまで載せると外す機会がなく、配列が増える一方になる(リーク)
      if (!persistent) {
        activeSE.push(src);
        el.addEventListener("ended", function () {
          try { src.disconnect(); } catch (e) {}
          var k = activeSE.indexOf(src); if (k >= 0) activeSE.splice(k, 1);
        });
      }
    } catch (e) { /* フォールバック: そのまま destination で鳴る */ }
  }

  // ---------- SE の再生方式("buffer" / "html")の判定 ----------
  // どちらで鳴らすかは preload() の冒頭で一度だけ決める(ファイル先頭の
  // 解説を参照)。判定は「実際に fetch できるか」を試すのが最も確実:
  // file:// 直開きの Chrome は同じフォルダのファイルの fetch も遮断するので、
  // その環境では自動的に従来の HTMLAudio 方式へ落ちる(開発は今までどおり)。
  var seMode = null;        // "buffer" / "html"。null は判定前(音は鳴らさない)
  var seBuffers = {};       // src → デコード済み AudioBuffer("buffer" モード)
  var seVoices = 0;         // 再生中のサンプル SE 総数(全体上限 SE_VOICE_MAX 用)
  var meteorLandAt = 0;     // 隕石の着弾 SE を最後に鳴らした時刻(ms。同時着弾の間引き用)
  var SE_PROBE = "SE/hit_the_ball.mp3";   // 能力判定に使う小さめの実在ファイル

  function decideSeMode(cb) {
    if (seMode) { cb(); return; }
    var forced = null;
    try { forced = new URLSearchParams(location.search).get("se"); } catch (e) {}
    if (forced === "html" || forced === "buffer") { seMode = forced; cb(); return; }
    // fetch が無い/AudioContext が作れない環境は従来方式しか選べない
    if (!window.fetch || !ensureCtx()) { seMode = "html"; cb(); return; }
    fetch(SE_PROBE).then(function (res) {
      seMode = res.ok ? "buffer" : "html";
      cb();
    }).catch(function () { seMode = "html"; cb(); });
  }

  // 合成音の同時発音数。クリア走査(sweepTick)やイントロは毎秒数十発を
  // 重ねる設計で、1発ごとに Oscillator+Gain の2ノードを生成する。上限なしだと
  // 弱い端末で「音の処理のためにゲームがカクつく」逆転が起きるため、
  // PP.AUDIO.SYNTH_MAX で頭打ちにする。超過時は「新しい1発を鳴らさない」:
  // 密集した連打の1個抜けは、鳴っている音を途中で切るより耳につかない
  var synthActive = 0;
  function synthDone() { synthActive = Math.max(0, synthActive - 1); }

  function beep(freq, dur, type, vol) {
    if (muted || seVol <= 0) return;
    if (synthActive >= PP.AUDIO.SYNTH_MAX) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.setValueAtTime(freq, t);
      // WebAudio のゲインは iOS でも効くので、SE 音量はここで乗算する
      gain.gain.setValueAtTime((vol || 0.12) * seVol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(seBus || ctx.destination);
      osc.onended = synthDone;   // 鳴り終わったら同時発音数を返す
      osc.start(t);
      osc.stop(t + dur);
      synthActive++;
    } catch (e) { /* 無音でも続行 */ }
  }

  // beep の兄弟: 周波数が f0 から f1 へ滑らかに動く(ライザー/フォール用)
  function gliss(f0, f1, dur, type, vol) {
    if (muted || seVol <= 0) return;
    if (synthActive >= PP.AUDIO.SYNTH_MAX) return;
    try {
      var ctx = ensureCtx();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || "sawtooth";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(f1, t + dur);
      gain.gain.setValueAtTime((vol || 0.1) * seVol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(seBus || ctx.destination);
      osc.onended = synthDone;
      osc.start(t);
      osc.stop(t + dur);
      synthActive++;
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

  // SE の再生関数を作る。戻り値 f は「呼ぶと1回鳴る」関数で、
  // f.stop()(最後の1発を黙らせる)と f.prime()(html モードの iOS 解錠)を持つ。
  // 呼び出し側(全73箇所)は再生方式を知らなくてよい: f() の中で seMode を見て
  // 振り分ける。seMode が未確定(preload 前)のうちは鳴らさない — 従来も
  // 読み込み完了前は実質無音なので、聴こえ方は変わらない。
  //
  // "buffer" モード: 再生のたびに BufferSource+Gain を作って使い捨てる。
  //   WebAudio ではこれが正道(ノード生成は軽量で、再生済みノードは GC が
  //   まとめて回収する)。常駐する実体が無いので、鳴っていない SE のコストはゼロ。
  //   音量は GainNode に書くため iOS でも効く(HTMLAudio の volume 無視問題も解決)。
  //
  // "html" モード(従来): 複製した実体をプールして鳴らす。再生中の実体は
  //   奪わないので、重なりの聴こえ方は「毎回複製」と同一のまま、Audio 要素と
  //   WebAudio 配線の生成が実同時再生数(通常 2〜4 個)で頭打ちになる。
  function sfx(src, vol) {
    // ---- "buffer" モードの状態: いま鳴っているボイスの台帳 ----
    var voices = [];
    // ---- "html" モードの状態(preloadHtml() が initHtml() で遅延生成) ----
    var proto = null;
    var pool = [];
    var last = null;

    // HTMLAudio の実体化。"buffer" モードでは1個も作らないため、
    // モード確定後(preloadHtml)までこのタイミングを遅らせている
    function initHtml() {
      if (proto) return;
      proto = new Audio(src);
      proto.preload = "auto";
      proto.volume = vol;
      sources.push(proto);
    }

    function dropVoice(v) {
      var k = voices.indexOf(v);
      if (k >= 0) { voices.splice(k, 1); seVoices = Math.max(0, seVoices - 1); }
      try { v.gain.disconnect(); } catch (e) { /* 無視 */ }
    }
    function stopVoice(v) {
      try { v.node.onended = null; v.node.stop(); } catch (e) { /* 停止済みなら無視 */ }
      dropVoice(v);
    }
    function playBuffer() {
      var buf = seBuffers[src];
      if (!buf || !audioCtx) return;   // デコード失敗した SE は無音のまま続行
      // 同一SEの重なり上限: 超過したら最古を止めて枠を空ける(新しい音を優先。
      // 同じ音の4枚重ねと5枚重ねは聴き分けられないが、頭の立ち上がりは目立つ)
      while (voices.length >= PP.AUDIO.SE_PER_MAX) stopVoice(voices[0]);
      // 全体上限: ここまで鳴っていれば1発足しても聴感は変わらないので鳴らさない
      if (seVoices >= PP.AUDIO.SE_VOICE_MAX) return;
      try {
        var node = audioCtx.createBufferSource();
        node.buffer = buf;
        var g = audioCtx.createGain();
        g.gain.value = vol * seVol;
        node.connect(g);
        g.connect(seBus || audioCtx.destination);
        var v = { node: node, gain: g };
        node.onended = function () { dropVoice(v); };
        voices.push(v);
        seVoices++;
        node.start();
      } catch (e) { /* 無音でも続行 */ }
    }
    function playHtml() {
      try {
        initHtml();   // 念のため(通常は preloadHtml が実体化済み)
        var a = null;
        for (var i = 0; i < pool.length; i++) {
          if (pool[i].ended || pool[i].paused) { a = pool[i]; break; }
        }
        if (a) {
          a.currentTime = 0;        // 使い回し: 頭出しして鳴らし直す
        } else {
          a = proto.cloneNode();    // 全部再生中: 従来どおり複製を増やす
          routeSE(a, true);         // BGM 以外の SE は軽いリバーブを通す(配線は恒久)
          pool.push(a);
        }
        a.volume = vol * seVol;     // SE 音量は再生のたびに反映(iOS では無視されるが無害)
        last = a;
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* 未解錠なら鳴らさない */ });
      } catch (e) { /* 無音でも続行 */ }
    }

    var f = function () {
      if (muted || seVol <= 0) return;
      if (seMode === "buffer") playBuffer();
      else if (seMode === "html") playHtml();
    };
    // 長い音(ゲームオーバーの吸い込み・ボス警報)はリスタート時に止めたいので、
    // 最後に鳴らした1発を黙らせられるようにする
    f.stop = function () {
      if (seMode === "buffer") {
        if (voices.length) stopVoice(voices[voices.length - 1]);
        return;
      }
      if (!last) return;
      try { last.pause(); last.currentTime = 0; } catch (e) { /* 無視 */ }
      last = null;
    };
    // 携帯対応("html" モードのみ): 最初のタップの中で解錠済みのクローンを
    // 1つ用意しておく。iOS では解錠済みの実体しか tick からの再生ができない。
    // "buffer" モードでは不要 — AudioContext さえ resume すれば BufferSource は
    // どこからでも(tick やタイマーからでも)鳴らせる
    f.prime = function () {
      if (seMode !== "html") return;
      initHtml();
      if (pool.length) return;
      var a = proto.cloneNode();
      a.volume = vol;
      routeSE(a, true);
      pool.push(a);
      bless(a);
    };
    f.src = src;             // preloadBuffers がデコード対象を集めるのに使う
    f.initHtml = initHtml;   // preloadHtml が全SEの実体化に使う
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
  // 追加SE: 大砲の発射(通常弾・爆弾)/ 手持ち玉の交換(手動操作のみ)/
  //          特殊弾💣🚀の装填(アイテムキャッチ・強化の自動装填)
  var seFire = sfx("SE/Fire.mp3", 0.45);
  var seSwap = sfx("SE/swap.mp3", 0.5);
  var seSpecialLoad = sfx("SE/special_bomb_missile_reload.mp3", 0.6);
  // 追加SE: ボスの攻撃(時凪の呪縛=上から落ちる大弾カーテン /
  //          両舷斉射=振り子掃引で降り注ぐ弾の幕)
  var seBossBallSlow = sfx("SE/boss_ball_slow_attack.mp3", 0.7);
  var seBossWaveAttack = sfx("SE/boss_wave_attack.mp3", 0.8);
  // 妖星の豪雨(隕石): 降り始め(2 レイヤーを同時に重ねる)と着弾
  var seMeteorRain = sfx("SE/meteo_raining.mp3", 0.65);
  var seMeteorRain2 = sfx("SE/meteo_raining2.mp3", 0.65);
  var seMeteorLand = sfx("SE/meteo_land.mp3", 0.75);
  // 裁きの雷霆: 落雷 1 本ごとの雷鳴(0.28 秒おきに連続するので間引きは呼び出し側)
  var seThunder = sfx("SE/Thunder.mp3", 0.8);
  var thunderAt = 0;        // 雷鳴 SE を最後に鳴らした時刻(ms。連続落雷の間引き用)
  // カラーボム発動: 選ばれた色が盤面から一掃されるときの炸裂音
  // ================================================================
  // TODO【課題4】カラーボムで再生するSEファイルを指定してみよう
  // 書き方: sfx("SE/ファイル名.mp3", 音量)。音量は 0(無音)〜 1(最大)。
  //  ・自分の mp3 を SE/ フォルダに入れて、下のファイル名を差し替えると
  //    カラーボムの発動音が変わる(例: sfx("SE/自分の音.mp3", 0.8))
  // ================================================================
  var seColorBomb = sfx("SE/broken_treasure.mp3", 0.8);
  // 追加SE: ボスの⚠警告マーカー群の出現(1グループにつき1回)。
  // 警報なので単一インスタンス運用: 新しい⚠で鳴らし直し、触手が出たら止める
  var seBossDanger = sfx("SE/Boss_denger.mp3", 0.7);

  // ---------- 危機のループ音 ----------
  // 樽に呑まれかけている間ずっと鳴らし続ける。深さ(0〜1)で音量とピッチが
  // 上がり、逃げ場がなくなる感じを作る。BGM とは別系統なので、
  // 危険曲の上に警報として重なる。
  var CRISIS_SRC = "SE/crisis.mp3";
  // TODO【課題4】危機警報の音量レンジ(min=危機の入り口 / max=樽に呑まれる寸前)
  var CRISIS_VOL = { min: 0.3, max: 0.85 };

  // "html" モードの警報ループ(遅延生成: "buffer" モードでは1個も作らない)
  var loopCrisis = null;
  function initLoopCrisis() {
    if (loopCrisis) return;
    loopCrisis = new Audio(CRISIS_SRC);
    loopCrisis.loop = true;
    loopCrisis.preload = "auto";
    loopCrisis.volume = 0;
    sources.push(loopCrisis);
  }

  // 前回 crisis() に渡された深さ。volume / playbackRate の代入は(値が同じでも)
  // ブラウザのメディアパイプラインに触れるため、60Hz で毎フレーム書き込むと
  // 端末によっては音揺れやメインスレッドの引っかかりになる。聞き分けられる
  // 変化(0.005)があったときだけ書き込む
  var crisisLastX = -1;

  // "buffer" モードの警報: loop=true の BufferSource を1本だけ常駐させ、
  // 深さは Gain と playbackRate に書くだけ。止めるときは stop() して捨て、
  // 次の危機で作り直す(BufferSource は使い捨てが WebAudio の流儀)
  var crisisNode = null, crisisGain = null;
  function crisisBuffer(x) {
    if (x < 0.01 || muted || seVol <= 0 || !unlocked) {
      if (crisisNode) {
        try { crisisNode.stop(); } catch (e) { /* 停止済みなら無視 */ }
        crisisNode = null;
      }
      crisisLastX = -1;   // 次に鳴らすときは必ず音量から設定し直す
      return;
    }
    if (!crisisNode) {
      var buf = seBuffers[CRISIS_SRC];
      if (!buf || !audioCtx) return;
      try {
        crisisNode = audioCtx.createBufferSource();
        crisisNode.buffer = buf;
        crisisNode.loop = true;
        if (!crisisGain) {
          crisisGain = audioCtx.createGain();
          crisisGain.connect(seBus || audioCtx.destination);
        }
        crisisGain.gain.value = 0;   // 音量は下の共通処理で書く
        crisisNode.connect(crisisGain);
        crisisNode.start();
        crisisLastX = -1;
      } catch (e) { crisisNode = null; return; }
    }
    if (Math.abs(x - crisisLastX) >= 0.005) {
      crisisLastX = x;
      crisisGain.gain.value = (CRISIS_VOL.min + (CRISIS_VOL.max - CRISIS_VOL.min) * x) * seVol;
      crisisNode.playbackRate.value = 1 + 0.2 * x;  // 深いほど気ぜわしく
    }
  }

  // "html" モードの警報(従来実装)
  function crisisHtml(x) {
    if (!loopCrisis) {
      if (x < 0.01) return;   // 鳴らすものが無ければ黙らせるものも無い
      initLoopCrisis();
    }
    if (x < 0.01 || muted || seVol <= 0 || !unlocked) {
      if (!loopCrisis.paused) { loopCrisis.pause(); loopCrisis.currentTime = 0; }
      loopCrisis.volume = 0;
      crisisLastX = -1;
      return;
    }
    if (Math.abs(x - crisisLastX) >= 0.005) {
      crisisLastX = x;
      loopCrisis.volume = (CRISIS_VOL.min + (CRISIS_VOL.max - CRISIS_VOL.min) * x) * seVol;
      loopCrisis.playbackRate = 1 + 0.2 * x;
    }
    routeSE(loopCrisis);                        // 警報にも軽いリバーブ(一度だけ配線)
    if (loopCrisis.paused) play(loopCrisis);
  }

  function crisis(x) {
    x = Math.max(0, Math.min(1, x || 0));
    if (seMode === "buffer") crisisBuffer(x);
    else if (seMode === "html") crisisHtml(x);
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
    // 携帯対応: BGM は全7曲で計 30MB 超あり、"auto" だとページを開いただけで
    // 全曲のダウンロードとデコードが走って帯域・メモリ・電池を食う。
    // タッチ端末は "none" にして、実際に鳴らすとき(play() がロードを
    // 兼ねる)まで読み込まない。PC は従来どおり先読みして頭出しを速くする
    a.preload = PP.TOUCH ? "none" : "auto";
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
  // 既定曲は PC なら起動時に読み込み済み(タッチ端末は鳴らすときに読み込む)。
  // 学生が追加した曲は最初に鳴らすときに読み込む
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

  // 頭出し。preload="none" の未ロード曲(readyState 0)に currentTime を
  // 代入すると iOS Safari が例外を投げることがあるためガードする
  // (未ロードなら再生はどのみち先頭から始まるので頭出し不要)
  function rewind(a) {
    if (a.readyState > 0) { try { a.currentTime = 0; } catch (e) { /* 無視 */ } }
  }

  // current へクロスフェード(他の曲は 0 まで下げて停止)
  function fade(ms) {
    fadeMs = ms || 500;
    // 携帯対応: iOS など volume の変更が効かない端末ではクロスフェードが
    // 成立しない(全曲が最大音量のまま重なる)ので、即時切り替えで代用する
    if (!canVolume) {
      tracks.forEach(function (a) {
        // BGM 音量 0 は「BGM オフ」として扱う(iOS では 0〜1 の中間が作れない)
        if (!muted && bgmVol > 0 && a === current) { if (a.paused) play(a); }
        else if (!a.paused) a.pause();
      });
      return;
    }
    if (fadeTimer) return;
    fadeTimer = setInterval(function () {
      var done = true;
      var steps = Math.max(1, fadeMs / 33);
      tracks.forEach(function (a) {
        var target = (!muted && a === current) ? a.vol * bgmVol : 0;
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
    pausedCrisisLoop = !!(loopCrisis && !loopCrisis.paused);
    if (pausedCrisisLoop) loopCrisis.pause();
    // "buffer" モードの SE・警報ループはすべて WebAudio 上にあるので、
    // AudioContext の suspend 1発でまとめて止まる(復帰は resume)
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

  // 効果音の読み込みを待つ。まず再生方式を判定し(decideSeMode)、
  //   "buffer" … 全 SE を fetch + decodeAudioData で AudioBuffer に展開する
  //   "html"   … ここで初めて HTMLAudio を生成し、canplaythrough を待つ(従来)
  // onProgress(読込済, 総数) を随時呼び、全部揃うか TIMEOUT を過ぎたら
  // done() を呼ぶ(音が無くても遊べるように)。
  // BGM(tracks)は待たない: 数MB の曲を全部ダウンロードし終えるまでタイトルを
  // 出さないのは起動が遅すぎる(特に携帯回線)。preload="auto" のままなので
  // ブラウザは裏で取得を続け、再生できる分から鳴り始める。最悪でも「開始直後の
  // 数秒だけ BGM が遅れる」だけで、効果音と危機警報は最初から保証される
  function preload(onProgress, done) {
    var TIMEOUT = 15000;
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      done();
    }
    setTimeout(finish, TIMEOUT);
    decideSeMode(function () {
      if (seMode === "buffer") preloadBuffers(onProgress, finish);
      else preloadHtml(onProgress, finish);
    });
  }

  // "buffer" モード: SE 33ファイル(計約2.6MB)+危機警報をデコードする。
  // 展開後の PCM は数十MB になるが、HTMLAudio 実体 75個+常時配線を
  // 持ち続けるより遥かに安い(メモリは食うが CPU は一切食わない)
  function preloadBuffers(onProgress, finish) {
    var ctx = ensureCtx();
    if (!ctx) { seMode = "html"; preloadHtml(onProgress, finish); return; }
    // デコード対象: 登録された全SE + 危機警報。同じファイルを使い回す SE が
    // あるので src で重複を除く(デコード結果は seBuffers を全員で共有する)
    var srcs = [CRISIS_SRC];
    for (var i = 0; i < sfxAll.length; i++) {
      if (srcs.indexOf(sfxAll[i].src) < 0) srcs.push(sfxAll[i].src);
    }
    var total = srcs.length;
    var loaded = 0;
    function one() {
      loaded++;
      if (onProgress) onProgress(loaded, total);
      if (loaded >= total) finish();
    }
    srcs.forEach(function (src) {
      fetch(src).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      }).then(function (ab) {
        // コールバック形式で呼ぶ: 旧 iOS Safari は Promise 形式に未対応
        ctx.decodeAudioData(ab, function (buf) {
          seBuffers[src] = buf;
          one();
        }, function () { one(); /* 壊れたファイルはその音だけ無音で続行 */ });
      }).catch(function () { one(); /* 読めなくても起動は止めない */ });
    });
  }

  // "html" モード(従来): ここで初めて HTMLAudio の実体を作る。
  // "buffer" モードでは1個も作らないため、生成をこのタイミングまで遅らせている
  function preloadHtml(onProgress, finish) {
    for (var i = 0; i < sfxAll.length; i++) sfxAll[i].initHtml();
    initLoopCrisis();
    var seOnly = [];
    for (var si = 0; si < sources.length; si++) {
      if (tracks.indexOf(sources[si]) < 0) seOnly.push(sources[si]);
    }
    var total = seOnly.length;
    var loaded = 0;
    function one() {
      loaded++;
      if (onProgress) onProgress(loaded, total);
      if (loaded >= total) finish();
    }
    seOnly.forEach(function (a) {
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
  }

  // 最初のユーザー操作で呼ぶ。ブラウザの自動再生制限を解除するだけで、
  // ここでは BGM を鳴らさない(タイトル画面でのクリック/キー入力だけで
  // 曲が鳴り出さないように)。実際の再生はゲーム開始時の gameStart() が行う。
  var primeIdx = 0;   // 携帯対応: 何番目の効果音まで解錠したか("html" モード)
  var blessed = [];   // 携帯対応: tracks[i] を解錠済みか(タップごとに 1 本ずつ)
  function unlock() {
    if (!unlocked) {
      unlocked = true;
      ensureCtx();     // WebAudio(効果音)の解錠。BGM はここでは鳴らさない
      // 旧 iOS 向けのおまじない: ユーザー操作の中で「無音の1サンプル」を
      // 実際に再生し、WebAudio の出力経路を確実に開通させる。resume() だけでは
      // 一度も再生していない AudioContext が無音のままになる端末があった
      try {
        if (audioCtx) {
          var z = audioCtx.createBufferSource();
          z.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
          z.connect(audioCtx.destination);
          z.start(0);
        }
      } catch (e) { /* 無視 */ }
      // 携帯対応 その1: volume の変更が効く端末か調べる(iOS は無視される)
      try {
        var probe = new Audio();
        probe.volume = 0.5;
        canVolume = Math.abs(probe.volume - 0.5) < 0.01;
      } catch (e) { /* 判定できなければ従来どおり */ }
      // 携帯対応 その2: 最初のタップのうちに BGM と危機警報を消音で解錠する。
      // これをしないと iOS では、tick から切り替わる危機BGM・ゲームオーバー
      // BGM が鳴らない。PC はページ単位の許可なので不要(=従来と同じ動作)。
      // 警報ループは "html" モードのときだけ実体がある(buffer は解錠不要)
      // 【Stage 5】以前は全 BGM(4 曲・計 23MB)を一度に bless していた。
      // preload="none" の要素に play() するとロードが始まるので、ゲーム開始の
      // 最初のタップで 4 本同時のダウンロード+デマルチプレクスが走り、
      // レベル開始の重い瞬間と真正面からぶつかっていた。いま鳴らす通常曲と
      // 警報ループだけここで解錠し、残り(危機・ボス・ゲームオーバー)は
      // 下の「タップごとに 1 本」で順に解錠する(unlock は操作のたびに呼ばれる)
      if (PP.TOUCH) {
        bless(bgmNormal); blessed[0] = true;
        if (loopCrisis) bless(loopCrisis);
      }
    }
    if (PP.TOUCH) {
      for (var bi = 0; bi < tracks.length; bi++) {
        if (blessed[bi]) continue;
        blessed[bi] = true;
        bless(tracks[bi]);
        break;   // 1 タップにつき 1 本
      }
    }
    // 携帯対応 その3("html" モードのみ): 効果音のクローンは「タップのたびに
    // 少しずつ」解錠する。1回に全部やると BGM の出だしと読み込みを取り合って
    // 曲が遅れて聴こえる。unlock() は操作のたびに呼ばれるので数タップで終わる。
    // "buffer" モードでは不要 — AudioContext さえ開通すれば BufferSource は
    // tick やタイマーからでも自由に鳴らせる(prime も no-op になっている)
    if (PP.TOUCH && seMode === "html") {
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
    rewind(want);
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
    rewind(bgmOver);
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
    rewind(bgmNormal);
    bgmNormal.volume = muted ? 0 : bgmNormal.vol * bgmVol;
    // BGM オフ(音量0)なら鳴らし始めない(iOS は volume 代入が効かないため必須)
    if (!muted && bgmVol > 0) play(bgmNormal);
    fade(300);
    // 遅延ロード(preload="none")の穴埋め: 危機曲だけは先読みしておく。
    // 初回の危機は突然来るので、そこからロードすると数秒無音になってしまう
    // (ボス戦は setDanger が曲を替えないので不要)
    if (!(PP.game && PP.game.bossMode) && bgmDanger.preload === "none" &&
        bgmDanger.readyState === 0) {
      try { bgmDanger.preload = "auto"; bgmDanger.load(); } catch (e) { /* 無視 */ }
    }
  }

  function setMuted(on) {
    muted = on;
    if (PP.store) PP.store.set("muted", muted);
    if (unlocked) fade();
    return muted;
  }

  // ---------- 音量チャンネル(settings.js の設定パネルが呼ぶ) ----------
  // BGM と SE を別々の 0〜1 で調整し、PP.store で保存する。
  // iOS など HTMLAudio の volume が効かない端末(canVolume=false)では
  // 中間音量が作れないため、設定パネル側は volumeSupported() を見て
  // スライダーの代わりに ON/OFF トグル(0 か 1)を出す。
  function setBgmVol(v) {
    bgmVol = clamp01(v);
    if (PP.store) PP.store.set("bgmVol", bgmVol);
    if (unlocked) fade(150);   // いま流れている曲へ即反映
  }
  function setSeVol(v) {
    seVol = clamp01(v);
    if (PP.store) PP.store.set("seVol", seVol);
    crisisLastX = -1;          // 危機警報の音量も次の更新で必ず書き直す
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
    setBgmVol: setBgmVol,
    setSeVol: setSeVol,
    getBgmVol: function () { return bgmVol; },
    getSeVol: function () { return seVol; },
    // 端末が音量スライダーに対応しているか(iOS は false)。
    // canVolume は unlock() 内で実端末を調べて確定する。設定パネルは
    // 必ずユーザー操作(=unlock 済み)から開くので、開く時点の値は正確
    volumeSupported: function () { return canVolume; },

    // 大砲の発射(通常弾・爆弾)。合成音の芯に Fire.mp3 を重ねる。
    // ミサイルだけは cannon.js 側で missile.mp3 を鳴らす(二重鳴り回避)
    fire: function () { beep(220, 0.1, "square", 0.06); seFire(); },
    // 発射玉がチェーンに刺さった
    hit: seHit,
    // 宝を持たない分断チェーンが停止した
    chainStop: seStop,
    // 新しい波が洞窟から湧いた
    newWave: seNewChain,
    pop: function (n) { beep(500 + Math.min(n, 8) * 40, 0.18); },
    // ボスの⚠警告マーカー群の出現(boss.js が1グループにつき1回呼ぶ)。
    // 警報は1本だけ: 前の鳴り残しを止めてから鳴らす(⚠3回=3回鳴るが重ならない)
    bossDanger: function () { seBossDanger.stop(); seBossDanger(); },
    // 触手が実際に出た瞬間・攻撃キャンセル時に警報を断ち切る(boss.js が呼ぶ)
    bossDangerStop: function () { seBossDanger.stop(); },
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
    // 手持ち玉の交換(手動操作: 交換キー・特殊弾トグル)
    swap: function () { beep(440, 0.08, "sine", 0.06); seSwap(); },
    // 盤面から消えた色の自動引き直し(cannon.js syncColors)。
    // プレイヤーの操作ではないので mp3 は鳴らさず従来の合成音のみ
    swapAuto: function () { beep(440, 0.08, "sine", 0.06); },
    // 特殊弾💣🚀の装填(アイテムキャッチ時 / 強化「自動装填」の着荷時)
    specialLoad: function () { beep(180, 0.2, "square", 0.1); seSpecialLoad(); },
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
    // ---- コース開始イントロの音 ----
    // クリア走査(最後)は上昇ライザーなので、イントロ(最初)は下降が基本形。
    // 複数レーンでは「下降→上昇→下降…」とレーンごとに交互(up は main.js が渡す)。
    // 主層+5度ハモリ+胴+先行する煌めき+腹に響く号砲の5層で鳴らす
    introRiser: function (dur, up) {
      dur = Math.max(0.6, dur || 2.5);
      var m1 = up ? 140 : 1600, m2 = up ? 1600 : 140;   // 主層
      var b1 = up ? 70 : 800,   b2 = up ? 800 : 70;     // 下支えの胴
      var s1 = up ? 500 : 2400, s2 = up ? 2400 : 500;   // 先行する煌めき
      gliss(m1, m2, dur, "sawtooth", 0.09);
      gliss(m1 * 1.5, m2 * 1.5, dur, "sawtooth", 0.045); // 5度上のハモリ(厚み)
      gliss(b1, b2, dur, "sine", 0.12);
      gliss(s1, s2, dur * 0.55, "triangle", 0.06);
      beep(55, 0.6, "sine", 0.24);                       // レーン発進の号砲
    },
    // レーン発進のきらめき(i = レーン番号。後発ほど少し低く)
    introLaunch: function (i) {
      beep(Math.max(300, 900 - i * 140), 0.14, "triangle", 0.1);
      beep(Math.max(150, 450 - i * 70), 0.22, "sine", 0.08);
    },
    // 彗星のチクタク(n = 通過数)。ライザーと同じ向きに駆け下り/駆け上がる。
    // 8個ごとの節目(視覚のリングと同じ拍)には上の煌めきを重ねる
    introTick: function (n, up) {
      var f = up ? Math.min(1300, 260 + n * 18) : Math.max(220, 1150 - n * 18);
      beep(f, 0.07, "square", 0.07);
      beep(f * 0.5, 0.11, "sawtooth", 0.055);
      if ((n & 7) === 0) beep(f * 2, 0.14, "triangle", 0.05);
    },
    // 全レーン到達=戦闘開始の着水ドン(newWave と同時に鳴らす)
    introGo: function () {
      beep(75, 0.5, "sine", 0.22);
      beep(150, 0.25, "sawtooth", 0.1);
      setTimeout(function () { beep(50, 0.6, "sine", 0.18); }, 80);
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
    bossBallSlow: seBossBallSlow, // 時凪の呪縛(大弾カーテン)の発動
    bossWaveAttack: seBossWaveAttack, // 両舷斉射(振り子掃引)の発動
    // ボスの咆哮(重攻撃の予兆・怒りフェーズ突入)。落ちるグリス+腹の底の持続音
    bossRoar: function () {
      gliss(110, 45, 0.7, "sawtooth", 0.2);
      beep(55, 0.9, "sine", 0.18);
      beep(38, 1.1, "sine", 0.14);
      setTimeout(function () { gliss(90, 40, 0.5, "sawtooth", 0.1); }, 120);
    },
    // 隕石の降り始め(攻撃の発動時に1回)。meteo_raining と meteo_raining2 は
    // 重ねて鳴らす前提で作られた 2 レイヤーなので、同時に両方鳴らす
    meteorStart: function () {
      seMeteorRain();
      seMeteorRain2();
    },
    // 隕石の落下ホイッスル(ボレーごとに1回)。素材の雨音の上に薄く重ねる
    meteorFall: function () {
      gliss(900, 200, 0.8, "sine", 0.05);
      gliss(1200, 300, 0.7, "triangle", 0.03);
    },
    // 隕石の着弾爆発: 素材(meteo_land)+超低音の腹。1ボレー 7〜8 個がほぼ同時に
    // 落ちるので、素材は 0.12 秒に1回まで間引く(合成の低音は毎回鳴らして
    // 「何個落ちたか」の手応えは残す)
    meteorBoom: function () {
      var now = Date.now();
      if (now - meteorLandAt >= 120) { meteorLandAt = now; seMeteorLand(); }
      beep(55, 0.35, "sawtooth", 0.18);
      beep(40, 0.55, "sine", 0.14);
      beep(30, 0.7, "sine", 0.1);
    },
    // 裁きの雷霆の落雷: 素材(Thunder.mp3)+合成の高い炸裂音。落雷は 0.24〜0.28 秒
    // おきに連続するので、素材は 0.15 秒に1回まで間引く(炸裂音は毎回)
    thunder: function () {
      var now = Date.now();
      if (now - thunderAt >= 150) { thunderAt = now; seThunder(); }
      beep(2400, 0.06, "square", 0.08);
    },
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
    // 血しぶきが画面に貼り付く音(湿った低いスラップ)
    bloodSplat: function () {
      gliss(220, 60, 0.12, "sawtooth", 0.12);
      beep(90, 0.1, "square", 0.06);
      setTimeout(function () { beep(50, 0.18, "sine", 0.1); }, 30);
    },
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
