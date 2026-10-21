"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyItems, byVersion } = require("../inventory.cjs");
const gearData = require("../data/modern/builder1147.json");
const mappings = require("../data/modern/mappings.json");

test("1.6.2 upgrades every owned instance, retains metadata and leaves maximum instances stable on repeat", () => {
  const original = {
    stackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 123 }],
    instancedItems: [
      {
        catalogId: "WP_EB_LAVAROLLER",
        instanceId: "first",
        updateVersion: 3,
        itemData: JSON.stringify({
          CurrentLevel: 0,
          CurrentXP: 24,
          custom: "first",
          EquippedWeaponParts: [{ id: "retain" }],
        }),
      },
      {
        catalogId: "WP_EB_LAVAROLLER",
        instanceId: "equipped-second",
        updateVersion: 7,
        itemData: JSON.stringify({
          CurrentLevel: 0,
          CurrentXP: 12,
          custom: "second",
        }),
      },
      {
        catalogId: "WP_EB_TRAINING",
        instanceId: "unselected",
        itemData: null,
        updateVersion: 0,
      },
    ],
  };
  const unchanged = structuredClone(original);
  const upgraded = applyItems(
    original,
    { WP_EB_LAVAROLLER: 1 },
    "set",
    "1.6.2",
    true,
  );
  assert.deepEqual(original, unchanged);
  assert.equal(upgraded.instancedItems.length, 3);
  for (let i = 0; i < 2; i++) {
    const before = original.instancedItems[i],
      after = upgraded.instancedItems[i];
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.updateVersion, before.updateVersion + 1);
    assert.deepEqual(JSON.parse(after.itemData), {
      ...JSON.parse(before.itemData),
      CurrentLevel: 1,
      CurrentXP: 0,
    });
  }
  assert.deepEqual(upgraded.instancedItems[2], original.instancedItems[2]);
  assert.deepEqual(upgraded.stackedItems, original.stackedItems);
  assert.deepEqual(
    applyItems(upgraded, { WP_EB_LAVAROLLER: 1 }, "set", "1.6.2", true),
    upgraded,
  );
});

test("1.14.7 upgrades all owned copies to native Power Surge, preserving parts and unrelated gear; repeat is idempotent", () => {
  const inventory = {
    stackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 123 }],
    instancedItems: [
      {
        catalogId: "WP_EB_THUNDERBIRD",
        instanceId: "base",
        updateVersion: 4,
        itemData: JSON.stringify({
          CurrentLevel: 0,
          CurrentXP: 42,
          EquippedWeaponParts: [{ custom: true }],
          custom: "keep",
        }),
      },
      {
        catalogId: "WP_EB_THUNDERBIRD",
        instanceId: "old-invalid",
        updateVersion: 2,
        itemData: '{"CurrentLevel":15}',
      },
      {
        catalogId: "WP_EB_LAVAROLLER",
        instanceId: "unrelated",
        itemData: '{"CurrentLevel":0}',
      },
    ],
  };
  const before = structuredClone(inventory);
  const upgraded = applyItems(
    inventory,
    { WP_EB_THUNDERBIRD: 1 },
    "set",
    "1.14.7",
    true,
  );
  assert.deepEqual(inventory, before);
  assert.deepEqual(upgraded.stackedItems, before.stackedItems);
  assert.deepEqual(upgraded.instancedItems[2], before.instancedItems[2]);
  for (const row of upgraded.instancedItems.slice(0, 2))
    assert.equal(JSON.parse(row.itemData).CurrentLevel, 1);
  assert.deepEqual(
    JSON.parse(upgraded.instancedItems[0].itemData).EquippedWeaponParts,
    [{ custom: true }],
  );
  assert.equal(JSON.parse(upgraded.instancedItems[0].itemData).custom, "keep");
  assert.equal(upgraded.instancedItems[0].instanceId, "base");
  assert.equal(upgraded.instancedItems[0].updateVersion, 5);
  assert.deepEqual(
    applyItems(upgraded, { WP_EB_THUNDERBIRD: 1 }, "set", "1.14.7", true),
    upgraded,
  );
});

test("Every verified modern weapon and armour grant uses its native maximum; starter gear remains at level 0", () => {
  for (const id of new Set(
    [
      ...Object.values(mappings.weapons),
      ...Object.values(mappings.armours),
    ].filter(Boolean),
  )) {
    const empty = { stackedItems: [], instancedItems: [] };
    if (!byVersion["1.14.7"].get(id)?.editable) {
      assert.throws(
        () => applyItems(empty, { [id]: 1 }, "set", "1.14.7", true),
        /cannot be edited/,
      );
      assert.deepEqual(empty, { stackedItems: [], instancedItems: [] });
      continue;
    }
    const upgraded = applyItems(empty, { [id]: 1 }, "set", "1.14.7", true);
    const source = [...gearData.weapons, ...gearData.armours].find(
      (item) =>
        mappings.weapons[item.key] === id || mappings.armours[item.key] === id,
    );
    const maximum = Math.max(
      ...Object.keys(source.power || source.resistance).map(Number),
    );
    assert.equal(
      JSON.parse(upgraded.instancedItems[0].itemData).CurrentLevel,
      maximum,
      id,
    );
    assert.equal(
      JSON.parse(upgraded.instancedItems[0].itemData).CurrentXP,
      0,
      id,
    );
    const base = applyItems(empty, { [id]: 1 }, "set", "1.14.7", false);
    assert.equal(base.instancedItems[0].itemData, null);
  }
});
