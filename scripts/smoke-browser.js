/* 実ブラウザで file:// 起動し、モジュール読み込みと初期化例外を確認する。 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var spawnSync = require("node:child_process").spawnSync;

var browserCandidates = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];
var executablePath = browserCandidates.find(function (candidate) {
  return fs.existsSync(candidate);
});

if (!executablePath) {
  console.error("Smoke test failed: Chromium browser was not found.");
  process.exitCode = 1;
} else {
  var entry = pathToFileURL(path.resolve(__dirname, "..", "index.html")).href;
  // Playwright の対応 Node バージョンに依存させず、Chromium 自身の --dump-dom で
  // file:// ページを実行する。main.js が初期化を完了したときだけ readiness 属性が付く。
  var result = spawnSync(executablePath, [
    "--headless=new",
    "--disable-gpu",
    "--allow-file-access-from-files",
    "--dump-dom",
    entry
  ], { encoding: "utf8", timeout: 60000 });

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    console.error(result.stderr || "Chromium exited with status " + result.status);
    process.exitCode = 1;
  } else if (result.stdout.indexOf('data-pp-ready="true"') < 0) {
    console.error("Smoke test failed: application readiness marker was not found.");
    process.exitCode = 1;
  } else {
    console.log("Browser smoke test OK: stage and refactored modules initialized");
  }
}
