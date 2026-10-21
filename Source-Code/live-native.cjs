// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// Inspected Forever releases for the same CL647472 game executable.
const MODERN_LOADERS = new Set([
  "baa606152802b1aedac17a45c8c613511383b2c87ddc2d927a9d2c185fbe3222",
  "cfe9b7b336b67676d4b071d9cc210fc375a04b2b4d3c399927828e3ea479dcf2",
]);
const EXE = "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b";
function verifiedModernLoader(hashes) {
  if (
    hashes.length !== 2 ||
    !hashes.every((value) => MODERN_LOADERS.has(value))
  )
    throw Error(
      "This Forever loader update is not supported by this Live release. " +
        "Update Inventory before installing Live; your current loader was retained.",
    );
  if (hashes[0] !== hashes[1])
    throw Error(
      "The game and Forever package have different loader versions. " +
        "Complete Forever setup or repair before installing Live. Original files retained.",
    );
  return hashes[0];
}
function assertGameClosed() {
  if (process.platform !== "win32") return;
  const result = require("node:child_process").spawnSync(
    "tasklist.exe",
    ["/fi", "IMAGENAME eq Dauntless-Win64-Shipping.exe", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw Error("Could not verify that Dauntless is closed.");
  if (result.stdout.toLowerCase().includes("dauntless-win64-shipping.exe"))
    throw Error(
      "Close every Dauntless game and server before changing the native Live loader.",
    );
}
function plan(connection) {
  if (connection.version === "1.6.2") return legacyPlan(connection);
  assertGameClosed();
  const cfg = JSON.parse(
    fs.readFileSync(path.join(connection.root, "config.json"), "utf8"),
  );
  const game = path.resolve(cfg.GameDir),
    bin = path.join(game, "Archon/Binaries/Win64");
  if (
    hash(fs.readFileSync(path.join(bin, "Dauntless-Win64-Shipping.exe"))) !==
    EXE
  )
    throw Error("Native Live supports only Dauntless 1.14.7 CL647472.");
  const binary = fs.readFileSync(path.join(__dirname, "native/dxgi.dll")),
    installedHash = hash(binary);
  const expected = JSON.parse(
    fs.readFileSync(path.join(__dirname, "native/manifest.json"), "utf8"),
  );
  if (installedHash !== expected.sha256)
    throw Error("Native Live payload failed integrity verification.");
  const changes = [
    { file: path.join(bin, "dxgi.dll"), edited: binary },
    { file: path.join(connection.root, "bin/dxgi.dll"), edited: binary },
  ];
  const originalHash = verifiedModernLoader(
    changes.map((row) => hash(fs.readFileSync(row.file))),
  );
  for (const name of ["tools/common.ps1", "version.json"]) {
    const file = path.join(connection.root, name),
      original = fs.readFileSync(file),
      source = original.toString("utf8");
    if (!source.toLowerCase().includes(originalHash))
      throw Error("The Forever loader verification metadata is not supported.");
    changes.push({
      file,
      edited: Buffer.from(
        source.replace(
          new RegExp(originalHash, "gi"),
          installedHash.toUpperCase(),
        ),
      ),
    });
  }
  const playFile = path.join(connection.root, "tools/play-1147.ps1"),
    play = fs.readFileSync(playFile, "utf8"),
    anchor = "$psi.EnvironmentVariables['EOS_OFFLINE_DIR'] = $EosDir";
  if (play.split(anchor).length !== 2)
    throw Error("Unsupported Forever client launcher.");
  changes.push({
    file: playFile,
    edited: Buffer.from(
      play.replace(
        anchor,
        anchor + "\n$psi.EnvironmentVariables['D1147_LIVE_DIR'] = $Root",
      ),
    ),
  });
  return changes.map((row) => ({
    ...row,
    original: fs.readFileSync(row.file),
  }));
}
function readHeartbeat(file) {
  let lastError;
  // The native process can replace the contents while we read. Retry a torn
  // snapshot, but never reuse a cached connection or ignore a corrupt file.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = fs.statSync(file);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      const after = fs.statSync(file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
        continue;
      // Windows file times and Date.now() can use different clock precision.
      // Allow at most two 15.6 ms timer ticks; larger future dates stay invalid.
      const age = Date.now() - Math.floor(after.mtimeMs);
      return { state, age: age >= -32 && age < 0 ? 0 : age };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || Error("Native heartbeat changed while being read.");
}

function heartbeat(connection) {
  const file = path.join(connection.root, "data/materiali-live-native.json");
  try {
    const { state, age } = readHeartbeat(file);
    const clientFile = path.join(
      connection.root,
      "data/materiali-live-client.json",
    );
    let client = null,
      clientFresh = false;
    try {
      const result = readHeartbeat(clientFile);
      client = result.state;
      const age = result.age;
      clientFresh = age >= 0 && age < 6000 && [1, 2].includes(client.protocol);
    } catch {}
    const fresh = age >= 0 && age < 6000;
    return {
      available:
        fresh &&
        clientFresh &&
        [1, 2].includes(state.protocol) &&
        state.connections === 1,
      builds:
        fresh &&
        clientFresh &&
        state.protocol === 2 &&
        client.protocol === 2 &&
        state.builds === true &&
        client.builds === true &&
        state.connections === 1,
      connections: state.connections,
      sessionId:
        Number.isInteger(state.pid) && Number.isInteger(client?.pid)
          ? state.pid + ":" + client.pid
          : null,
      lastInvoked: client?.lastInvoked || null,
      reason: !clientFresh
        ? "Native local client is not connected."
        : !fresh
          ? "Native game server is not connected."
          : state.connections !== 1
            ? "Automatic refresh requires exactly one connected player."
            : "Native refresh ready.",
    };
  } catch {
    return {
      available: false,
      reason: "Start the native Live server and connect one player.",
    };
  }
}
function signal(connection, id, slot = null) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw Error("Invalid refresh operation ID.");
  const info = heartbeat(connection);
  if (!info.available) return { ...info, queued: false };
  if (
    slot !== null &&
    (!info.builds || !Number.isInteger(slot) || slot < 0 || slot >= 128)
  )
    throw Error(
      "Native build refresh requires the current Live extension on the local client and server.",
    );
  const file = path.join(connection.root, "data/materiali-live-refresh.txt"),
    temp = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, id, { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  if (slot !== null) {
    const command = path.join(
      connection.root,
      "data/materiali-live-loadout.txt",
    );
    const temporary = command + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, id + "\n" + slot + "\n", { flag: "wx" });
      fs.renameSync(temporary, command);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { ...info, queued: true };
}
// A loadout response only proves delivery to one HTTP caller. Keep protecting
// the imported slot until both native processes report successful application.
function buildApplied(connection, receipt) {
  if (receipt.slot === null || receipt.nativeApplied === true) return true;
  try {
    for (const side of ["server", "client"]) {
      const ack = JSON.parse(
        fs.readFileSync(
          path.join(
            connection.root,
            `data/materiali-live-loadout-${side}.json`,
          ),
          "utf8",
        ),
      );
      if (
        ack.protocol !== 2 ||
        ack.id !== receipt.id ||
        ack.slot !== receipt.slot ||
        ack.applied !== true
      )
        return false;
      const heartbeatName = side === "server" ? "native" : "client";
      const state = JSON.parse(
        fs.readFileSync(
          path.join(
            connection.root,
            `data/materiali-live-${heartbeatName}.json`,
          ),
          "utf8",
        ),
      );
      if (!Number.isInteger(ack.pid) || ack.pid !== state.pid) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function legacyPlan(connection) {
  assertGameClosed();
  const originalHash =
    "083ec5c39126be4e4d13325d9b46a0b07e62fca0864dd9ff651ee224124510aa";
  const exeHash =
    "e7acba587320491b71cb53bb8f8cbf5f3760bb52f78e74a82384b8bc42d05fd6";
  const cfg = JSON.parse(
    fs.readFileSync(path.join(connection.root, "config.json"), "utf8"),
  );
  const bin = path.resolve(cfg.GameDir, "Archon/Binaries/Win64");
  if (
    hash(fs.readFileSync(path.join(bin, "Dauntless-Win64-Shipping.exe"))) !==
    exeHash
  )
    throw Error("Native Live supports only Dauntless 1.6.2 CL271281.");
  const binary = fs.readFileSync(
    path.join(__dirname, "native/UndauntedInternalServer.dll"),
  );
  const expected = JSON.parse(
    fs.readFileSync(path.join(__dirname, "native/manifest162.json"), "utf8"),
  );
  const installedHash = hash(binary);
  if (installedHash !== expected.sha256)
    throw Error("Native Live payload failed integrity verification.");
  const changes = [];
  for (const directory of [bin, path.join(connection.root, "bin")]) {
    const file = path.join(directory, "UndauntedInternalServer.dll");
    const original = fs.readFileSync(file);
    if (hash(original) !== originalHash)
      throw Error(
        "Unsupported Forever 1.6.2 server DLL. Restore its original version first.",
      );
    const baseFile = path.join(directory, "UndauntedInternalServer.base.dll");
    if (fs.existsSync(baseFile))
      throw Error(
        "A separate server extension already exists. Original files retained.",
      );
    changes.push(
      { file, original, edited: binary },
      { file: baseFile, original: null, edited: original },
    );
  }
  for (const name of ["tools/common.ps1", "version.json"]) {
    const file = path.join(connection.root, name),
      original = fs.readFileSync(file),
      source = original.toString("utf8");
    if (!source.toLowerCase().includes(originalHash))
      throw Error("Unsupported Forever server verification metadata.");
    let edited = source.replace(
      new RegExp(originalHash, "gi"),
      installedHash.toUpperCase(),
    );
    if (name === "tools/common.ps1") {
      const anchor = "$ConfigFile = Join-Path $Root 'config.json'";
      if (edited.split(anchor).length !== 2)
        throw Error("Unsupported Forever launcher.");
      edited = edited.replace(
        anchor,
        anchor + "\n$env:MATERIALI_LIVE_DIR = $Root",
      );
    }
    changes.push({ file, original, edited: Buffer.from(edited) });
  }
  return changes;
}
module.exports = {
  verifiedModernLoader,
  plan,
  heartbeat,
  signal,
  buildApplied,
  hash,
  assertGameClosed,
};
