// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const saves = require("./saves.cjs");
const native = require("./live-native.cjs");
const installed = require("./live-install.cjs");

async function assertClosed(connection) {
  native.assertGameClosed();
  if (await saves.backendUp(connection.version === "1.6.2" ? 61000 : 63000))
    throw Error(
      "Update downloaded. Close the game and Forever server to install it.",
    );
}

function targets(connection) {
  const config = JSON.parse(
    fs.readFileSync(path.join(connection.root, "config.json"), "utf8"),
  );
  const game = path.resolve(config.GameDir, "Archon/Binaries/Win64");
  const relative =
    connection.version === "1.14.7"
      ? [
          "backend/recorder-1147.js",
          "tools/common.ps1",
          "tools/play-1147.ps1",
          "version.json",
          "bin/dxgi.dll",
        ]
      : [
          "backend/metagame/dist/app.js",
          "backend/metagame/src/app.ts",
          "tools/common.ps1",
          "tools/play.ps1",
          "tools/server.ps1",
          "version.json",
          "bin/UndauntedInternalServer.dll",
          "bin/UndauntedInternalServer.base.dll",
        ];
  return [
    ...relative.map((file) => path.join(connection.root, file)),
    ...[
      "dxgi.dll",
      "UndauntedInternalServer.dll",
      "UndauntedInternalServer.base.dll",
    ].map((file) => path.join(game, file)),
  ];
}

async function replaceInstalled(connection, replacement, options = {}) {
  await assertClosed(connection);
  const status = installed.status(connection);
  if (!status.installed)
    return { updated: false, message: "Install Live connection first." };
  if (!status.intact)
    throw Error(
      "Forever or another mod changed the installed files. Automatic update stopped to preserve them.",
    );
  const folder = path.join(connection.root, "backend/materiali-live");
  if (fs.lstatSync(folder).isSymbolicLink())
    throw Error("The installed Live folder cannot be a link.");
  const backup = path.join(
    connection.root,
    "backup",
    "materiali-live-update-" + Date.now() + "-" + crypto.randomUUID(),
  );
  const files = targets(connection).map((file, index) => ({
    file,
    snapshot: path.join(backup, index + ".bak"),
    exists: fs.existsSync(file),
  }));
  fs.mkdirSync(backup, { recursive: true });
  for (const row of files)
    if (row.exists) fs.copyFileSync(row.file, row.snapshot);
  fs.cpSync(folder, path.join(backup, "installed-bridge"), {
    recursive: true,
    dereference: false,
  });
  fs.writeFileSync(
    path.join(backup, "update.json"),
    JSON.stringify({ files, previousVersion: status.version }, null, 2),
  );
  try {
    await (options.previousInstaller || installed).uninstall(connection);
    const result = await replacement.install({
      ...connection,
      nativeRefresh: true,
    });
    if (!result.installed || !result.intact)
      throw Error("Updated module did not pass installation verification.");
    return {
      ...result,
      updated: true,
      updateBackup: backup,
      message: "Live module updated. Start Forever and reconnect Inventory.",
    };
  } catch (error) {
    try {
      for (const row of files) {
        if (row.exists) fs.copyFileSync(row.snapshot, row.file);
        else if (fs.existsSync(row.file)) fs.unlinkSync(row.file);
      }
      // Only the fixed bridge directory in the selected backend is replaced.
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true });
      fs.cpSync(path.join(backup, "installed-bridge"), folder, {
        recursive: true,
      });
      if (!installed.status(connection).intact)
        throw Error("Previous module verification failed.");
    } catch (restoreError) {
      throw Error(
        "Live update failed and needs manual recovery from its update backup: " +
          restoreError.message,
        { cause: error },
      );
    }
    throw Error(
      "Live update failed; the previous module was restored. " + error.message,
      { cause: error },
    );
  }
}

module.exports = { assertClosed, replaceInstalled, targets };
