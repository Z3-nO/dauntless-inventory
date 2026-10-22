"use strict";

// Editor preferences live outside the distribution and never change game config files.
const fs = require("node:fs");
const path = require("node:path");
const { packageRoot } = require("./saves.cjs");
const VERSIONS = ["1.6.2", "1.14.7"];
const directory =
  process.env.MATERIALI_USER_DATA ||
  path.join(
    process.env.LOCALAPPDATA || __dirname,
    "DauntlessMateriali",
    "preferences",
  );
const file = path.join(directory, "directories.json");

function read() {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error(
      "Directory preferences are invalid. Restore directories.json from a backup.",
    );
  }
  return value;
}

function get(version) {
  if (!VERSIONS.includes(version)) throw Error("Unsupported version.");
  const saved = read()[version] || {};
  return {
    dataRoot: typeof saved.dataRoot === "string" ? saved.dataRoot : "",
    gameDir: typeof saved.gameDir === "string" ? saved.gameDir : "",
  };
}

function folder(value, label) {
  if (typeof value !== "string")
    throw Error(label + " must be a directory path.");
  if (!value.trim()) return "";
  if (!path.isAbsolute(value.trim()))
    throw Error(label + " must be an absolute path.");
  const resolved = fs.realpathSync(value.trim());
  if (!fs.statSync(resolved).isDirectory())
    throw Error(label + " must be a directory.");
  return resolved;
}

function save(version, value) {
  if (!VERSIONS.includes(version)) throw Error("Unsupported version.");
  const dataRoot = folder(value.dataRoot, "Forever data folder");
  const gameDir = folder(value.gameDir, "Game installation folder");
  // Verify the selected save format before replacing an existing preference.
  if (dataRoot) packageRoot(dataRoot, version);
  if (
    gameDir &&
    !fs
      .statSync(path.join(gameDir, "Archon", "Content", "Paks"), {
        throwIfNoEntry: false,
      })
      ?.isDirectory()
  ) {
    throw Error("Select the game folder containing Archon/Content/Paks.");
  }
  const updated = { ...read(), [version]: { dataRoot, gameDir } };
  fs.mkdirSync(directory, { recursive: true });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n");
  fs.renameSync(temporary, file);
  return get(version);
}

module.exports = { get, save };
