// Only the user-selected, existing slot is replaced. Other slots stay byte-for-byte equivalent.
"use strict";
const { parseData } = require("./inventory.cjs");

const SUBTYPES = {
  EB: "subtype_eblade",
  IH: "subtype_ihammer",
  GA: "subtype_gaxe",
  CB: "subtype_blades",
  MS: "subtype_msspear",
  AC: "subtype_ac",
  DP: "subtype_dualpistols",
};

function slotSummary(loadouts) {
  if (!Array.isArray(loadouts)) return [];
  return loadouts
    .map((slot, index) =>
      slot && typeof slot === "object"
        ? { index, name: slot.custom_name || "Loadout " + (index + 1) }
        : null,
    )
    .filter(Boolean);
}

function equipBuild(loadouts, selectedIndex, plan, inventory) {
  if (
    !Array.isArray(loadouts) ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    !loadouts[selectedIndex]
  ) {
    throw Error(
      "Explicitly select one of the character’s existing loadout slots.",
    );
  }
  const result = structuredClone(loadouts);
  const slot = result[selectedIndex];
  const modern = plan.sourceVersion === "1.14.7";
  if (modern) {
    // A missing omnicell or bond means unequipped, not inherited from the old build.
    slot.player_role = null;
    slot.subweapon = null;
  }
  for (const gear of plan.gear) {
    if (modern && gear.slot === "bond") continue;
    const owned = inventory.instancedItems.find(
      (row) =>
        row.catalogId === gear.id &&
        (!modern || row.instanceId === plan.instances[gear.slot]),
    );
    if (!owned) throw Error("Missing equipment: " + gear.id);
    // Preserve dyes, transmogs and all unrelated per-slot metadata.
    const previous = slot[gear.slot] || {};
    const data = parseData(previous.instance_data);
    data.EquippedCells = plan.cells
      .filter((cell) => cell.slot === gear.slot)
      .map((cell) => ({ CellID: cell.id, SlotIndex: cell.index }));
    data.EquippedCellsv2 = [];
    if (gear.slot === "weapon") {
      const subtype =
        modern && gear.id.startsWith("WP_DP_")
          ? "subtype_ac"
          : gear.id.startsWith("WP_DP_")
            ? "subtype_dp_" + gear.id
            : SUBTYPES[gear.id.split("_")[1]];
      if (!subtype) throw Error("Unsupported weapon subtype.");
      const oldTypes = Array.isArray(data.SubTypeMetadataArray)
        ? data.SubTypeMetadataArray
        : [];
      const oldType = oldTypes.find((row) => row.ItemSubType === subtype) || {};
      // Part slots are local to the weapon's part list: special first, mod second.
      // Repeater parts have their own barrel/chamber/grip/mod/prism order.
      const order =
        modern && gear.id.startsWith("WP_DP_")
          ? ["chambers", "grips", "mods"]
          : gear.id.startsWith("WP_DP_")
            ? ["barrels", "chambers", "grips", "mods", "prisms"]
            : ["specials", "mods"];
      const equipped = plan.parts.map((part) => ({
        WeaponPartId: part.id,
        SlotIndex: order.indexOf(part.kind),
      }));
      if (modern && plan.legendaryPart) {
        equipped.push({
          WeaponPartId: plan.legendaryPart,
          SlotIndex: gear.id.startsWith("WP_DP_") ? 4 : 2,
        });
        const bond = plan.gear.find((g) => g.slot === "bond");
        if (bond) equipped.push({ WeaponPartId: bond.id, SlotIndex: 3 });
      }
      if (equipped.some((part) => part.SlotIndex < 0))
        throw Error("Unsupported weapon-part slot.");
      data.SubTypeMetadataArray = [
        ...oldTypes.filter((row) => row.ItemSubType !== subtype),
        { ...oldType, ItemSubType: subtype, EquippedItemParts: equipped },
      ];
    }
    slot[gear.slot] = {
      ...previous,
      item_id: gear.id,
      instance_id: owned.instanceId,
      instance_data: JSON.stringify(data),
    };
  }
  slot.slot_index = selectedIndex;
  slot.update_version = (slot.update_version || 0) + 1;
  return result;
}

module.exports = { slotSummary, equipBuild };
