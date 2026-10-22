// Inventory rules. Stackable items have quantities; equipment has unique instances.
"use strict";
const crypto = require("node:crypto");
const catalogs = require("./data/catalogs.json");
const modernMappings = require("./data/modern/mappings.json");
const modernGear = require("./data/modern/builder1147.json");
const modernMaximumLevels = new Map(
  ["weapons", "armours"].flatMap((group) =>
    modernGear[group].flatMap((item) => {
      const id = modernMappings[group][item.key];
      const levels = Object.keys(item.power || item.resistance || {}).map(
        Number,
      );
      return id &&
        levels.length &&
        levels.every((level) => level === 0 || level === 1)
        ? [[id, Math.max(...levels)]]
        : [];
    }),
  ),
);
const byVersion = Object.fromEntries(
  Object.entries(catalogs).map(([version, rows]) => [
    version,
    new Map(rows.map((row) => [row.id, row])),
  ]),
);

function requireItem(version, id) {
  const item = byVersion[version]?.get(id);
  if (!item || !item.editable)
    throw Error("This item cannot be edited in this version: " + id);
  return item;
}

function parseData(raw) {
  if (raw == null || raw === "") return {};
  const data = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("Unrecognized equipment data.");
  return data;
}

function applyItems(inventory, changes, mode, version, maximize = false) {
  const stacks = structuredClone(inventory.stackedItems || []);
  const instances = structuredClone(inventory.instancedItems || []);
  for (const [id, requested] of Object.entries(changes)) {
    const item = requireItem(version, id);
    if (
      !Number.isSafeInteger(requested) ||
      requested < 0 ||
      requested > 99999999
    )
      throw Error("Invalid quantity: " + id);
    if (
      maximize &&
      version === "1.14.7" &&
      !item.cosmetic &&
      ["Weapons", "Armour"].includes(item.group) &&
      !modernMaximumLevels.has(id)
    )
      throw Error(
        "No verified Power Surge level for " +
          item.name +
          ". Uncheck the upgrade option for this item.",
      );
    if (item.storage === "stack") {
      const present = stacks.filter((row) => row.catalogId === id);
      const before = present.reduce((sum, row) => sum + row.quantity, 0);
      let amount = mode === "add" ? before + requested : requested;
      if (item.singleton) amount = Math.min(1, amount);
      if (!Number.isSafeInteger(amount) || amount > 99999999)
        throw Error("Quantity limit exceeded: " + id);
      for (let i = stacks.length - 1; i >= 0; i--)
        if (stacks[i].catalogId === id) stacks.splice(i, 1);
      if (amount > 0) stacks.push({ catalogId: id, quantity: amount });
    } else {
      // This editor grants equipment; it never removes an instance used by another slot.
      if (requested === 0)
        throw Error(
          "Equipment quantity must be 1. Removing equipment instances is not supported.",
        );
      let owned = instances.filter((row) => row.catalogId === id);
      if (!owned.length) {
        const instanceId = instances.some((row) => row.instanceId === id)
          ? crypto.randomUUID()
          : id;
        const created = {
          catalogId: id,
          instanceId,
          itemData: null,
          updateVersion: 0,
        };
        instances.push(created);
        owned = [created];
      }
      if (
        maximize &&
        version === "1.14.7" &&
        modernMaximumLevels.has(id) &&
        !item.cosmetic
      ) {
        // Reforged uses Base=0 / Power Surge=1, not crafting levels 10 or 15.
        // Update each owned copy so an equipped instance is never missed.
        for (const target of owned) {
          const data = parseData(target.itemData);
          const maximum = modernMaximumLevels.get(id);
          if (data.CurrentLevel === maximum && data.CurrentXP === 0) continue;
          if (target.itemData == null) {
            data.UnlockedAsTransmog = true;
            data.EquippedWeaponParts = [];
          }
          data.CurrentLevel = maximum;
          data.CurrentXP = 0;
          target.itemData = JSON.stringify(data);
          target.updateVersion = (target.updateVersion || 0) + 1;
        }
      } else if (maximize && item.maxLevel != null && !item.cosmetic) {
        for (const target of owned) {
          const data = parseData(target.itemData);
          if (data.CurrentLevel === item.maxLevel && data.CurrentXP === 0)
            continue;
          data.CurrentLevel = item.maxLevel;
          data.CurrentXP = 0;
          target.itemData = JSON.stringify(data);
          target.updateVersion = (target.updateVersion || 0) + 1;
        }
      }
    }
  }
  return { ...inventory, stackedItems: stacks, instancedItems: instances };
}

module.exports = { catalogs, byVersion, requireItem, applyItems, parseData };
