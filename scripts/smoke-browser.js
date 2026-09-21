/* Direct file:// startup smoke test, compatible with Node 18. */
"use strict";
const assert = require("node:assert/strict");
const { withBrowser } = require("./browser-client");
withBrowser(async browser => {
  await browser.navigate();
  await browser.ready();
  assert.equal(await browser.evaluate('document.documentElement.getAttribute("data-pp-ready")'), 'true');
  assert.deepEqual(browser.errors, [], 'uncaught browser exceptions');
  console.log('Browser smoke test OK: all modules and startup initialized');
}).catch(error => { console.error(error); process.exitCode = 1; });
