/* =========================================================
 * settings.js — 消音ボタン・設定パネル・操作説明
 *
 * ・右上の 🔊 ボタン: どの画面/端末でもワンタップで消音(M キーと双方向同期)。
 *   以前は M キーだけだったので、タッチ端末では消音の手段が無かった。
 * ・右上の ⚙ ボタン: 設定パネル(BGM/SE 音量・画質・言語・操作説明)。
 *   プレイ中に開くと自動でポーズし、閉じると通常のポーズ画面に戻る
 *   (再開はいつものクリック/タップ。input.js のクリック配線は一切触らない)。
 * ・操作説明: タッチ端末の初回起動時に自動表示する(横持ちではページ下の
 *   説明文が隠れるため、これが唯一の操作ガイドになる)。既読は PP.store に
 *   保存し、以後は ⚙ → ❔ でいつでも読み返せる。
 *
 * パネルは DOM で作る(キャンバス描画ではなく)。理由:
 *   - <input type="range"> のスライダーが指でもマウスでもそのまま効く
 *   - 背面の暗幕(#setBack)がクリックを吸うので、キャンバスの
 *     「クリックで再開/発射」と構造的に衝突しない
 *   - キャンバス側に新しい Text を足さない = HUD の描画キャッシュ運用に
 *     影響ゼロ(モバイルの FPS を落とさない)
 * 文言はすべて i18n 辞書から引き、開くたびに組み立て直す(言語切り替えの
 * 貼り替え漏れが起きない)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  var muteBtn = document.getElementById("muteBtn");
  var setBtn = document.getElementById("setBtn");
  var back = document.getElementById("setBack");
  var panel = document.getElementById("setPanel");
  var howto = document.getElementById("howtoPanel");
  if (!muteBtn || !setBtn || !back || !panel || !howto) return;

  // ---------- 消音ボタン(🔊/🔇) ----------
  function syncMute() {
    var m = PP.audio.isMuted();
    muteBtn.textContent = m ? "🔇" : "🔊";
    muteBtn.classList.toggle("muted", m);
  }
  muteBtn.addEventListener("click", function () {
    PP.audio.unlock();
    PP.audio.toggleMute();
    syncMute();
  });

  // ---------- 設定パネル ----------
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 状態を見て中身を組み立てる。プレイ中は言語だけ変更不可にする:
  // ビルド済み(cache 済み)のキャンバス文字列は途中で貼り替えられないため、
  // 既存の 🌐 ボタンと同じく タイトル/全制覇 画面に限定する(hud.js 参照)
  function buildSettings() {
    var t = PP.i18n.t;
    var st = PP.game ? PP.game.state : "loading";
    var canLang = st === "title" || st === "gameclear";
    var canVol = PP.audio.volumeSupported();
    var q = (PP.PERF && PP.PERF.userQuality) || "auto";
    var h = '<div class="panel-title">' + esc(t("set.title")) + "</div>";

    if (canVol) {
      h += '<div class="set-row"><span class="set-label">' + esc(t("set.bgm")) + "</span>" +
        '<input type="range" class="set-range" id="setBgmRange" min="0" max="100" step="5" value="' +
        Math.round(PP.audio.getBgmVol() * 100) + '"></div>';
      h += '<div class="set-row"><span class="set-label">' + esc(t("set.se")) + "</span>" +
        '<input type="range" class="set-range" id="setSeRange" min="0" max="100" step="5" value="' +
        Math.round(PP.audio.getSeVol() * 100) + '"></div>';
    } else {
      // iOS などは HTMLAudio の音量が変えられない(0 か 1 のみ)。
      // 中間が作れないスライダーを見せるより、正直に ON/OFF で出す
      h += segRow(t("set.bgm"), "setBgmSeg", [
        { v: "1", label: t("set.on"), on: PP.audio.getBgmVol() > 0 },
        { v: "0", label: t("set.off"), on: PP.audio.getBgmVol() <= 0 }
      ]);
      h += segRow(t("set.se"), "setSeSeg", [
        { v: "1", label: t("set.on"), on: PP.audio.getSeVol() > 0 },
        { v: "0", label: t("set.off"), on: PP.audio.getSeVol() <= 0 }
      ]);
    }

    h += segRow(t("set.quality"), "setQualitySeg", [
      { v: "auto", label: t("set.qAuto"), on: q === "auto" },
      { v: "high", label: t("set.qHigh"), on: q === "high" },
      { v: "low", label: t("set.qLow"), on: q === "low" }
    ]);

    h += segRow(t("set.lang"), "setLangSeg", [
      { v: "ja", label: "日本語", on: PP.i18n.lang === "ja", dis: !canLang },
      { v: "en", label: "English", on: PP.i18n.lang === "en", dis: !canLang }
    ]);
    if (!canLang) h += '<div class="set-note">' + esc(t("set.langLocked")) + "</div>";

    h += '<div class="set-actions">' +
      '<button type="button" class="panel-btn" id="setHowtoBtn">' + esc(t("set.howto")) + "</button>" +
      '<button type="button" class="panel-btn" id="setCloseBtn">' + esc(t("set.close")) + "</button>" +
      "</div>";
    panel.innerHTML = h;
    wireSettings();
  }

  function segRow(label, id, opts) {
    var h = '<div class="set-row"><span class="set-label">' + esc(label) +
      '</span><span class="set-seg" id="' + id + '">';
    opts.forEach(function (o) {
      h += '<button type="button" class="seg-btn' + (o.on ? " active" : "") +
        '" data-v="' + o.v + '"' + (o.dis ? " disabled" : "") + ">" + esc(o.label) + "</button>";
    });
    return h + "</span></div>";
  }

  // セグメントボタン共通: 押されたら active を貼り替えて apply(値) を呼ぶ
  function bindSeg(id, apply) {
    var seg = document.getElementById(id);
    if (!seg) return;
    seg.addEventListener("click", function (e) {
      var b = e.target.closest(".seg-btn");
      if (!b || b.disabled) return;
      var btns = seg.querySelectorAll(".seg-btn");
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove("active");
      b.classList.add("active");
      apply(b.getAttribute("data-v"));
    });
  }

  function wireSettings() {
    var bgmRange = document.getElementById("setBgmRange");
    var seRange = document.getElementById("setSeRange");
    if (bgmRange) {
      bgmRange.addEventListener("input", function () {
        PP.audio.setBgmVol(bgmRange.value / 100);
      });
    }
    if (seRange) {
      seRange.addEventListener("input", function () {
        PP.audio.setSeVol(seRange.value / 100);
      });
      // 指を離した瞬間に短い音を鳴らして「この大きさになった」を耳で確認できるように
      seRange.addEventListener("change", function () {
        PP.audio.beep(660, 0.12, "triangle", 0.18);
      });
    }
    bindSeg("setBgmSeg", function (v) { PP.audio.setBgmVol(v === "1" ? 1 : 0); });
    bindSeg("setSeSeg", function (v) { PP.audio.setSeVol(v === "1" ? 1 : 0); });
    bindSeg("setQualitySeg", function (v) {
      PP.PERF.userQuality = v;
      PP.store.set("quality", v);
      if (v === "high") PP.quality = 1;
      else if (v === "low") PP.quality = 0;
      // "auto" は実測 FPS に任せる(main.js updateQuality が引き継ぐ)
    });
    bindSeg("setLangSeg", function (v) {
      PP.i18n.set(v);
      buildSettings();   // パネル自身の文言も新しい言語で組み立て直す
    });
    document.getElementById("setHowtoBtn").addEventListener("click", openHowto);
    document.getElementById("setCloseBtn").addEventListener("click", closeAll);
  }

  // ---------- 操作説明(チュートリアル) ----------
  function buildHowto() {
    var t = PP.i18n.t;
    var h = '<div class="panel-title">' + esc(t("tut.title")) + "</div>";
    function row(ic, cls, txt) {
      return '<div class="howto-row"><span class="howto-ic' + (cls ? " " + cls : "") + '">' +
        ic + '</span><span class="howto-txt">' + esc(txt) + "</span></div>";
    }
    if (PP.TOUCH) {
      // 実物の仮想ボタン(.tbtn)と同じ見た目のアイコンで「どれが何か」を示す
      h += row("👆", "", t("tut.aim"));
      h += row("◀ ▶", "", t("tut.move"));
      h += row("FIRE", "fire", t("tut.fire"));
      h += row("⇄", "", t("tut.swap"));
      h += row("🌈", "", t("tut.wild"));
      h += row("⏸", "", t("tut.pause"));
    } else {
      h += row("🖱", "", t("tut.dAim"));
      h += row("⇄", "", t("tut.dSwap"));
      h += row("🌈", "", t("tut.dWild"));
      h += row("💣", "", t("tut.dStock"));
      h += row("⌨", "", t("tut.dPause"));
    }
    h += '<button type="button" class="panel-btn howto-ok" id="howtoOkBtn">' +
      esc(t("tut.ok")) + "</button>";
    howto.innerHTML = h;
    document.getElementById("howtoOkBtn").addEventListener("click", closeHowto);
  }

  // ---------- 開閉 ----------
  function openSettings() {
    PP.audio.unlock();   // DOM クリックも有効なユーザー操作 = iOS の音量判定もここで確定する
    // プレイ中(時間が進む画面)なら自動でポーズ。タイトル等では pause() が
    // 安全に断ってくれる(pause.js の PAUSABLE 判定)ので、状態を選ばず呼べる
    if (PP.pauseCtl && !PP.pauseCtl.active) PP.pauseCtl.pause("manual");
    buildSettings();
    back.hidden = false;
    panel.hidden = false;
  }
  function openHowto() {
    buildHowto();
    back.hidden = false;
    howto.hidden = false;
  }
  function closeHowto() {
    howto.hidden = true;
    if (PP.store) PP.store.set("tutorialSeen", true);
    // 設定パネルの下から開いた場合はパネルが残る。単独表示(初回)なら暗幕も畳む
    if (panel.hidden) back.hidden = true;
  }
  function closeAll() {
    panel.hidden = true;
    howto.hidden = true;
    back.hidden = true;
    // ポーズは解かない: 下に通常のポーズ画面が見えていて、
    // いつもの「クリック/タップで再開」がそのまま効く
  }
  // 暗幕クリック = いちばん上のパネルを閉じる
  back.addEventListener("click", function () {
    if (!howto.hidden) closeHowto();
    else closeAll();
  });
  setBtn.addEventListener("click", function () {
    if (!panel.hidden) closeAll();
    else openSettings();
  });

  // ---------- 初回起動の操作説明(タッチ端末のみ) ----------
  // 横持ちのスマホではページ下の説明文(p.hint)が CSS で隠れるため、
  // 初回だけ操作説明を自動で出す。既読は保存し、次回からは出さない
  if (PP.TOUCH && PP.store && !PP.store.get("tutorialSeen", false)) {
    openHowto();
  }

  syncMute();   // 前回保存されたミュート状態をボタンの絵に反映する

  PP.settings = {
    syncMute: syncMute,                       // M キー側(input.js)が呼ぶ
    open: openSettings,
    isOpen: function () { return !panel.hidden || !howto.hidden; },
    closeTop: function () {                   // Esc キー用(input.js)
      if (!howto.hidden) closeHowto();
      else if (!panel.hidden) closeAll();
    }
  };
})();
