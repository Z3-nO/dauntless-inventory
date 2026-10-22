"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { packageRoot } = require("./saves.cjs");
const { standardPaths } = require("./images.cjs");
const versions = ["1.6.2", "1.14.7"];

// Search standard launcher locations, then validate the selected version's save.
// Detection is read-only: it never stores preferences or opens a character.
function findDirectories(version, localAppData = process.env.LOCALAPPDATA) {
  if (!versions.includes(version)) throw Error("Unsupported version.");
  if (!localAppData) return { dataRoot: "", gameDir: "" };
  for (const name of ["DauntlessForever", "DauntlessOffline"]) {
    let candidate;
    try {
      candidate = packageRoot(path.join(localAppData, name), version);
    } catch {
      continue;
    }
    const dataRoot = fs.realpathSync(candidate.root);
    let info = standardPaths(dataRoot, version);
    if (!info.nativeFound)
      info = standardPaths(path.join(localAppData, name), version);
    const gameDir = info.nativeFound ? info.gameDir : "";
    return { dataRoot, gameDir };
  }
  return { dataRoot: "", gameDir: "" };
}

function examples() {
  return Object.fromEntries(
    versions.map((version) => [
      version,
      {
        dataRoot: "%LOCALAPPDATA%\\DauntlessForever\\versions\\" + version,
        gameDir: "C:\\Games\\Dauntless_" + version,
        textures: "C:\\Games\\Dauntless_" + version + "\\Archon\\Content\\Paks",
      },
    ]),
  );
}

module.exports = { findDirectories, examples };
