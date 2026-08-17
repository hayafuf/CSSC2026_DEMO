/* =========================================================
 * store.js — 設定の永続化(localStorage の薄いラッパー)
 *
 * ミュート・音量・画質・チュートリアル既読・前回の難易度などの
 * 「小さな設定値」を localStorage に保存する。キーは "pp.opt.〜"
 * (言語の "pp.lang"、コースの "pp.course.*" と同じ流儀)。
 *
 * localStorage はプライベートブラウズや file:// で例外を投げることが
 * あるので、必ず try/catch で包み、失敗しても黙って既定値で続行する
 * (保存できない環境でもゲームは普通に遊べる)。
 *
 * このファイルは i18n.js の直後・他の全モジュールより前に読み込む
 * (audio.js が読み込み時点で音量を復元するため)。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP = window.PP || {};

  var PREFIX = "pp.opt.";

  PP.store = {
    // 保存値を返す。無い/壊れている/読めない場合は def を返す
    get: function (key, def) {
      try {
        var raw = localStorage.getItem(PREFIX + key);
        if (raw === null) return def;
        return JSON.parse(raw);
      } catch (e) { return def; }
    },
    // 値を保存する(JSON化できる値のみ)。失敗しても例外を漏らさない
    set: function (key, val) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); }
      catch (e) { /* 保存できない環境でも続行 */ }
    }
  };
})();
