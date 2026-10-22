// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const draft = require("../desktop-update-draft.cjs");
test("An application restart preserves pending editor input without applying it and consumes the draft only once", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "inventory-restart-draft-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "draft.json"),
    value = {
      version: "1.14.7",
      selection: { CURRENCY_NOTES: 100 },
      mode: "add",
      maximize: true,
      buildCode: "pending builder code",
    };
  draft.save(file, value);
  assert.deepEqual(draft.take(file), value);
  assert.equal(draft.take(file), null);
  for (const bad of [
    { ...value, version: "other" },
    { ...value, selection: { ITEM: -1 } },
    { ...value, mode: "execute" },
    { ...value, buildCode: "x".repeat(1000001) },
  ])
    assert.throws(() => draft.save(file, bad), /draft/);
  draft.save(file, value);
  const stored = JSON.parse(fs.readFileSync(file));
  stored.saved -= 90000000;
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(draft.take(file), null);
});
