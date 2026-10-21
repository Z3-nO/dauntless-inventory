"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { equipBuild } = require("../loadouts.cjs");
const expected = {
  EB: "subtype_eblade",
  IH: "subtype_ihammer",
  GA: "subtype_gaxe",
  CB: "subtype_blades",
  MS: "subtype_msspear",
  AC: "subtype_ac",
  DP: "subtype_dp_WP_DP_OSTIAN",
};
for (const [type, subtype] of Object.entries(expected))
  test("Native loadout schema: " + type, () => {
    const id = type === "DP" ? "WP_DP_OSTIAN" : "WP_" + type + "_TEST";
    const plan = {
      gear: [{ id, slot: "weapon" }],
      cells: [],
      parts: [
        { id: "PART_TEST", kind: type === "DP" ? "barrels" : "specials" },
      ],
    };
    const inv = { instancedItems: [{ catalogId: id, instanceId: id }] };
    const previous = [
      {
        slot_index: 0,
        weapon: {
          instance_data: JSON.stringify({
            PrimaryDyeId: "retain",
            SubTypeMetadataArray: [
              { ItemSubType: subtype, EquippedItemParts: [] },
            ],
          }),
        },
      },
      { marker: "untouched" },
    ];
    const result = equipBuild(previous, 0, plan, inv),
      data = JSON.parse(result[0].weapon.instance_data);
    const parts = data.SubTypeMetadataArray.find(
      (x) => x.ItemSubType === subtype,
    )?.EquippedItemParts;
    assert.equal(
      data.SubTypeMetadataArray.filter((x) => x.ItemSubType === subtype).length,
      1,
    );
    assert.deepEqual(parts, [{ WeaponPartId: "PART_TEST", SlotIndex: 0 }]);
    assert.equal(data.PrimaryDyeId, "retain");
    assert.deepEqual(result[1], previous[1]);
  });

const { applyItems } = require("../inventory.cjs");
test("1.14.7 unverified maximum upgrades fail before modifying inventory", () => {
  const inv = { stackedItems: [], instancedItems: [] };
  assert.throws(
    () => applyItems(inv, { WP_AC_SPRINGTIDE_L10R: 1 }, "add", "1.14.7", true),
    /No verified Power Surge/,
  );
  assert.deepEqual(inv, { stackedItems: [], instancedItems: [] });
  const granted = applyItems(
    inv,
    { WP_EB_TRAINING: 1 },
    "add",
    "1.14.7",
    false,
  );
  assert.equal(granted.instancedItems[0].itemData, null);
});

test("1.6.2 maximize repairs an out-of-range legacy upgrade value", () => {
  const inv = {
    stackedItems: [],
    instancedItems: [
      {
        catalogId: "WP_EB_LAVAROLLER",
        instanceId: "weapon",
        itemData: JSON.stringify({ CurrentLevel: 15, custom: "retain" }),
      },
    ],
  };
  const fixed = applyItems(inv, { WP_EB_LAVAROLLER: 1 }, "set", "1.6.2", true);
  assert.deepEqual(JSON.parse(fixed.instancedItems[0].itemData), {
    CurrentLevel: 1,
    custom: "retain",
    CurrentXP: 0,
  });
  assert.equal(JSON.parse(inv.instancedItems[0].itemData).CurrentLevel, 15);
});
