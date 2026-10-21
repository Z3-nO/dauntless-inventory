"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { findDirectories, examples } = require("../directories.cjs");

test("Auto-find chooses a launcher with the requested version, reads BOM config and never changes save/config bytes", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "forever-detection-"));
  for (const [launcher, version] of [
    ["DauntlessForever", "1.6.2"],
    ["DauntlessOffline", "1.14.7"],
  ]) {
    const root = path.join(local, launcher, "versions", version);
    const game = path.join(local, "Games", version);
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.mkdirSync(path.join(game, "Archon/Content/Paks"), { recursive: true });
    const file = path.join(
      root,
      "data",
      version === "1.6.2" ? "undaunted.db" : "state.json",
    );
    const config = path.join(root, "config.json");
    fs.writeFileSync(file, "save bytes");
    fs.writeFileSync(config, "\uFEFF" + JSON.stringify({ GameDir: game }));
    const before = fs.readFileSync(config);
    assert.deepEqual(findDirectories(version, local), {
      dataRoot: fs.realpathSync(root),
      gameDir: game,
    });
    assert.equal(fs.readFileSync(file, "utf8"), "save bytes");
    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(fs.existsSync(path.join(root, "directories.json")), false);
  }
});

test("Auto-find falls back to launcher.json; invalid game folders are not reported as found", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "forever-launcher-"));
  const launcher = path.join(local, "DauntlessForever");
  const root = path.join(launcher, "versions/1.14.7");
  const game = path.join(local, "Game");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/state.json"), "{}");
  fs.writeFileSync(
    path.join(launcher, "launcher.json"),
    JSON.stringify({ versions: { "1.14.7": { gameDir: game } } }),
  );
  assert.deepEqual(findDirectories("1.14.7", local), {
    dataRoot: fs.realpathSync(root),
    gameDir: "",
  });
  fs.mkdirSync(path.join(game, "Archon/Content/Paks"), { recursive: true });
  assert.equal(findDirectories("1.14.7", local).gameDir, game);
  assert.deepEqual(findDirectories("1.6.2", local), {
    dataRoot: "",
    gameDir: "",
  });
  assert.throws(() => findDirectories("unknown", local));
});

test("Public examples use environment placeholders and contain no current user profile", () => {
  for (const version of ["1.6.2", "1.14.7"]) {
    assert.equal(
      examples()[version].dataRoot,
      "%LOCALAPPDATA%\\DauntlessForever\\versions\\" + version,
    );
    if (process.env.USERPROFILE)
      assert.equal(
        JSON.stringify(examples()).includes(process.env.USERPROFILE),
        false,
      );
  }
});
