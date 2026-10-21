// SPDX-License-Identifier: AGPL-3.0-only
// Starter loadout fields follow the versioned Forever / Undaunted backends.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const readJson = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const backupDirectory = (connection) =>
  path.join(connection.root, "backup", "materiali-tool");
const pointPattern = /^reset-point-[0-9a-f-]{36}\.json$/;

function characterData(raw) {
  const old = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
  const fresh = {};
  for (const key of ["AppearanceData", "LastChangelist"])
    if (Object.hasOwn(old, key)) fresh[key] = old[key];
  return fresh;
}

function starterPersistent() {
  return {
    manual_emotes: Array(6).fill(""),
    intro_emote: "EM_INTRO_BEGINNER_01",
    banner: "BN_BEGINNER_00",
    bannerCustomization: JSON.stringify({
      BannerMeshItemID: "BNC_MESH_BEGINNER_00",
      FabricMaterialItemID: "BNC_FABRIC_BEGINNER_00",
      SigilTextureItemID: "BNC_SIGIL_BEGINNER_00",
      PlantVFXItemID: "",
      PersistantStandardVFXItemID: "",
      AnimationItemID: "BNC_ANIMATION_BEGINNER_00",
    }),
    flare: "QI_BASIC_FLARE_DURABLE",
    title: "",
    head_accessory: "",
    back_accessory: "",
    pet: "",
    glider: "GD_FRAME_STARTER_BASE",
    update_version: 0,
    quick_chats: Array(9).fill(""),
    emojis: Array(9).fill(""),
    quick_curiosities_items: Array.from({ length: 8 }, (_, item_index) => ({
      item_index,
      item_id: "",
      instance_id: "",
    })),
    quickwheel: [],
  };
}

function resetData(target, rawCharacterData) {
  const data = characterData(rawCharacterData);
  const persistent = starterPersistent();
  const defaults = {
    weapon: "WP_EB_TRAINING",
    helmet: "AR_UNEQUIPPED_HELM",
    chest: "AR_BEGINNER_CHEST",
    arms: "AR_BEGINNER_ARMS",
    legs: "AR_BEGINNER_LEGS",
    lantern: "LT_BASIC",
  };
  const slot = (old, index) => ({
    ...Object.fromEntries(
      Object.entries(defaults).map(([key, id]) => [
        key,
        { item_id: id, instance_id: id, instance_data: "" },
      ]),
    ),
    player_role: null,
    subweapon: null,
    persistent: structuredClone(persistent),
    ...(old?.appearance !== undefined ? { appearance: old.appearance } : {}),
    flask: "FL_HEALING_DEFAULT",
    custom_name: "",
    quick_items: [],
    slot_index: index,
    update_version: (old?.update_version || 0) + 1,
  });
  return {
    data,
    inv: {
      stackedItems: [],
      instancedItems: Object.values(defaults).map((id) => ({
        catalogId: id,
        instanceId: id,
        itemData: null,
        updateVersion: 0,
      })),
    },
    loadouts: (target.loadouts.length ? target.loadouts : [{}]).map(slot),
    persistent,
  };
}

function activeFile(root, userId, characterId) {
  const name = (userId + "_" + characterId).replace(/[^\w-]/g, "_") + ".json";
  return path.join(root, "data", "loadouts", name);
}

function readActiveState(root, userId, characterId) {
  const file = activeFile(root, userId, characterId);
  if (!fs.existsSync(file)) return { exists: false };
  if (fs.statSync(file).size > 65536)
    throw Error("Active loadout state is too large.");
  return { exists: true, bytes: fs.readFileSync(file).toString("base64") };
}

function writeActiveState(root, userId, characterId, state) {
  if (!state || typeof state.exists !== "boolean")
    throw Error("Invalid active loadout backup.");
  const file = activeFile(root, userId, characterId);
  if (!state.exists) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  if (typeof state.bytes !== "string" || state.bytes.length > 90000)
    throw Error("Invalid active loadout backup.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, Buffer.from(state.bytes, "base64"), {
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function rememberReset(connection, request, backupFile, name, activeState) {
  const id = "reset-point-" + crypto.randomUUID() + ".json";
  const point = {
    id,
    version: connection.version,
    character: request.character,
    name,
    created: new Date().toISOString(),
    backup: path.basename(backupFile),
    ...(activeState ? { activeState } : {}),
  };
  fs.writeFileSync(
    path.join(backupDirectory(connection), id),
    JSON.stringify(point, null, 2),
    { flag: "wx" },
  );
  return point;
}

function resetPoints(connection, character) {
  const directory = backupDirectory(connection);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => pointPattern.test(name))
    .flatMap((name) => {
      try {
        const point = readJson(path.join(directory, name));
        if (
          point.character !== character ||
          point.version !== connection.version
        )
          return [];
        const file = backupFile(connection, point);
        if (!fs.lstatSync(file).isFile()) return [];
        return [{ id: name, name: point.name, created: point.created }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

function backupFile(connection, point) {
  if (
    typeof point.backup !== "string" ||
    !/^(?:state\.json|undaunted\.db)\.\d+-[0-9a-f]+\.bak$/.test(point.backup)
  )
    throw Error("Invalid reset backup.");
  const file = path.join(backupDirectory(connection), point.backup);
  if (!fs.lstatSync(file).isFile()) throw Error("Reset backup is unavailable.");
  return file;
}

function loadRestore(connection, request) {
  if (
    typeof request.backupId !== "string" ||
    !pointPattern.test(request.backupId)
  )
    throw Error("Choose a reset backup.");
  const point = readJson(
    path.join(backupDirectory(connection), request.backupId),
  );
  if (
    point.version !== connection.version ||
    point.character !== request.character
  )
    throw Error("Backup belongs to another character or version.");
  const file = backupFile(connection, point);
  if (connection.version === "1.14.7") {
    const [account, id] = JSON.parse(request.character);
    const player = readJson(file).players?.[account];
    const character = player?.characters?.find((ch) => ch.id === id);
    if (!character || !player.inventory?.[id] || !player.loadouts?.[id])
      throw Error("Incomplete character backup.");
    return {
      character,
      inv: player.inventory[id],
      loadoutRecord: player.loadouts[id],
    };
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = {};
    for (const table of [
      "characters",
      "inventories",
      "loadouts",
      "breadcrumbs",
      "encounteredcontent",
    ])
      if (hasTable(db, table))
        rows[table] = db
          .prepare('SELECT * FROM "' + table + '" WHERE characterId=?')
          .all(request.character);
    if (rows.characters?.length !== 1 || rows.inventories?.length !== 1)
      throw Error("Incomplete character backup.");
    return { rows, activeState: point.activeState };
  } finally {
    db.close();
  }
}

function hasTable(db, name) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function clearSqlProgress(db, character) {
  for (const table of ["breadcrumbs", "encounteredcontent"])
    if (hasTable(db, table))
      db.prepare('DELETE FROM "' + table + '" WHERE characterId=?').run(
        character,
      );
}

function restoreSql(db, character, restored) {
  const current = db
    .prepare("SELECT userId FROM characters WHERE characterId=?")
    .get(character);
  if (restored.rows.characters[0].userId !== current?.userId)
    throw Error("Backup belongs to another account.");
  for (const table of [
    "characters",
    "inventories",
    "loadouts",
    "breadcrumbs",
    "encounteredcontent",
  ]) {
    const rows = restored.rows[table];
    if (!rows) continue;
    if (!hasTable(db, table))
      throw Error("Character database schema has changed.");
    const columns = new Set(
      db
        .prepare('PRAGMA table_info("' + table + '")')
        .all()
        .map((c) => c.name),
    );
    const existing = db
      .prepare('SELECT characterId FROM "' + table + '" WHERE characterId=?')
      .get(character);
    const updateInPlace =
      ["characters", "inventories", "loadouts"].includes(table) &&
      rows.length === 1 &&
      existing;
    if (!updateInPlace)
      db.prepare('DELETE FROM "' + table + '" WHERE characterId=?').run(
        character,
      );
    for (const row of rows) {
      const keys = Object.keys(row);
      if (keys.some((key) => !columns.has(key)))
        throw Error("Character database schema has changed.");
      const quote = (key) => '"' + key.replaceAll('"', '""') + '"';
      if (updateInPlace) {
        const values = keys.filter((key) => key !== "characterId");
        db.prepare(
          'UPDATE "' +
            table +
            '" SET ' +
            values.map((key) => quote(key) + "=?").join(",") +
            " WHERE characterId=?",
        ).run(...values.map((key) => row[key]), character);
        continue;
      }
      db.prepare(
        'INSERT INTO "' +
          table +
          '" (' +
          keys.map(quote).join(",") +
          ") VALUES (" +
          keys.map(() => "?").join(",") +
          ")",
      ).run(...keys.map((key) => row[key]));
    }
  }
}

module.exports = {
  readActiveState,
  writeActiveState,
  resetData,
  rememberReset,
  resetPoints,
  loadRestore,
  clearSqlProgress,
  restoreSql,
};
