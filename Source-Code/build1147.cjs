// SPDX-License-Identifier: AGPL-3.0-only
// Import the local Builder's versioned format using identifiers checked against
// the installed CL647472 catalogues and English localization, never legacy indexes.
"use strict";
const crypto = require("node:crypto");
const data = require("./data/modern/builder1147.json");
const mappings = require("./data/modern/mappings.json");
const { decodeBuild, ARMOUR } = require("./data/modern/build-code.mjs");
const { byVersion, parseData } = require("./inventory.cjs");
const slots = { Head: "helmet", Torso: "chest", Arms: "arms", Legs: "legs" };

function isModernCode(input) {
  if (typeof input !== "string") return false;
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    try {
      code = decodeURIComponent(new URL(code).hash.slice(1));
    } catch {
      return false;
    }
  }
  return /^#?(?:b\.)?1147\./.test(code);
}

function planModernBuild(input, version) {
  if (version !== "1.14.7")
    throw Error("A 1.14.7 build requires a 1.14.7 character.");
  const { state } = decodeBuild(input, { "1.14.7": data });
  const plan = {
    version,
    sourceVersion: version,
    gear: [],
    cells: [],
    parts: [],
    changes: {},
    issues: [],
  };
  const get = (category, index, rank) => {
    if (index < 0) return null;
    const source = data[category][index];
    const mapped = mappings[category][source.key];
    const id = rank ? mapped?.[rank - 1] : mapped;
    const item = byVersion[version].get(id);
    if (!item?.editable) {
      plan.issues.push(source.name + ": no verified native 1.14.7 identifier.");
      return null;
    }
    return { id, name: source.name };
  };
  const addGear = (category, index, slot, level = 0) => {
    const item = get(category, index);
    if (item) {
      plan.gear.push({ ...item, slot, level });
      plan.changes[item.id] = 1;
    }
  };
  addGear("weapons", state.w, "weapon", state.wl);
  for (const key of ARMOUR)
    addGear("armours", state.a[key].i, slots[key], state.a[key].l);
  addGear("lanterns", state.lan, "lantern");
  addGear("omnicells", state.omni, "player_role");
  addGear("weapons", state.bond, "bond", state.wl);
  const weapon = data.weapons[state.w];
  if (weapon?.bond) {
    const id = mappings.weapons[weapon.key];
    const ability =
      "PART_" +
      id?.split("_")[1] +
      "_LEGENDARY_" +
      weapon.bond.elemental.toUpperCase();
    if (!byVersion[version].get(ability)?.editable)
      plan.issues.push("Unverified legendary ability: " + weapon.name);
    else {
      plan.legendaryPart = ability;
      plan.changes[ability] = 1;
    }
  }
  for (const [socket, [index, variant]] of Object.entries(state.cells)) {
    const item = get("cells", index, variant + 1);
    if (!item) continue;
    plan.cells.push({
      ...item,
      slot: socket.startsWith("w")
        ? "weapon"
        : socket === "lan"
          ? "lantern"
          : slots[socket],
      index: socket === "w1" ? 1 : 0,
      rank: variant + 1,
    });
    plan.changes[item.id] = (plan.changes[item.id] || 0) + 1;
  }
  for (const [kind, index] of Object.entries(state.parts)) {
    const item = get("parts", index);
    if (item) {
      plan.parts.push({ ...item, kind });
      plan.changes[item.id] = 1;
    }
  }
  if (!plan.gear.some((g) => g.slot === "weapon"))
    plan.issues.push("Choose a weapon before importing.");
  plan.compatible = plan.issues.length === 0;
  plan.note =
    "Native 1.14.7 build. Uses the Builder's selected levels and cell ranks. Only the selected slot is replaced; existing equipment instances are preserved.";
  return plan;
}

// Reuse an instance only when its level already matches. Never upgrade an
// instance referenced by another loadout just to import a different build.
function prepareModernInstances(inventory, plan) {
  const inv = structuredClone(inventory);
  const instances = {};
  for (const gear of plan.gear) {
    let owned = inv.instancedItems.find(
      (row) =>
        row.catalogId === gear.id &&
        (parseData(row.itemData).CurrentLevel || 0) === gear.level,
    );
    if (!owned) {
      owned = {
        catalogId: gear.id,
        instanceId: crypto.randomUUID(),
        updateVersion: 0,
        itemData: JSON.stringify({
          CurrentLevel: gear.level,
          CurrentXP: 0,
          UnlockedAsTransmog: true,
          EquippedWeaponParts: [],
        }),
      };
      inv.instancedItems.push(owned);
    }
    instances[gear.slot] = owned.instanceId;
  }
  return { inv, instances };
}
module.exports = { isModernCode, planModernBuild, prepareModernInstances };
