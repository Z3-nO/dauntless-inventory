"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "inventory-directories-"),
);
process.env.MATERIALI_USER_DATA = path.join(temporary, "preferences");
const settings = require("../settings.cjs");
const images = require("../images.cjs");

test("Directory settings persist independently by version; invalid changes preserve preferences and game files", () => {
  const roots = {};
  for (const version of ["1.6.2", "1.14.7"]) {
    const root = path.join(temporary, version),
      game = path.join(root, "game");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.mkdirSync(path.join(game, "Archon/Content/Paks"), { recursive: true });
    fs.writeFileSync(
      path.join(
        root,
        "data",
        version === "1.6.2" ? "undaunted.db" : "state.json",
      ),
      "original save bytes",
    );
    fs.writeFileSync(path.join(root, "config.json"), '{"retain":"original"}');
    settings.save(version, { dataRoot: root, gameDir: game });
    roots[version] = { dataRoot: root, gameDir: game };
  }
  for (const version of Object.keys(roots))
    assert.deepEqual(settings.get(version), roots[version]);
  const file = path.join(process.env.MATERIALI_USER_DATA, "directories.json"),
    before = fs.readFileSync(file);
  const empty = path.join(temporary, "empty");
  fs.mkdirSync(empty);
  for (const data of [
    { dataRoot: empty, gameDir: "" },
    { dataRoot: "relative", gameDir: "" },
    { dataRoot: "", gameDir: temporary },
  ]) {
    assert.throws(() => settings.save("1.6.2", data));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.throws(() =>
    settings.save("unsupported", { dataRoot: "", gameDir: "" }),
  );
  const v = "1.6.2",
    info = images.standardPaths(
      roots[v].dataRoot,
      v,
      path.resolve(__dirname, ".."),
      roots[v].gameDir,
    );
  assert.equal(
    info.nativeRoot,
    path.join(roots[v].gameDir, "Archon/Content/Paks"),
  );
  assert.equal(info.nativeFound, true);
  assert.equal(
    fs.readFileSync(path.join(roots[v].dataRoot, "data/undaunted.db"), "utf8"),
    "original save bytes",
  );
  assert.equal(
    fs.readFileSync(path.join(roots[v].dataRoot, "config.json"), "utf8"),
    '{"retain":"original"}',
  );
  settings.save(v, { dataRoot: "", gameDir: "" });
  assert.deepEqual(settings.get(v), { dataRoot: "", gameDir: "" });
  assert.deepEqual(settings.get("1.14.7"), roots["1.14.7"]);
});

test("Corrupt preferences are reported rather than silently overwritten", () => {
  const file = path.join(process.env.MATERIALI_USER_DATA, "directories.json");
  fs.writeFileSync(file, "{broken");
  assert.throws(() => settings.save("1.6.2", { dataRoot: "", gameDir: "" }));
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
