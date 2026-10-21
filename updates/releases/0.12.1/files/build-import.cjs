// Decode the public Builder's 162.base64url format. No remote code is executed.
"use strict";
const builder = require("./data/builder.json");
const { byVersion } = require("./inventory.cjs");
const ARMOUR = ["Head", "Torso", "Arms", "Legs"];
const SLOTS = { Head: "helmet", Torso: "chest", Arms: "arms", Legs: "legs" };
const PARTS = ["mods", "specials", "barrels", "chambers", "grips", "prisms"];
const WEAPON_TYPES = {
  "Aether Strikers": "aetherstrikers",
  Axe: "axe",
  "Chain Blades": "chainblades",
  Hammer: "hammer",
  Repeater: "repeater",
  Sword: "sword",
  "War Pike": "warpike",
};

function decode(input) {
  if (typeof input !== "string" || input.length > 16000)
    throw Error("Invalid build code.");
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    const url = new URL(code);
    if (url.hostname !== "builder.dauntlessforever.com")
      throw Error("Paste a Dauntless Forever Builder link.");
    code = decodeURIComponent(url.hash.slice(1));
  }
  code = code.replace(/^#?b\./, "").replace(/^162\./, "");
  if (!/^[A-Za-z0-9_-]+$/.test(code))
    throw Error(
      "Missing build code. Copy a 162.… code or a shared link containing #.",
    );
  let values;
  try {
    values = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    throw Error("Could not decode the build code.");
  }
  if (Array.isArray(values) && values.length === 7)
    throw Error(
      "This code preserves a 1.6.2 legendary bond. Open it in the updated local Builder. Importing legacy bonds into the game is not supported.",
    );
  if (
    !Array.isArray(values) ||
    values.length !== 6 ||
    !Array.isArray(values[2]) ||
    !Array.isArray(values[3]) ||
    !Array.isArray(values[5])
  )
    throw Error("Unrecognized build structure.");
  return values;
}

function planBuild(input, version) {
  const modern = require("./build1147.cjs");
  if (modern.isModernCode(input)) return modern.planModernBuild(input, version);
  const values = decode(input);
  const catalog = byVersion[version];
  if (!catalog) throw Error("Unsupported version.");
  const gear = [],
    cells = [],
    parts = [],
    issues = [],
    changes = {};
  const lookup = (category, index) => {
    if (index === -1 || index == null) return null;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= builder.data[category].length
    )
      throw Error("Invalid " + category + " index.");
    const source = builder.data[category][index];
    const id = builder.mappings[category][index];
    const item = id ? catalog.get(id) : null;
    if (!item || !item.editable) {
      issues.push(source.name + ": no verified match in " + version);
      return { source };
    }
    return { source, item };
  };
  const addGear = (category, index, slot) => {
    const found = lookup(category, index);
    if (found?.item) {
      gear.push({
        id: found.item.id,
        name: found.source.name,
        slot,
        level: found.item.maxLevel,
      });
      changes[found.item.id] = 1;
    }
    return found;
  };
  const weapon = addGear("weapons", values[0], "weapon");
  ARMOUR.forEach((kind, index) => {
    const record = values[3][index];
    if (!Array.isArray(record) || record.length !== 2)
      throw Error("Invalid armour slot.");
    const found = addGear("armours", record[0], SLOTS[kind]);
    if (found && found.source.type !== kind)
      issues.push("Wrong armour type in slot " + kind);
  });
  const lantern = addGear("lanterns", values[4], "lantern");
  const keys = ["w0", "w1", ...ARMOUR, "lan"];
  values[5].forEach((packed, index) => {
    if (packed === -1) return;
    if (!Number.isInteger(packed) || packed < 0 || index >= keys.length)
      throw Error("Invalid cell in the build.");
    const found = lookup("cells", Math.floor(packed / 3));
    const key = keys[index];
    const owner =
      key[0] === "w"
        ? weapon
        : key === "lan"
          ? lantern
          : lookup("armours", values[3][ARMOUR.indexOf(key)]?.[0]);
    const socket =
      key === "w0"
        ? weapon?.source.cells?.[0]
        : key === "w1"
          ? weapon?.source.cells?.[1]
          : owner?.source.cells;
    if (!socket || (socket !== "Prismatic" && socket !== found?.source.slot))
      issues.push("Cell does not fit socket " + key);
    if (found?.item) {
      const slot =
        key[0] === "w" ? "weapon" : key === "lan" ? "lantern" : SLOTS[key];
      cells.push({
        id: found.item.id,
        name: found.source.name,
        slot,
        index: key === "w1" ? 1 : 0,
        rank: 3,
      });
      changes[found.item.id] = (changes[found.item.id] || 0) + 1;
    }
  });
  values[2].forEach((index, position) => {
    if (position >= PARTS.length)
      throw Error("Invalid number of weapon parts.");
    const found = lookup("parts", index);
    if (!found) return;
    const kind = PARTS[position];
    if (
      !weapon ||
      found.source.weaponType !== WEAPON_TYPES[weapon.source.type] ||
      found.source.partKind !== kind ||
      (kind === "specials" && weapon.source.restrict_specials) ||
      (weapon.source.type === "Repeater" &&
        weapon.source.rarity === "exotic" &&
        kind !== "mods")
    )
      issues.push("Incompatible weapon part: " + found.source.name);
    if (found.item) {
      parts.push({ id: found.item.id, name: found.source.name, kind });
      changes[found.item.id] = 1;
    }
  });
  if (version === "1.14.7")
    issues.push(
      "Importing 1.6.2 builds into 1.14.7 is disabled: the native client rejected legacy cells and equipment stats during validation. Use the 1.14.7 inventory editor and equip a build in-game.",
    );
  if (!gear.length) issues.push("The build contains no importable equipment.");
  if (version !== "1.6.2" && weapon?.source.type === "Repeater")
    issues.push(
      "Version 1.14.7 uses a different repeater system. This conversion is not supported.",
    );
  return {
    version,
    sourceVersion: "1.6.2",
    gear,
    cells,
    parts,
    changes,
    issues,
    compatible: issues.length === 0,
    note:
      version === "1.6.2"
        ? "Weapons and armour at their available Power Surge level; cells upgraded to +3."
        : "Conversion disabled: legacy cells and equipment stats failed native 1.14.7 validation.",
  };
}

module.exports = { decode, planBuild };
