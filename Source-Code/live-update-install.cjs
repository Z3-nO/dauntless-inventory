// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const saves = require("./saves.cjs");
const native = require("./live-native.cjs");
const installed = require("./live-install.cjs");
const repair = require("./live-update-repair.cjs");

async function assertClosed(connection) {
  native.assertGameClosed();
  if (await saves.backendUp(connection.version === "1.6.2" ? 61000 : 63000))
    throw Error(
      "Update downloaded. Close the game and Forever server to install it.",
    );
}

function targets(connection) {
  return [...repair.allowedPaths(connection).keys()];
}

async function replaceInstalled(connection, replacement, options = {}) {
  await assertClosed(connection);
  const status = installed.status(connection);
  if (!status.installed && !options.recoveryManifest)
    return { updated: false, message: "Install Live connection first." };
  const rebase = !status.intact
    ? repair.plan(connection, replacement, options.recoveryManifest)
    : null;
  const folder = path.join(connection.root, "backend/materiali-live");
  const bridgeExisted = fs.existsSync(folder);
  if (bridgeExisted && fs.lstatSync(folder).isSymbolicLink())
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
  if (bridgeExisted)
    fs.cpSync(folder, path.join(backup, "installed-bridge"), {
      recursive: true,
      dereference: false,
    });
  fs.writeFileSync(
    path.join(backup, "update.json"),
    JSON.stringify({ files, previousVersion: status.version }, null, 2),
  );
  let mutationStarted = false;
  try {
    if (rebase) {
      repair.assertUnchanged(rebase.rows);
      mutationStarted = true;
      for (const row of rebase.rows) {
        if (row.clean === null) {
          if (row.exists) fs.unlinkSync(row.file);
        } else fs.writeFileSync(row.file, row.clean);
      }
      if (bridgeExisted) fs.rmSync(folder, { recursive: true });
    } else {
      if (options.previousInstaller) mutationStarted = true;
      await (options.previousInstaller || installed).uninstall(connection, {
        beforeWrite: () => {
          mutationStarted = true;
        },
      });
    }
    const result = await replacement.install({
      ...connection,
      nativeRefresh: true,
    });
    if (!result.installed || !result.intact)
      throw Error("Updated module did not pass installation verification.");
    return {
      ...result,
      updated: true,
      repairedAfterForeverUpdate: !!rebase,
      updateBackup: backup,
      message: rebase
        ? "Live restored for the updated Forever files. Launcher, backend and native modules verified."
        : "Live module updated. Start Forever and reconnect Inventory.",
    };
  } catch (error) {
    if (!mutationStarted)
      throw Error("Live update deferred; no files changed. " + error.message, {
        cause: error,
      });
    try {
      for (const row of files) {
        if (row.exists) fs.copyFileSync(row.snapshot, row.file);
        else if (fs.existsSync(row.file)) fs.unlinkSync(row.file);
      }
      // Only the fixed bridge directory in the selected backend is replaced.
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true });
      if (bridgeExisted)
        fs.cpSync(path.join(backup, "installed-bridge"), folder, {
          recursive: true,
        });
      if (status.intact && !installed.status(connection).intact)
        throw Error("Previous module verification failed.");
      for (const row of files) {
        if (
          fs.existsSync(row.file) !== row.exists ||
          (row.exists &&
            !fs.readFileSync(row.file).equals(fs.readFileSync(row.snapshot)))
        )
          throw Error("Pre-update file restoration failed.");
      }
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
