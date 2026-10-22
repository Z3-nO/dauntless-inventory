// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const installed = require("../live-install.cjs"),
  native = require("../live-native.cjs"),
  saves = require("../saves.cjs");
const transactions = require("../live-update-install.cjs"),
  repair = require("../live-update-repair.cjs");
const { LiveUpdates } = require("../live-updates.cjs");
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
function backend(revision) {
  return Buffer.from(
    `// official ${revision}\nfunction handle(svc, port, req, res, bodyBuf) {\n  req._pkey = keyFromIds(pathName, body);\n  if (!reply) reply = NOT_FOUND;\n}\n`,
  );
}
async function fixture(t) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "inventory-forever-repair-"),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "forever"),
    game = path.join(temp, "game/Archon/Binaries/Win64");
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(path.join(root, "backend"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "tools"));
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ GameDir: path.resolve(game, "../../..") }),
  );
  fs.writeFileSync(
    path.join(root, "data/state.json"),
    "player inventory must survive",
  );
  const connection = { root, version: "1.14.7", nativeRefresh: true };
  const names = repair.allowedPaths(connection),
    old = new Map(),
    fresh = new Map();
  for (const [file, name] of names) {
    let a, b;
    if (name.includes("recorder")) {
      a = backend("old");
      b = backend("new");
    } else if (name.endsWith(".dll")) {
      a = Buffer.from("official-old-loader");
      b = Buffer.from("official-new-loader");
    } else if (name === "version.json") {
      a = Buffer.from('{"loader":"old","revision":1}');
      b = Buffer.from('{"loader":"new","revision":2}');
    } else {
      a = Buffer.from("official-old-" + name);
      b = Buffer.from("official-new-" + name);
    }
    old.set(file, a);
    fresh.set(file, b);
    fs.writeFileSync(file, a);
  }
  t.mock.method(native, "assertGameClosed", () => {});
  t.mock.method(saves, "backendUp", async () => false);
  t.mock.method(native, "plan", (c, files = fs) => {
    const a = files.readFileSync(path.join(root, "bin/dxgi.dll")),
      b = files.readFileSync(path.join(game, "dxgi.dll"));
    if (
      !a.equals(b) ||
      !["official-old-loader", "official-new-loader"].includes(a.toString())
    )
      throw Error("Unsupported or mixed loaders");
    return [...names]
      .filter(([, name]) => !name.includes("recorder"))
      .map(([file]) => ({
        file,
        original: files.readFileSync(file),
        edited: Buffer.from("our-live:" + files.readFileSync(file)),
      }));
  });
  await installed.install(connection);
  const baseline = Object.fromEntries(
    [...names].map(([file, name]) => [
      name,
      {
        sha256: hash(fresh.get(file)),
        normalizedSha256: name.endsWith(".json")
          ? hash(repair.normalized(fresh.get(file), name))
          : undefined,
      },
    ]),
  );
  const replacement = {
    ...installed,
    baselines: { versions: { "1.14.7": baseline } },
  };
  let now = 100000;
  const updater = new LiveUpdates({
    directory: path.join(temp, "prefs"),
    config: {},
    toolVersion: installed.version,
    now: () => now,
  });
  t.mock.method(updater, "installer", () => replacement);
  const updateForever = () => {
    for (const [file, bytes] of fresh) fs.writeFileSync(file, bytes);
  };
  const advance = () => {
    now += 61000;
  };
  return {
    temp,
    root,
    connection,
    names,
    old,
    fresh,
    replacement,
    updater,
    updateForever,
    advance,
  };
}
function unchangedSave(f) {
  assert.equal(
    fs.readFileSync(path.join(f.root, "data/state.json"), "utf8"),
    "player inventory must survive",
  );
}

test("Automatic repair waits for stable Forever files and restores all backend/launcher/native components, preserving upstream updates on removal", async (t) => {
  const f = await fixture(t);
  f.updateForever();
  assert.equal(
    (await f.updater.apply(f.connection, { automatic: true })).updated,
    false,
  );
  for (const [file, bytes] of f.fresh)
    assert.deepEqual(fs.readFileSync(file), bytes);
  f.advance();
  const result = await f.updater.apply(f.connection, { automatic: true });
  assert(result.updated && result.repairedAfterForeverUpdate && result.intact);
  await installed.uninstall(f.connection);
  for (const [file, bytes] of f.fresh)
    assert.deepEqual(fs.readFileSync(file), bytes);
  unchangedSave(f);
});

test("A partial Forever update keeps its new backend while removing only our unchanged old patches", async (t) => {
  const f = await fixture(t),
    recorder = path.join(f.root, "backend/recorder-1147.js");
  fs.writeFileSync(recorder, f.fresh.get(recorder));
  const result = await transactions.replaceInstalled(
    f.connection,
    f.replacement,
  );
  assert(result.repairedAfterForeverUpdate && result.intact);
  await installed.uninstall(f.connection);
  for (const [file, bytes] of f.old)
    assert.deepEqual(
      fs.readFileSync(file),
      file === recorder ? f.fresh.get(file) : bytes,
    );
  unchangedSave(f);
});

test("Unknown upstream changes and changed Live bridge files are rejected before a new transaction or write", async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, "backend/recorder-1147.js");
  fs.writeFileSync(file, backend("unreviewed"));
  const before = fs.readFileSync(file),
    backups = fs.readdirSync(path.join(f.root, "backup"));
  await assert.rejects(
    transactions.replaceInstalled(f.connection, f.replacement),
    /compatible signed Live release/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "backup")), backups);
  f.updateForever();
  fs.appendFileSync(
    path.join(f.root, "backend/materiali-live/live-runtime.cjs"),
    "\nchanged",
  );
  await assert.rejects(
    transactions.replaceInstalled(f.connection, f.replacement),
    /bridge itself changed/,
  );
  unchangedSave(f);
});

test("Failed repair rolls back to the exact newly updated Forever files, never to the obsolete pre-update loader", async (t) => {
  const f = await fixture(t);
  f.updateForever();
  const manifest = path.join(f.root, "backend/materiali-live/install.json"),
    before = fs.readFileSync(manifest);
  const replacement = {
    ...f.replacement,
    install: async () => {
      fs.writeFileSync(path.join(f.root, "bin/dxgi.dll"), "broken replacement");
      throw Error("disk fixture failure");
    },
  };
  await assert.rejects(
    transactions.replaceInstalled(f.connection, replacement),
    /previous module was restored/,
  );
  for (const [file, bytes] of f.fresh)
    assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(manifest), before);
  unchangedSave(f);
});

test("Previously managed Live is recovered after Forever deletes the bridge directory", async (t) => {
  const f = await fixture(t);
  await f.updater.apply(f.connection);
  assert(f.updater.wasManaged(f.connection));
  f.updateForever();
  const bridge = path.resolve(f.root, "backend/materiali-live");
  assert(bridge.startsWith(path.resolve(f.temp) + path.sep));
  fs.rmSync(bridge, { recursive: true });
  assert.equal(
    (await f.updater.apply(f.connection, { automatic: true })).updated,
    false,
  );
  f.advance();
  const result = await f.updater.apply(f.connection, { automatic: true });
  assert(result.updated && result.intact);
  unchangedSave(f);
});

test("Changes during preflight and a running server keep the updated files intact", async (t) => {
  const f = await fixture(t);
  f.updateForever();
  const planned = repair.plan(f.connection, f.replacement),
    file = path.join(f.root, "tools/common.ps1");
  fs.appendFileSync(file, "still updating");
  assert.throws(() => repair.assertUnchanged(planned.rows), /still updating/);
  f.updateForever();
  t.mock.method(saves, "backendUp", async () => true);
  await assert.rejects(
    transactions.replaceInstalled(f.connection, f.replacement),
    /Close the game/,
  );
  for (const [file, bytes] of f.fresh)
    assert.deepEqual(fs.readFileSync(file), bytes);
  unchangedSave(f);
});

test("Upstream version metadata tolerates only formatting differences, not changed content", async (t) => {
  const f = await fixture(t);
  f.updateForever();
  const file = path.join(f.root, "version.json");
  const bytes = Buffer.from(
    '\uFEFF{\r\n  "revision": 2, "loader": "new"\r\n}\r\n',
  );
  fs.writeFileSync(file, bytes);
  await transactions.replaceInstalled(f.connection, f.replacement);
  await installed.uninstall(f.connection);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("An intentional Live removal disables automatic recovery for that installation", async (t) => {
  const f = await fixture(t);
  await f.updater.apply(f.connection);
  assert(f.updater.wasManaged(f.connection));
  await installed.uninstall(f.connection);
  f.updater.forgetInstallation(f.connection);
  assert.equal(f.updater.wasManaged(f.connection), false);
  assert.match(
    (await f.updater.apply(f.connection, { automatic: true })).message,
    /Install Live connection first/,
  );
  assert.equal(installed.status(f.connection).installed, false);
  unchangedSave(f);
});
