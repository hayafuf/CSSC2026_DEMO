/* 全 JavaScript を実行せずに構文解析する軽量チェック。ブラウザ専用コードにも使える。 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var projectRoot = path.resolve(__dirname, "..");
var sourceDirectories = ["js", "scripts", "tests"];
var checked = 0;

function checkDirectory(relativeDirectory) {
  var directory = path.join(projectRoot, relativeDirectory);
  if (!fs.existsSync(directory)) return;
  fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
    var fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      checkDirectory(path.relative(projectRoot, fullPath));
      return;
    }
    if (path.extname(entry.name) !== ".js") return;
    var relativePath = path.relative(projectRoot, fullPath);
    new vm.Script(fs.readFileSync(fullPath, "utf8"), { filename: relativePath });
    checked++;
  });
}

sourceDirectories.forEach(checkDirectory);
console.log("JavaScript syntax OK: " + checked + " files");
