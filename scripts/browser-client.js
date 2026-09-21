/* Node 18対応の最小CDPクライアント。追加パッケージ・HTTPサーバー不要。 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function withBrowser(run) {
  const executable = [process.env.PP_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"
  ].find(candidate => candidate && fs.existsSync(candidate));
  if (!executable) throw Error("Chromium not found; set PP_BROWSER to its executable path.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pp-browser-test-"));
  const child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-pipe", "--user-data-dir=" + profile],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const pending = new Map(), errors = [];
  let nextId = 0, buffer = "";
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        if (message.error) reject(Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
    }
  });
  child.on("error", error => { for (const request of pending.values()) request.reject(error); });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  let session;
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const command = (method, params) => send(method, params, session);
    await command("Page.enable"); await command("Runtime.enable");
    const evaluate = async expression => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const entry = pathToFileURL(path.resolve(__dirname, "../index.html")).href;
    await run({ command, evaluate, errors,
      navigate: query => command("Page.navigate", { url: entry + (query || "") }),
      ready: () => evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 25000;
        const timer = setInterval(() => {
          if (window.PP && PP.editor && PP.game.state !== 'loading' && PP.stage) {
            clearInterval(timer); resolve(PP.game.state);
          } else if (Date.now() > deadline) { clearInterval(timer); reject(Error('Application not ready')); }
        }, 50);
      })`)
    });
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else { child.once("exit", resolve); setTimeout(resolve, 2000).unref(); }
    });
    // 削除対象はこのテストが作った一時ディレクトリだけ。
    const resolved = fs.realpathSync(profile);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith("pp-browser-test-")) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
module.exports = { withBrowser };
