// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const saves = require("./saves.cjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
function backupName(root, name) {
  const directory = path.join(root, "backup/materiali-tool");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(
    directory,
    name + ".live-" + Date.now() + "-" + crypto.randomUUID() + ".bak",
  );
}
function modern({ root, getState, setState, saveState }) {
  const adapter = {
    root,
    version: "1.14.7",
    characters: () => saves.jsonCharacters(getState(), root),
    receipts: () => getState().materialiLive || [],
    saveReceipts: () => saveState(),
    commit(target, result, receipt) {
      const original = clone(getState());
      receipt.backup = backupName(root, "state.json");
      fs.writeFileSync(receipt.backup, JSON.stringify(original, null, 2), {
        flag: "wx",
      });
      try {
        target.player.inventory[target.character.id] = result.inv;
        if (receipt.slot !== null)
          target.player.loadouts[target.character.id].loadouts =
            result.loadouts;
        const receipts = (getState().materialiLive ||= []);
        // Never discard pending deliveries. Retain recent completed operation IDs for retry safety.
        if (
          receipts.filter((x) => !x.inventorySent || !x.loadoutSent).length >=
          128
        )
          throw Error(
            "Too many pending live operations. Refresh the inventory in game first.",
          );
        receipts.push(receipt);
        saveState();
      } catch (e) {
        setState(original);
        throw e;
      }
    },
  };
  return adapter;
}
function legacy(root, db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS materiali_live_receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  );
  let receipts = db
    .prepare("SELECT payload FROM materiali_live_receipts ORDER BY rowid")
    .all()
    .map((x) => JSON.parse(x.payload));
  function persist() {
    const write = db.prepare(
      "INSERT INTO materiali_live_receipts(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
    );
    for (const receipt of receipts)
      write.run(receipt.id, JSON.stringify(receipt));
  }
  return {
    root,
    version: "1.6.2",
    characters: () => saves.databaseCharacters(db, root),
    receipts: () => receipts,
    saveReceipts: () => db.transaction(persist)(),
    commit(target, result, receipt) {
      if (
        receipts.filter((x) => !x.inventorySent || !x.loadoutSent).length >= 128
      )
        throw Error(
          "Too many pending live operations. Refresh the inventory in game first.",
        );
      receipt.backup = backupName(root, "undaunted.db");
      // A synchronous SQLite snapshot: no game request can interleave before BEGIN IMMEDIATE.
      db.prepare("VACUUM INTO ?").run(receipt.backup);
      const before = clone(receipts);
      try {
        db.transaction(() => {
          db.prepare(
            "UPDATE inventories SET stackedItems=?,instancedItems=? WHERE characterId=?",
          ).run(
            JSON.stringify(result.inv.stackedItems),
            JSON.stringify(result.inv.instancedItems),
            target.id,
          );
          if (receipt.slot !== null)
            db.prepare(
              "UPDATE loadouts SET loadouts=? WHERE characterId=?",
            ).run(JSON.stringify(result.loadouts), target.id);
          receipts.push(receipt);
          persist();
        }).immediate();
      } catch (e) {
        receipts = before;
        throw e;
      }
    },
  };
}
function expressMiddleware(root, db) {
  const runtime = require("./live-runtime.cjs").create(legacy(root, db));
  return function (req, res, next) {
    if (req.path === "/_materiali/live/v1") {
      const result = runtime.admin(req, req.body);
      return res.status(result.status).json(result.json);
    }
    const send = res.json.bind(res);
    res.json = (json) => {
      if (res.statusCode < 300 && req.AuthData) {
        const parts = req.path.split("/");
        const character =
          req.body?.characterId ||
          (["inventory", "loadout"].includes(parts[1]) ? parts[3] : null);
        try {
          json = runtime.decorate(character, req.method, req.path, json);
        } catch (e) {
          console.error("Live delivery status could not be saved:", e.message);
        }
      }
      return send(json);
    };
    const parts = req.path.split("/");
    if (parts[1] === "loadout")
      req.body = runtime.protect(parts[3], req.method, req.path, req.body);
    next();
  };
}
module.exports = { modern, legacy, expressMiddleware };
