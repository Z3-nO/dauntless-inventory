// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function normalized(bytes, name) {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  return name === "version.json"
    ? Buffer.from(JSON.stringify(canonical(JSON.parse(text))))
    : Buffer.from(text.replace(/\r\n/g, "\n"));
}
function allowedPaths(connection) {
  const config = JSON.parse(
    fs.readFileSync(path.join(connection.root, "config.json"), "utf8"),
  );
  const game = path.resolve(config.GameDir, "Archon/Binaries/Win64");
  const names =
    connection.version === "1.14.7"
      ? [
          "backend/recorder-1147.js",
          "bin/dxgi.dll",
          "tools/common.ps1",
          "tools/play-1147.ps1",
          "version.json",
        ]
      : [
          "backend/metagame/dist/app.js",
          "backend/metagame/src/app.ts",
          "bin/UndauntedInternalServer.dll",
          "bin/UndauntedInternalServer.base.dll",
          "tools/common.ps1",
          "version.json",
        ];
  const result = new Map(
    names.map((name) => [path.resolve(connection.root, name), name]),
  );
  for (const name of connection.version === "1.14.7"
    ? ["dxgi.dll"]
    : ["UndauntedInternalServer.dll", "UndauntedInternalServer.base.dll"])
    result.set(path.join(game, name), "game/" + name);
  return result;
}
function regularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Unsafe Live repair file: " + path.basename(file));
  let parent = path.dirname(file);
  while (parent !== path.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink())
      throw Error("A Live repair path contains a link.");
    parent = path.dirname(parent);
  }
  return true;
}
function verifyBridge(folder, manifest) {
  if (!Array.isArray(manifest.bridgeFiles) || !manifest.bridgeFiles.length)
    throw Error(
      "Automatic repair stopped to preserve an unverified Live installation. Run the one-time verified setup first.",
    );
  if (!fs.existsSync(folder)) return;
  if (fs.lstatSync(folder).isSymbolicLink())
    throw Error("The installed Live folder cannot be a link.");
  for (const row of manifest.bridgeFiles) {
    const file = path.resolve(folder, row.file);
    if (
      !file.startsWith(path.resolve(folder) + path.sep) ||
      !regularFile(file) ||
      hash(fs.readFileSync(file)) !== row.sha256
    )
      throw Error(
        "The Live bridge itself changed. Automatic repair stopped to preserve it.",
      );
  }
  const expected = new Set([
    "install.json",
    ...manifest.bridgeFiles.map((row) => row.file.replaceAll("\\", "/")),
  ]);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw Error(
          "The Live bridge contains a link. Automatic repair stopped.",
        );
      if (entry.isDirectory()) walk(file);
      else if (
        !expected.has(path.relative(folder, file).split(path.sep).join("/"))
      )
        throw Error(
          "An additional file is present in the Live bridge. Automatic repair stopped to preserve it.",
        );
    }
  }
  walk(folder);
}

// Keep updated upstream files, remove only our unchanged patches, and reject
// unknown changes. The signed replacement must accept the entire cleaned view
// before the transaction creates a backup or writes any game/launcher file.
function plan(connection, replacement, previousManifest) {
  const folder = path.join(connection.root, "backend/materiali-live");
  const manifest =
    previousManifest ||
    JSON.parse(fs.readFileSync(path.join(folder, "install.json"), "utf8"));
  verifyBridge(folder, manifest);
  if (
    typeof replacement.plan !== "function" ||
    !replacement.baselines?.versions?.[connection.version]
  )
    throw Error(
      "A compatible Inventory update is required to repair this Forever update.",
    );
  const baseline = replacement.baselines.versions[connection.version];
  const allowed = allowedPaths(connection);
  const backupRoot = path.resolve(manifest.backup);
  const expectedBackupRoot = path.resolve(connection.root, "backup") + path.sep;
  if (!backupRoot.startsWith(expectedBackupRoot))
    throw Error("Invalid original Live backup location.");
  const seen = new Set(),
    rows = [];
  for (const entry of [
    ...manifest.files.map((row) => ({
      ...row,
      file: path.resolve(connection.root, row.file),
      backupFile: path.resolve(backupRoot, row.file),
    })),
    ...(manifest.native || []),
  ]) {
    const file = path.resolve(entry.file),
      key = file.toLowerCase();
    const name = allowed.get(file);
    if (!name || seen.has(key))
      throw Error("Invalid or duplicate Live repair path.");
    seen.add(key);
    const exists = regularFile(file),
      current = exists ? fs.readFileSync(file) : null;
    const currentHash = current === null ? null : hash(current);
    let clean;
    if (currentHash === entry.installedHash) {
      if (entry.originalHash === null) clean = null;
      else {
        const saved = path.resolve(entry.backupFile);
        if (!saved.startsWith(backupRoot + path.sep) || !regularFile(saved))
          throw Error("Original Live backup is unavailable.");
        clean = fs.readFileSync(saved);
        if (hash(clean) !== entry.originalHash)
          throw Error("Original Live backup failed verification.");
      }
    } else if (currentHash === entry.originalHash) clean = current;
    else {
      const trusted = baseline[name];
      let matches =
        current !== null && trusted && currentHash === trusted.sha256;
      if (!matches && current !== null && trusted?.normalizedSha256) {
        try {
          matches =
            hash(normalized(current, name)) === trusted.normalizedSha256;
        } catch {}
      }
      if (!matches)
        throw Error(
          "Forever changed " +
            name +
            ". Waiting for a compatible signed Live release; the updated file was retained.",
        );
      clean = current;
    }
    rows.push({ file, exists, currentHash, clean });
  }
  if (seen.size !== allowed.size)
    throw Error(
      "The previous Live installation is incomplete. Automatic repair stopped.",
    );
  const view = new Map(rows.map((row) => [row.file, row.clean]));
  const files = {
    readFileSync(file, encoding) {
      const resolved = path.resolve(file);
      if (!view.has(resolved)) return fs.readFileSync(file, encoding);
      const bytes = view.get(resolved);
      if (bytes === null)
        throw Error("Required repair input is missing: " + path.basename(file));
      return encoding ? bytes.toString(encoding) : bytes;
    },
    existsSync(file) {
      const resolved = path.resolve(file);
      return view.has(resolved)
        ? view.get(resolved) !== null
        : fs.existsSync(file);
    },
  };
  replacement.plan({ ...connection, nativeRefresh: true }, files);
  return { rows, manifest };
}
function assertUnchanged(rows) {
  for (const row of rows) {
    const exists = regularFile(row.file);
    if (
      exists !== row.exists ||
      (exists && hash(fs.readFileSync(row.file)) !== row.currentHash)
    )
      throw Error(
        "Forever is still updating its files. Live repair was deferred.",
      );
  }
}
module.exports = { plan, assertUnchanged, normalized, allowedPaths };
