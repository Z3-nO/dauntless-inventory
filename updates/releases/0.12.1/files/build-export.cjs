// SPDX-License-Identifier: AGPL-3.0-only
// Read saved equipment only. Never infer an item from its cosmetic appearance.
"use strict";
const legacy = require("./data/builder.json");
const modern = require("./data/modern/builder1147.json");
const modernMappings = require("./data/modern/mappings.json");
const {
  emptyBuild,
  encodeBuild,
  decodeBuild,
  ARMOUR,
} = require("./data/modern/build-code.mjs");
const datasets = {
  "1.6.2": { ...legacy.data, version: "1.6.2" },
  "1.14.7": modern,
};
const fields = { Head: "helmet", Torso: "chest", Arms: "arms", Legs: "legs" };
const subtypes = {
  EB: "subtype_eblade",
  IH: "subtype_ihammer",
  GA: "subtype_gaxe",
  CB: "subtype_blades",
  MS: "subtype_msspear",
  AC: "subtype_ac",
};

function metadata(value) {
  if (value == null || value === "") return {};
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw Error("Invalid saved equipment metadata.");
  return result;
}

function exportPreset(characters, request, version) {
  const data = datasets[version];
  if (!data || request?.version !== version)
    throw Error("Choose the connected game version.");
  const character = characters.find((ch) => ch.id === request.character);
  if (!character) throw Error("Character not found in this save.");
  const index = request.slot;
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Object.hasOwn(character.loadouts, index) ||
    !character.loadouts[index] ||
    Array.isArray(character.loadouts[index])
  )
    throw Error("Choose an existing saved equipment preset.");
  const slot = character.loadouts[index],
    state = emptyBuild();
  const mappings = version === "1.6.2" ? legacy.mappings : modernMappings;
  const reverse = (category, id, predicate = () => true) => {
    const matches = data[category]
      .map((item, i) => ({ item, i }))
      .filter(
        ({ item, i }) =>
          mappings[category]?.[version === "1.6.2" ? i : item.key] === id &&
          predicate(item),
      );
    if (matches.length !== 1)
      throw Error(
        "The " +
          version +
          " Builder cannot represent " +
          category +
          " item " +
          id +
          ". No code was exported.",
      );
    return matches[0].i;
  };
  const equipment = (field, category, predicate) => {
    const entry = slot[field];
    if (!entry || (!entry.instance_id && !entry.item_id)) return null;
    const matches = character.inv.instancedItems.filter(
      (item) => item.instanceId === entry.instance_id,
    );
    if (matches.length !== 1)
      throw Error(
        "Saved " +
          field +
          " instance was not found uniquely in this character's inventory.",
      );
    const owned = matches[0];
    // Native loadouts resolve instance_id. Older tools may leave a stale item_id hint.
    const i = reverse(category, owned.catalogId, predicate);
    const savedLevel = metadata(owned.itemData).CurrentLevel ?? 0;
    if (savedLevel !== 0 && savedLevel !== 1)
      throw Error(
        "The Builder cannot represent the saved level of " +
          owned.catalogId +
          ".",
      );
    return {
      i,
      level: savedLevel,
      id: owned.catalogId,
      meta: metadata(entry.instance_data),
    };
  };
  const weapon = equipment("weapon", "weapons");
  if (!weapon)
    throw Error(
      "This preset has no equipped weapon. Equip and save a weapon in the game first.",
    );
  state.w = weapon.i;
  state.wl = weapon.level;
  const readCells = (gear, sockets) => {
    if (!gear) return;
    if (gear.meta.EquippedCellsv2?.length)
      throw Error("This preset uses an unsupported cell metadata format.");
    const used = new Set();
    for (const cell of gear.meta.EquippedCells || []) {
      if (!cell.CellID || cell.CellID === "None") continue;
      if (
        !Number.isSafeInteger(cell.SlotIndex) ||
        !sockets[cell.SlotIndex] ||
        used.has(cell.SlotIndex)
      )
        throw Error("Invalid or duplicate saved cell socket.");
      used.add(cell.SlotIndex);
      let found;
      for (let i = 0; i < data.cells.length; i++) {
        const ids =
          version === "1.14.7"
            ? mappings.cells[data.cells[i].key]
            : ["C", "UC", "E"].map((suffix) =>
                mappings.cells[i]?.replace(/_E$/, "_" + suffix),
              );
        const rank = ids?.indexOf(cell.CellID);
        if (rank >= 0) {
          if (found) throw Error("Ambiguous saved cell: " + cell.CellID);
          found = [i, rank];
        }
      }
      if (!found)
        throw Error(
          "The " +
            version +
            " Builder cannot represent cell " +
            cell.CellID +
            ". No code was exported.",
        );
      state.cells[sockets[cell.SlotIndex]] = found;
    }
  };
  readCells(weapon, ["w0", "w1"]);
  for (const name of ARMOUR) {
    const gear = equipment(
      fields[name],
      "armours",
      (item) => item.type === name,
    );
    if (gear) state.a[name] = { i: gear.i, l: gear.level };
    readCells(gear, [name]);
  }
  const lantern = equipment("lantern", "lanterns");
  if (lantern) state.lan = lantern.i;
  readCells(lantern, ["lan"]);
  if (version === "1.14.7") {
    const omni = equipment("player_role", "omnicells");
    if (omni) state.omni = omni.i;
  }
  const repeater = weapon.id.startsWith("WP_DP_");
  const subtype = repeater
    ? version === "1.6.2"
      ? "subtype_dp_" + weapon.id
      : "subtype_ac"
    : subtypes[weapon.id.split("_")[1]];
  const blocks = (weapon.meta.SubTypeMetadataArray || []).filter(
    (block) => block.ItemSubType === subtype,
  );
  if (blocks.length > 1) throw Error("Duplicate saved weapon metadata.");
  const order = repeater
    ? version === "1.6.2"
      ? ["barrels", "chambers", "grips", "mods", "prisms"]
      : ["chambers", "grips", "mods"]
    : ["specials", "mods"];
  const used = new Set();
  for (const part of blocks[0]?.EquippedItemParts || []) {
    const id = part.WeaponPartId;
    if (!id || id === "None") continue;
    if (!Number.isSafeInteger(part.SlotIndex) || used.has(part.SlotIndex))
      throw Error("Invalid or duplicate saved weapon-part socket.");
    used.add(part.SlotIndex);
    if (
      part.SlotIndex === 3 &&
      (id.startsWith("WP_") ||
        (version === "1.6.2" && id.startsWith("PART_SOUL_WP_")))
    ) {
      state.bond = reverse("weapons", id.replace(/^PART_SOUL_/, ""));
    } else if (/^PART_[A-Z]+_LEGENDARY_/.test(id)) {
      const expected =
        "PART_" +
        weapon.id.split("_")[1] +
        "_LEGENDARY_" +
        data.weapons[weapon.i].bond?.elemental?.toUpperCase();
      if (id !== expected || part.SlotIndex !== (repeater ? 4 : 2))
        throw Error(
          "The Builder cannot represent this saved legendary ability: " + id,
        );
      // The Builder derives the ability from the legendary weapon itself.
    } else {
      const kind = order[part.SlotIndex];
      if (!kind) throw Error("Unsupported saved weapon-part slot.");
      state.parts[kind] = reverse(
        "parts",
        id,
        (item) => item.partKind === kind,
      );
    }
  }
  const code = encodeBuild(state, version, data);
  // Use the same decoder and validation as the Builder before returning a shareable code.
  decodeBuild(code, datasets);
  const name = slot.custom_name || "Equipment preset " + (index + 1);
  return {
    code,
    version,
    slot: index,
    name,
    file: { format: "dauntless-local-build", schema: 1, version, name, code },
    summary: {
      weapon: data.weapons[state.w].name,
      armour: ARMOUR.map(
        (key) => data.armours[state.a[key].i]?.name || "Unequipped",
      ),
      lantern: data.lanterns[state.lan]?.name || "Unequipped",
      omnicell: data.omnicells?.[state.omni]?.name || null,
      bond: data.weapons[state.bond]?.name || null,
      cells: Object.keys(state.cells).length,
    },
  };
}

function fromSave(connection, request) {
  const saves = require("./saves.cjs");
  if (connection.version === "1.14.7") {
    const fs = require("node:fs");
    return exportPreset(
      saves.jsonCharacters(
        JSON.parse(
          fs.readFileSync(connection.file, "utf8").replace(/^\uFEFF/, ""),
        ),
        connection.root,
      ),
      request,
      connection.version,
    );
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(connection.file, { readOnly: true });
  try {
    return exportPreset(
      saves.databaseCharacters(db, connection.root),
      request,
      connection.version,
    );
  } finally {
    db.close();
  }
}
module.exports = { exportPreset, fromSave };
