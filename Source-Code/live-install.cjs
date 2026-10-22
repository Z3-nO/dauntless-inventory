// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const saves = require("./saves.cjs");
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const marker = "// MATERIALI-LIVE-V1";
const payload = [
  "live-runtime.cjs",
  "live-adapters.cjs",
  "live-native.cjs",
  "saves.cjs",
  "inventory.cjs",
  "loadouts.cjs",
  "build-import.cjs",
  "build1147.cjs",
  "build-export.cjs",
  "slot-management.cjs",
  "character-reset.cjs",
];
function fingerprint() {
  const files = new Set([
    ...payload,
    "live-install.cjs",
    "package.json",
    "native/dxgi.dll",
    "native/UndauntedInternalServer.dll",
    "native/manifest.json",
    "native/manifest162.json",
  ]);
  function collect(folder) {
    for (const entry of fs.readdirSync(path.join(__dirname, folder), {
      withFileTypes: true,
    })) {
      const file = folder + "/" + entry.name;
      if (entry.isDirectory()) collect(file);
      else files.add(file);
    }
  }
  collect("data");
  return digest(
    JSON.stringify(
      [...files]
        .sort()
        .map((file) => [
          file,
          digest(fs.readFileSync(path.join(__dirname, file))),
        ]),
    ),
  );
}
function patches(connection) {
  if (connection.version === "1.14.7")
    return [
      {
        file: "backend/recorder-1147.js",
        edit(source) {
          const anchor = "function handle(svc, port, req, res, bodyBuf) {";
          const initialize = `${marker}\nconst materialiLive = require('./materiali-live/live-runtime.cjs').create(require('./materiali-live/live-adapters.cjs').modern({root:ROOT,getState:()=>state,setState:value=>{state=value;},saveState}));\n`;
          source = replace(source, anchor, initialize + anchor);
          source = replace(
            source,
            "  req._pkey = keyFromIds(pathName, body);",
            `  if(pathName === '/_materiali/live/v1') {\n    const result=materialiLive.admin(req,body); const value=JSON.stringify(result.json);\n    res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(value);return;\n  }\n  req._pkey = keyFromIds(pathName, body);\n  {const owner=keyFromIds(pathName,body);const player=owner&&state.players[owner];const ch=player&&(player.characters||[]).find(x=>pathName.split('/').includes(x.id)||body?.characterId===x.id);if(ch)body=materialiLive.protect(JSON.stringify([owner,ch.id]),req.method,pathName,body);}`,
          );
          source = replace(
            source,
            "  if (!reply) reply = NOT_FOUND;",
            `  if (!reply) reply = NOT_FOUND;\n  if(reply.status<300&&reply.json) {\n    const owner=keyFromIds(pathName,body);const player=owner&&state.players[owner];\n    const ch=player&&(player.characters||[]).find(x=>pathName.split('/').includes(x.id)||body?.characterId===x.id);\n    if(ch)try{reply.json=materialiLive.decorate(JSON.stringify([owner,ch.id]),req.method,pathName,reply.json);}catch(e){console.error('Live delivery status could not be saved:',e.message);}\n  }`,
          );
          return source;
        },
      },
    ];
  return [
    {
      file: "backend/metagame/dist/app.js",
      edit(source) {
        return replace(
          source,
          'exports.app.use("/", require("./routes/travel162.js").travelRouter);',
          `${marker}\nexports.app.use(require('../../materiali-live/live-adapters.cjs').expressMiddleware(require('node:path').resolve(require('node:path').dirname(process.env.DB_FILENAME),'..'), require('./db').GetDb().$client));\nexports.app.use("/", require("./routes/travel162.js").travelRouter);`,
        );
      },
    },
    {
      file: "backend/metagame/src/app.ts",
      edit(source) {
        return replace(
          source,
          'app.use("/", travelRouter);',
          `${marker}\napp.use(require('../../materiali-live/live-adapters.cjs').expressMiddleware(require('node:path').resolve(require('node:path').dirname(process.env.DB_FILENAME),'..'), require('./db').GetDb().$client));\napp.use("/", travelRouter);`,
        );
      },
    },
  ];
}
function replace(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error(
      "This Forever backend is not supported by the Live installer. Original files retained.",
    );
  return source.replace(before, after);
}
function manifestPath(connection) {
  return path.join(connection.root, "backend/materiali-live/install.json");
}
function status(connection) {
  const file = manifestPath(connection);
  if (!fs.existsSync(file)) return { installed: false };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const bridge = path.dirname(file);
  const bridgeIntact = (manifest.bridgeFiles || []).every((row) => {
    const target = path.resolve(bridge, row.file);
    return (
      target.startsWith(path.resolve(bridge) + path.sep) &&
      fs.existsSync(target) &&
      digest(fs.readFileSync(target)) === row.sha256
    );
  });
  const intact = manifest.files.every(
    (row) =>
      fs.existsSync(path.join(connection.root, row.file)) &&
      digest(fs.readFileSync(path.join(connection.root, row.file))) ===
        row.installedHash,
  );
  return {
    installed: true,
    intact:
      intact &&
      bridgeIntact &&
      (manifest.native || []).every(
        (row) =>
          fs.existsSync(row.file) &&
          digest(fs.readFileSync(row.file)) === row.installedHash,
      ),
    nativeRefresh: !!manifest.native?.length,
    version: manifest.version,
    moduleFingerprint: manifest.moduleFingerprint || null,
    bridgeVerified:
      Array.isArray(manifest.bridgeFiles) && manifest.bridgeFiles.length > 0,
    backup: manifest.backup,
  };
}
function plan(connection, files = fs) {
  const changes = patches(connection).map((entry) => {
    const file = path.join(connection.root, entry.file);
    const original = files.readFileSync(file);
    const source = original.toString("utf8");
    if (source.includes(marker))
      throw Error(
        "An unrecognized Live patch is present. Restore your original backend first.",
      );
    return {
      file: entry.file,
      original,
      edited: Buffer.from(entry.edit(source)),
    };
  });
  const nativeChanges = connection.nativeRefresh
    ? require("./live-native.cjs").plan(connection, files)
    : [];
  return { changes, nativeChanges };
}
async function install(connection) {
  if (await saves.backendUp(connection.version === "1.6.2" ? 61000 : 63000))
    throw Error(
      "Close Forever and its local server once to install Live connection.",
    );
  if (status(connection).installed)
    throw Error(
      "Live connection is already installed. Remove it before reinstalling.",
    );
  const { changes, nativeChanges } = plan(connection);
  const destination = path.join(connection.root, "backend/materiali-live");
  if (fs.existsSync(destination))
    throw Error(
      "A previous Live installation folder exists. Original files retained.",
    );
  const backup = path.join(
    connection.root,
    "backup/materiali-live-install-" + Date.now() + "-" + crypto.randomUUID(),
  );
  fs.mkdirSync(backup, { recursive: true });
  for (const change of changes) {
    const target = path.join(backup, change.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.original, { flag: "wx" });
  }
  const nativeRows = nativeChanges.map((x, i) => ({
    file: x.file,
    backupFile: path.join(backup, "native-" + i + ".bak"),
    originalHash: x.original === null ? null : digest(x.original),
    installedHash: digest(x.edited),
  }));
  nativeRows.forEach((row, i) => {
    if (nativeChanges[i].original !== null)
      fs.writeFileSync(row.backupFile, nativeChanges[i].original, {
        flag: "wx",
      });
  });
  try {
    fs.mkdirSync(destination);
    for (const name of payload)
      fs.copyFileSync(path.join(__dirname, name), path.join(destination, name));
    fs.cpSync(path.join(__dirname, "data"), path.join(destination, "data"), {
      recursive: true,
    });
    for (const name of ["LICENSE", "NOTICE.txt"])
      fs.copyFileSync(path.join(__dirname, name), path.join(destination, name));
    const key = path.join(connection.root, "data/materiali-live.key");
    if (!fs.existsSync(key))
      fs.writeFileSync(key, crypto.randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    for (const change of changes)
      fs.writeFileSync(path.join(connection.root, change.file), change.edited);
    for (const change of nativeChanges)
      fs.writeFileSync(change.file, change.edited);
    const bridgeFiles = [];
    function recordBridge(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) recordBridge(file);
        else
          bridgeFiles.push({
            file: path.relative(destination, file).split(path.sep).join("/"),
            sha256: digest(fs.readFileSync(file)),
          });
      }
    }
    recordBridge(destination);
    fs.writeFileSync(
      manifestPath(connection),
      JSON.stringify(
        {
          version: require("./package.json").version,
          moduleFingerprint: fingerprint(),
          bridgeFiles,
          backup,
          native: nativeRows,
          files: changes.map((x) => ({
            file: x.file,
            originalHash: digest(x.original),
            installedHash: digest(x.edited),
          })),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  } catch (e) {
    for (const change of nativeChanges) {
      if (change.original === null) {
        if (
          fs.existsSync(change.file) &&
          digest(fs.readFileSync(change.file)) === digest(change.edited)
        )
          fs.unlinkSync(change.file);
      } else fs.writeFileSync(change.file, change.original);
    }
    for (const change of changes)
      fs.writeFileSync(
        path.join(connection.root, change.file),
        change.original,
      );
    // This directory was created by this invocation and is confined to the selected backend.
    fs.rmSync(destination, { recursive: true, force: true });
    throw e;
  }
  return {
    ...status(connection),
    message:
      "Live connection installed. Start Forever, then reconnect your character in Inventory.",
  };
}
async function uninstall(connection, options = {}) {
  if (await saves.backendUp(connection.version === "1.6.2" ? 61000 : 63000))
    throw Error(
      "Close Forever and its server before removing Live connection.",
    );
  const info = status(connection);
  if (!info.installed || !info.intact)
    throw Error(
      "Backend files changed since installation. Automatic removal stopped to preserve your changes.",
    );
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath(connection), "utf8"),
  );
  const originals = manifest.files.map((row) => {
    // Only known backend paths can be restored, even if a manifest was edited.
    if (!patches(connection).some((x) => x.file === row.file))
      throw Error("Invalid backup file path.");
    const bytes = fs.readFileSync(path.join(manifest.backup, row.file));
    if (digest(bytes) !== row.originalHash)
      throw Error("Original backend backup failed verification.");
    return { file: row.file, bytes };
  });
  if (manifest.native?.length) require("./live-native.cjs").assertGameClosed();
  const nativeOriginals = (manifest.native || []).map((row) => {
    const bytes =
      row.originalHash === null ? null : fs.readFileSync(row.backupFile);
    if (bytes !== null && digest(bytes) !== row.originalHash)
      throw Error("Native loader backup failed verification.");
    const allowed = require("./live-native.cjs");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(connection.root, "config.json"), "utf8"),
    );
    const known = [
      path.resolve(cfg.GameDir, "Archon/Binaries/Win64/dxgi.dll"),
      path.resolve(
        cfg.GameDir,
        "Archon/Binaries/Win64/UndauntedInternalServer.dll",
      ),
      path.resolve(
        cfg.GameDir,
        "Archon/Binaries/Win64/UndauntedInternalServer.base.dll",
      ),
      ...[
        "bin/dxgi.dll",
        "bin/UndauntedInternalServer.dll",
        "bin/UndauntedInternalServer.base.dll",
        "tools/common.ps1",
        "tools/play-1147.ps1",
        "version.json",
      ].map((n) => path.resolve(connection.root, n)),
    ];
    if (
      !known.includes(path.resolve(row.file)) ||
      !path
        .resolve(row.backupFile)
        .startsWith(path.resolve(manifest.backup) + path.sep)
    )
      throw Error("Invalid native restore path.");
    return { file: row.file, bytes };
  });
  options.beforeWrite?.();
  for (const row of nativeOriginals) {
    if (row.bytes === null) fs.unlinkSync(row.file);
    else fs.writeFileSync(row.file, row.bytes);
  }
  for (const row of originals)
    fs.writeFileSync(path.join(connection.root, row.file), row.bytes);
  const destination = path.join(connection.root, "backend/materiali-live");
  const expected = path.resolve(connection.root, "backend", "materiali-live");
  if (
    path.resolve(destination) !== expected ||
    !expected.startsWith(path.resolve(connection.root) + path.sep)
  )
    throw Error("Unsafe installation path.");
  fs.rmSync(destination, { recursive: true });
  return {
    installed: false,
    message:
      "Original backend files restored. Backups and live item changes are retained.",
  };
}
module.exports = {
  plan,
  baselines: require("./data/forever-baselines.json"),
  install,
  uninstall,
  status,
  fingerprint,
  version: require("./package.json").version,
};
