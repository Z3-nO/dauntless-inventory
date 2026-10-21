// Save adapters: SQLite for 1.6.2, JSON for 1.14.7. Every write is backed up.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { DatabaseSync, backup } = require("node:sqlite");
const {
  catalogs,
  applyItems,
  parseData,
  requireItem,
} = require("./inventory.cjs");
const { slotSummary, equipBuild } = require("./loadouts.cjs");
const { planBuild } = require("./build-import.cjs");
const slots = require("./slot-management.cjs");
const reset = require("./character-reset.cjs");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function packageRoot(input, version) {
  if (!Object.hasOwn(catalogs, version)) throw Error("Unsupported version.");
  if (typeof input !== "string" || !input.trim())
    throw Error("Choose the Forever data folder.");
  const root = path.resolve(input);
  for (const candidate of [
    path.join(root, "versions", version),
    path.join(root, version),
    root,
  ]) {
    const file = path.join(
      candidate,
      "data",
      version === "1.6.2" ? "undaunted.db" : "state.json",
    );
    if (fs.existsSync(file)) return { root: candidate, file, version };
  }
  throw Error(
    "Save not found. Create a character in the Forever launcher first.",
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function ownCharacters(db, root) {
  const key = fs
    .readFileSync(path.join(root, "data/player.key"), "utf8")
    .trim();
  if (!key.startsWith("UUK_")) throw Error("Unrecognized local account key.");
  let account;
  try {
    account = db
      .prepare("SELECT userId FROM userapikeys WHERE keyHash=?")
      .get(digest(key));
  } catch {}
  if (!account)
    try {
      account = db
        .prepare("SELECT userId FROM userapikeystoregister WHERE key=?")
        .get(key);
    } catch {}
  if (!account) throw Error("Your account was not found.");
  return db
    .prepare("SELECT characterId,name FROM characters WHERE userId=?")
    .all(account.userId);
}

function jsonCharacters(state, root = "") {
  const characters = [];
  for (const [playerId, player] of Object.entries(state.players || {})) {
    for (const character of player.characters || []) {
      const inv = player.inventory?.[character.id];
      if (
        !inv ||
        !Array.isArray(inv.stackedItems) ||
        !Array.isArray(inv.instancedItems)
      )
        throw Error("Unrecognized JSON inventory.");
      characters.push({
        id: JSON.stringify([playerId, character.id]),
        name: character.name || character.id,
        inv,
        loadouts: player.loadouts?.[character.id]?.loadouts || [],
        slotInfo: slots.jsonSlotInfo(
          root,
          player,
          character.id,
          player.loadouts?.[character.id]?.loadouts || [],
        ),
        player,
        character,
      });
    }
  }
  return characters;
}

function databaseCharacters(db, root) {
  return ownCharacters(db, root).map((character) => {
    const row = db
      .prepare(
        "SELECT stackedItems,instancedItems FROM inventories WHERE characterId=?",
      )
      .get(character.characterId);
    if (!row) throw Error("Inventory not found.");
    let loadouts = [];
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='loadouts'",
        )
        .get()
    ) {
      const record = db
        .prepare("SELECT loadouts FROM loadouts WHERE characterId=?")
        .get(character.characterId);
      if (record) loadouts = JSON.parse(record.loadouts);
    }
    return {
      id: character.characterId,
      name: character.name,
      inv: {
        stackedItems: JSON.parse(row.stackedItems || "[]"),
        instancedItems: JSON.parse(row.instancedItems || "[]"),
      },
      loadouts,
      slotInfo: slots.sqliteSlotInfo(root, loadouts),
    };
  });
}

function summarize(character) {
  const items = Object.create(null);
  for (const row of character.inv.stackedItems) {
    if (!row || !Number.isSafeInteger(row.quantity) || row.quantity < 0)
      throw Error("Invalid saved quantity.");
    items[row.catalogId] = (items[row.catalogId] || 0) + row.quantity;
  }
  const gear = character.inv.instancedItems.map((row) => ({
    id: row.catalogId,
    instanceId: row.instanceId,
    level: parseData(row.itemData).CurrentLevel || 0,
  }));
  for (const row of gear) items[row.id] = (items[row.id] || 0) + 1;
  return {
    id: character.id,
    name: character.name,
    items,
    gear,
    slots: slots.listSlots(character.loadouts, character.slotInfo),
    slotInfo: character.slotInfo,
  };
}

function databaseSnapshot(db, root) {
  const rows = databaseCharacters(db, root);
  return {
    characters: rows.map(summarize),
    revision: digest(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          inv: row.inv,
          loadouts: row.loadouts,
          slotInfo: row.slotInfo,
          activeLoadout: reset.readActiveState(
            root,
            db
              .prepare("SELECT userId FROM characters WHERE characterId=?")
              .get(row.id).userId,
            row.id,
          ),
          character: db
            .prepare("SELECT * FROM characters WHERE characterId=?")
            .get(row.id),
          progress: ["breadcrumbs", "encounteredcontent"].map((table) =>
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
              )
              .get(table)
              ? db
                  .prepare('SELECT * FROM "' + table + '" WHERE characterId=?')
                  .all(row.id)
              : [],
          ),
        })),
      ),
    ),
  };
}

function snapshot(connection) {
  if (connection.version === "1.14.7") {
    const bytes = fs.readFileSync(connection.file);
    const state = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    return {
      characters: jsonCharacters(state, connection.root).map(summarize),
      revision: digest(bytes),
    };
  }
  const db = new DatabaseSync(connection.file, { readOnly: true });
  try {
    return databaseSnapshot(db, connection.root);
  } finally {
    db.close();
  }
}

function backendUp(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let completed = false;
    const finish = (result) => {
      if (!completed) {
        completed = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(700, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

function prepareRequest(request, version) {
  if (
    request.operation === "reset-character" ||
    request.operation === "restore-character"
  ) {
    if (typeof request.confirmName !== "string" || !request.confirmName)
      throw Error("Type the selected character's name to confirm.");
    return {
      reset: request.operation === "reset-character",
      restore: request.operation === "restore-character",
    };
  }
  if (request.operation === "add-slots") {
    if (
      !Number.isInteger(request.sourceSlot) ||
      !Number.isInteger(request.count) ||
      request.count < 1
    )
      throw Error(
        "Select a source slot and a positive whole number of new slots.",
      );
    return {
      addSlots: true,
      sourceSlot: request.sourceSlot,
      count: request.count,
    };
  }
  if (request.buildCode) {
    const plan = planBuild(request.buildCode, version);
    if (!plan.compatible) throw Error(plan.issues.join("\n"));
    if (!Number.isInteger(request.slot))
      throw Error("Choose the slot to update.");
    return {
      changes: plan.changes,
      mode: "add",
      maximize: version === "1.6.2",
      plan,
      slot: request.slot,
    };
  }
  if (!["add", "set"].includes(request.mode)) throw Error("Invalid operation.");
  const changes = request.changes;
  if (
    !changes ||
    Array.isArray(changes) ||
    typeof changes !== "object" ||
    !Object.keys(changes).length
  )
    throw Error("Select at least one item.");
  for (const [id, n] of Object.entries(changes)) {
    requireItem(version, id);
    if (!Number.isSafeInteger(n) || n < 0 || n > 99999999)
      throw Error("Invalid quantity: " + id);
  }
  return { changes, mode: request.mode, maximize: request.maximize === true };
}

function transform(character, prepared, version) {
  if (prepared.addSlots)
    return slots.createSlots(character, prepared.sourceSlot, prepared.count);
  let changes = prepared.changes;
  let mode = prepared.mode;
  if (prepared.plan) {
    changes = { ...changes };
    for (const id of Object.keys(changes)) {
      const existing = character.inv.stackedItems
        .filter((row) => row.catalogId === id)
        .reduce((sum, row) => sum + row.quantity, 0);
      changes[id] = Math.max(changes[id], existing);
    }
    mode = "set";
  }
  let inv = applyItems(
    character.inv,
    changes,
    mode,
    version,
    prepared.maximize,
  );
  let equippedPlan = prepared.plan;
  if (equippedPlan?.sourceVersion === "1.14.7") {
    const modern = require("./build1147.cjs").prepareModernInstances(
      inv,
      equippedPlan,
    );
    inv = modern.inv;
    equippedPlan = { ...equippedPlan, instances: modern.instances };
  }
  const loadouts = equippedPlan
    ? equipBuild(character.loadouts, prepared.slot, equippedPlan, inv)
    : character.loadouts;
  return { inv, loadouts };
}

async function saveChanges(connection, request) {
  const prepared = prepareRequest(request, connection.version);
  if (await backendUp(connection.version === "1.6.2" ? 61000 : 63000)) {
    if (prepared.reset || prepared.restore || prepared.addSlots)
      throw Error(
        "Close the game and the local Forever server before reset, restore or adding slots.",
      );
    return require("./live-client.cjs").call(connection, "apply", request);
  }
  if (snapshot(connection).revision !== request.revision)
    throw Error("The save has changed. Reconnect the folder.");
  const directory = path.join(connection.root, "backup", "materiali-tool");
  fs.mkdirSync(directory, { recursive: true });
  const backupFile = path.join(
    directory,
    path.basename(connection.file) +
      "." +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex") +
      ".bak",
  );
  if (connection.version === "1.14.7") {
    const original = fs.readFileSync(connection.file);
    if (digest(original) !== request.revision)
      throw Error("The save has changed.");
    const state = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, ""));
    const target = jsonCharacters(state, connection.root).find(
      (row) => row.id === request.character,
    );
    if (!target) throw Error("Character not found.");
    if (
      (prepared.reset || prepared.restore) &&
      request.confirmName !== target.name
    )
      throw Error("Character name confirmation does not match.");
    const restored = prepared.restore
      ? reset.loadRestore(connection, request)
      : null;
    const result = prepared.reset
      ? reset.resetData(target, target.character.data)
      : restored
        ? { inv: restored.inv }
        : transform(target, prepared, connection.version);
    target.player.inventory[target.character.id] = result.inv;
    if (prepared.reset) {
      target.character.data =
        typeof target.character.data === "string"
          ? JSON.stringify(result.data)
          : result.data;
      target.character.updateVersion =
        (target.character.updateVersion || 0) + 1;
      target.player.loadouts[target.character.id] = {
        ...target.player.loadouts[target.character.id],
        loadouts: result.loadouts,
        persistent: result.persistent,
        active_index: 0,
      };
    }
    if (restored) {
      Object.assign(target.character, restored.character);
      target.player.loadouts[target.character.id] = restored.loadoutRecord;
    }
    if (prepared.plan || prepared.addSlots)
      target.player.loadouts[target.character.id].loadouts = result.loadouts;
    if (prepared.addSlots) {
      const metadata = target.player.loadoutSlots1147 || {};
      target.player.loadoutSlots1147 = {
        ...metadata,
        account: result.accountSlots,
        characters: {
          ...(metadata.characters || {}),
          [target.character.id]: target.slotInfo.characterSlots,
        },
      };
    }
    fs.writeFileSync(backupFile, original, { flag: "wx" });
    if (prepared.reset)
      reset.rememberReset(connection, request, backupFile, target.name);
    const temporary = connection.file + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), {
        flag: "wx",
      });
      if (!fs.readFileSync(connection.file).equals(original))
        throw Error("The game changed the save during this operation.");
      fs.renameSync(temporary, connection.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  } else {
    const db = new DatabaseSync(connection.file);
    let activeRollback = null;
    try {
      await backup(db, backupFile);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (databaseSnapshot(db, connection.root).revision !== request.revision)
          throw Error("The save has changed.");
        const target = databaseCharacters(db, connection.root).find(
          (row) => row.id === request.character,
        );
        if (!target)
          throw Error("This character does not belong to your account.");
        if (
          (prepared.reset || prepared.restore) &&
          request.confirmName !== target.name
        )
          throw Error("Character name confirmation does not match.");
        const currentCharacter =
          prepared.reset || prepared.restore
            ? db
                .prepare("SELECT * FROM characters WHERE characterId=?")
                .get(target.id)
            : null;
        const activeBefore = currentCharacter
          ? reset.readActiveState(
              connection.root,
              currentCharacter.userId,
              target.id,
            )
          : null;
        if (currentCharacter)
          fs.writeFileSync(
            backupFile + ".active.json",
            JSON.stringify(activeBefore),
            { flag: "wx" },
          );
        if (prepared.restore) {
          const restored = reset.loadRestore(connection, request);
          reset.restoreSql(db, target.id, restored);
          if (restored.activeState) {
            activeRollback = {
              userId: currentCharacter.userId,
              characterId: target.id,
              state: activeBefore,
            };
            reset.writeActiveState(
              connection.root,
              currentCharacter.userId,
              target.id,
              restored.activeState,
            );
          }
        } else {
          const current = prepared.reset
            ? db
                .prepare("SELECT * FROM characters WHERE characterId=?")
                .get(target.id)
            : null;
          const result = prepared.reset
            ? reset.resetData(target, current.data)
            : transform(target, prepared, connection.version);
          if (!prepared.addSlots)
            db.prepare(
              "UPDATE inventories SET stackedItems=?,instancedItems=? WHERE characterId=?",
            ).run(
              JSON.stringify(result.inv.stackedItems),
              JSON.stringify(result.inv.instancedItems),
              target.id,
            );
          if (prepared.plan || prepared.addSlots || prepared.reset)
            db.prepare(
              "UPDATE loadouts SET loadouts=? WHERE characterId=?",
            ).run(JSON.stringify(result.loadouts), target.id);
          if (prepared.reset) {
            db.prepare(
              "UPDATE characters SET data=?, updateVersion=updateVersion+1 WHERE characterId=?",
            ).run(JSON.stringify(result.data), target.id);
            db.prepare(
              "UPDATE loadouts SET persistent=? WHERE characterId=?",
            ).run(JSON.stringify(result.persistent), target.id);
            if (
              !db
                .prepare("SELECT characterId FROM loadouts WHERE characterId=?")
                .get(target.id)
            )
              db.prepare(
                "INSERT INTO loadouts (characterId,userId,loadouts,persistent) VALUES (?,?,?,?)",
              ).run(
                target.id,
                current.userId,
                JSON.stringify(result.loadouts),
                JSON.stringify(result.persistent),
              );
            reset.clearSqlProgress(db, target.id);
            reset.rememberReset(
              connection,
              request,
              backupFile,
              target.name,
              activeBefore,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (activeRollback)
          reset.writeActiveState(
            connection.root,
            activeRollback.userId,
            activeRollback.characterId,
            activeRollback.state,
          );
        throw error;
      }
    } finally {
      db.close();
    }
  }
  return { ...snapshot(connection), backup: backupFile };
}

module.exports = {
  packageRoot,
  snapshot,
  saveChanges,
  jsonCharacters,
  backendUp,
  prepareRequest,
  transform,
  summarize,
  databaseCharacters,
  databaseSnapshot,
};
