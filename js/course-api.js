/* =========================================================
 * course-api.js — 自分でコースを作るための公開 API
 *
 * コースは「制御点(ctrl)の並び」+少しの見た目フラグだけのデータ。
 * rail.build がそれを Catmull-Rom スプライン(または直角の道)へ変換する。
 * この API はその薄いデータを「作る・検証する・登録する・試遊する・
 * 保存/共有する」ための入口をまとめたもの。
 *
 * ---- 使い方(コンソール or 自作スクリプトから) ----
 *   var c = PP.courseAPI.create({
 *     name: "私の航路",
 *     sharp: false,          // true で直角の街路(角丸)、false で滑らかな曲線
 *     corner: 24,            // sharp のときの角丸半径
 *     overpass: false,       // true で自己交差を立体交差(橋)として描く
 *     speed: { entry: 300 }, // 省略可。そのコースのチェーン速度(既定は PP.SPEED)。
 *                            // 短いコースほど entry を落とさないと一瞬で樽に届く
 *     ctrl: [ [1450,80], [200,80], [200,300], [1100,300], ... ]  // [x,y] の並び
 *   });
 *   c.validate();            // → { ok, errors, warnings, length, points }
 *   c.play();                // その場でレベル1として試遊
 *   c.register();            // COURSES に加えてレベル進行で登場させる
 *   c.save("slot1");         // ブラウザに保存
 *   var json = c.toJSON();   // 文字列で書き出し(共有・バックアップ)
 *
 *   PP.courseAPI.load("slot1").play();     // 保存したものを読み出して試遊
 *   PP.courseAPI.slots();                  // 保存済みスロット名の一覧
 *   PP.courseAPI.fromJSON(json).play();    // もらった JSON をそのまま試遊
 *
 * ---- URL 共有 ----
 *   index.html?course=<圧縮文字列>  で開くと、そのコースを直接試遊。
 *   index.html?editcourse=1        で開くと、エディタが起動。
 * ========================================================= */
(function () {
  "use strict";
  var PP = window.PP;

  // 遊べる領域の目安(検証の警告に使う。端点=洞窟/樽は画面外でも許す)。
  // 縦は HUD 下端〜砲口、横は画面内(レールの縁 ±R を考慮)。
  var PLAY = { xMin: 40, xMax: PP.W - 40, yMin: 50, yMax: PP.CANNON_Y - 52 };
  var MIN_POINTS = 3;      // これ未満だと曲線にならない
  var MIN_LENGTH = 600;    // 全長がこれ未満だと波を捌く前に樽へ届いて即死

  var LS_PREFIX = "pp.course.";   // 各コースの保存キー
  var LS_INDEX = "pp.course.index"; // スロット名の一覧

  // ---- コースデータ操作(course-utils.js) ----
  var courseUtils = PP.courseUtils;
  var isNum = courseUtils.isNumber;
  var copyPt = courseUtils.copyPoint;
  var copyLane = courseUtils.copyLane;
  var normalizeSpeed = courseUtils.normalizeSpeed;
  var normalizeLanes = courseUtils.normalizeLanes;

  // ---- Course: 作りかけ/完成のコース1つを表す ----
  function Course(spec) {
    spec = spec || {};
    this.name = spec.name || "無名の航路";
    this.sharp = !!spec.sharp;
    this.corner = isNum(spec.corner) ? spec.corner : 24;
    this.overpass = !!spec.overpass;
    // チェーン速度のプロファイル(部分指定可・省略で既定)。レーンが短いコースほど
    // 落とさないと洞窟から樽まで一瞬で届く。※ エディタ(editor.js)は speed と
    // lane.raisedOver を扱わないので、エディタで開いて保存し直すとこの2つは落ちる
    // (エディタの橋は raised の区間指定で作る)。
    this.speed = normalizeSpeed(spec.speed);
    this.lanes = normalizeLanes(spec);   // [{ctrl, tunnels?, raised?, raisedOver?}, …]
    this.ctrl = this.lanes[0].ctrl;      // 互換: 単一レーン API・エディタは先頭レーンを読む
  }

  // rail.build / COURSES が期待する形へ変換(全レーン+区間指定を保つ)
  Course.prototype.toCourse = function () {
    var out = {
      name: this.name,
      sharp: this.sharp,
      corner: this.corner,
      overpass: this.overpass,
      lanes: this.lanes.map(copyLane)
    };
    if (this.speed) out.speed = normalizeSpeed(this.speed);
    return out;
  };

  // 検証: 致命的エラー(errors)と、遊べるが気になる点(warnings)を分ける。
  // errors が空なら play/register できる。
  Course.prototype.validate = function () {
    var errors = [], warnings = [];
    var lanes = this.lanes;
    var multi = lanes.length > 1;
    var totalPoints = 0;

    lanes.forEach(function (ln, li) {
      var pts = ln.ctrl;
      totalPoints += pts.length;
      var tag = multi ? ("レーン" + (li + 1) + ": ") : "";
      if (pts.length < MIN_POINTS) errors.push(tag + "制御点が少なすぎます(最低 " + MIN_POINTS + " 点)");
      if (pts.some(function (p) { return !isNum(p[0]) || !isNum(p[1]); }))
        errors.push(tag + "数値でない座標が含まれています");
    });

    var length = 0;
    if (errors.length === 0) {
      var course = this.toCourse();
      // 各レーンをレールへ変換して全長・領域はみ出しを測る(副作用なし)
      lanes.forEach(function (ln, li) {
        var pl = PP.rail.measure(course, li);
        if (pl.length > length) length = pl.length;
        var tag = multi ? ("レーン" + (li + 1) + ": ") : "";
        if (pl.length < MIN_LENGTH) errors.push(tag + "コースが短すぎます(全長 " +
          Math.round(pl.length) + "px。目安 " + MIN_LENGTH + "px 以上)");
        // 画面からはみ出す内部点は警告(端点=最初と最後は洞窟/樽なので除外)
        var out = 0, pts = ln.ctrl;
        for (var i = 1; i < pts.length - 1; i++) {
          var x = pts[i][0], y = pts[i][1];
          if (x < PLAY.xMin || x > PLAY.xMax || y < PLAY.yMin || y > PLAY.yMax) out++;
        }
        if (out > 0) warnings.push(tag + out + " 個の制御点が遊べる領域からはみ出しています");
      });

      // 交差の助言(rail.courseCrossings が自己交差もレーン間交差も列挙する)。
      // 上下(どちらが橋か)が未指定なら、指定方法を教える。
      var crossings = PP.rail.courseCrossings(course);
      if (crossings.length > 0) {
        var anyRaised = lanes.some(function (ln) {
          return (ln.raised && ln.raised.length) || (ln.raisedOver && ln.raisedOver.length);
        });
        var hasSelf = crossings.some(function (c) { return c.laneA === c.laneB; });
        var hasCross = crossings.some(function (c) { return c.laneA !== c.laneB; });
        if (hasSelf && !this.overpass)
          warnings.push("道が自分自身と交差しています。overpass:true で立体交差(橋)になります");
        if (hasCross && !anyRaised)
          warnings.push("レーン同士が交差しています。上にするレーンへ raised:[{from,to}] か " +
                        "raisedOver:[相手レーンindex] を付けると橋になります");
      }

      // 速度プロファイルの取り違え(洞窟側のほうが遅い)を知らせる
      if (this.speed && isNum(this.speed.entry) && isNum(this.speed.hole) &&
          this.speed.entry <= this.speed.hole)
        warnings.push("speed.entry(洞窟側)が speed.hole(樽の直前)以下です。手前ほど速くなります");
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings,
             length: Math.round(length), points: totalPoints };
  };

  // 致命的エラーがあれば例外にする(play/register の前段)
  Course.prototype.assertValid = function () {
    var r = this.validate();
    if (!r.ok) throw new Error("コースが不正です: " + r.errors.join(" / "));
    return r;
  };

  // その場で試遊(レベル1として開始)
  Course.prototype.play = function () {
    this.assertValid();
    PP.playCourse(this.toCourse());
    return this;
  };

  // COURSES に加える。レベル進行(courseForLevel)でいつか登場する。
  // 返り値は追加された COURSES 内のインデックス。
  Course.prototype.register = function () {
    this.assertValid();
    PP.COURSES.push(this.toCourse());
    return PP.COURSES.length - 1;
  };

  // 複製(エディタの「元コースを土台にする」で使う)
  Course.prototype.clone = function () { return new Course(this.toCourse()); };

  // プレーンなオブジェクト/文字列へ。lanes(多レーン+tunnels/raised)を保つ。
  // ctrl は先頭レーンのコピーも併記する: 旧版の読み手は ctrl だけを見て先頭レーンを
  // 読めるので、単一レーンのコースは後方互換のまま開ける。
  Course.prototype.toObject = function () {
    var out = { v: 2, name: this.name, sharp: this.sharp, corner: this.corner,
                overpass: this.overpass,
                ctrl: this.lanes[0].ctrl.map(copyPt),
                lanes: this.lanes.map(copyLane) };
    if (this.speed) out.speed = normalizeSpeed(this.speed);
    return out;
  };
  Course.prototype.toJSON = function () { return JSON.stringify(this.toObject()); };

  // URL 共有用の短い文字列(JSON を Base64 URL-safe に)
  Course.prototype.encode = function () {
    var b64 = btoa(unescape(encodeURIComponent(this.toJSON())));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  // localStorage へ保存(スロット名で管理)
  Course.prototype.save = function (slot) {
    slot = slot || this.name;
    try {
      localStorage.setItem(LS_PREFIX + slot, this.toJSON());
      var idx = readIndex();
      if (idx.indexOf(slot) < 0) { idx.push(slot); writeIndex(idx); }
    } catch (e) {
      throw new Error("保存に失敗しました(localStorage 不可): " + e.message);
    }
    return slot;
  };

  // ---- モジュール公開: PP.courseAPI ----
  function readIndex() {
    try { return JSON.parse(localStorage.getItem(LS_INDEX) || "[]"); }
    catch (e) { return []; }
  }
  function writeIndex(list) {
    try { localStorage.setItem(LS_INDEX, JSON.stringify(list)); } catch (e) {}
  }

  function decode(str) {
    var b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return decodeURIComponent(escape(atob(b64)));
  }

  var api = {
    // 新しいコースを作る(仕様オブジェクト → Course)
    create: function (spec) { return new Course(spec); },

    // JSON 文字列/オブジェクト/共有文字列のどれからでも Course を復元
    fromJSON: function (input) {
      var obj = input;
      if (typeof input === "string") {
        var s = input.trim();
        try { obj = JSON.parse(s); }
        catch (e) { obj = JSON.parse(decode(s)); }  // Base64 共有文字列も許容
      }
      return new Course(obj);
    },

    // 保存済みスロットの読み書き
    load: function (slot) {
      var raw = localStorage.getItem(LS_PREFIX + slot);
      if (!raw) throw new Error("スロットが見つかりません: " + slot);
      return new Course(JSON.parse(raw));
    },
    slots: function () { return readIndex(); },
    remove: function (slot) {
      localStorage.removeItem(LS_PREFIX + slot);
      writeIndex(readIndex().filter(function (s) { return s !== slot; }));
    },

    // 通常のコース進行へ戻す(試遊を抜ける)
    resume: function () { PP.playCourse(null); },

    // 既存の組み込みコースを土台として複製(エディタの下敷き)
    fromBuiltin: function (idx) {
      var src = PP.COURSES[idx] || PP.COURSES[0];
      return new Course(src);
    },

    // URL の ?course= / ?editcourse= を処理(main の init 後に呼ばれる)
    checkURL: function () {
      var q = new URLSearchParams(location.search);
      if (q.get("editcourse") && PP.editor) { PP.editor.open(); return true; }
      var enc = q.get("course");
      if (enc) {
        try { api.fromJSON(enc).play(); return true; }
        catch (e) { console.warn("URL のコースを読めませんでした:", e.message); }
      }
      return false;
    },

    Course: Course
  };

  PP.courseAPI = api;
})();
