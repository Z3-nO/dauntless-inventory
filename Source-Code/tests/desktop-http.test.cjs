// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("The desktop HTTP service serves every script referenced by its page", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dauntless-http-test-"),
  );
  const previous = process.env.MATERIALI_USER_DATA;
  process.env.MATERIALI_USER_DATA = directory;
  const { server } = require("../server.cjs");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MATERIALI_USER_DATA;
    else process.env.MATERIALI_USER_DATA = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    scripts.includes("/live-session.js") && scripts.includes("/updates-ui.js"),
  );
  for (const script of scripts) {
    const response = await fetch(origin + script);
    assert.equal(response.status, 200, script);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(
      await response.text(),
      fs.readFileSync(path.join(__dirname, "../public", script), "utf8"),
    );
  }
  assert.equal((await fetch(origin + "/live-update-package.cjs")).status, 400);
});
