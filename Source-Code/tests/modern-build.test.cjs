// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const data = require("../data/modern/builder1147.json");
const mapping = require("../data/modern/mappings.json");
const { emptyBuild, encodeBuild } = require("../data/modern/build-code.mjs");
const { planBuild } = require("../build-import.cjs");
const { prepareModernInstances } = require("../build1147.cjs");
const { equipBuild } = require("../loadouts.cjs");
function example() {
  const s = emptyBuild();
  s.w = data.weapons.findIndex((x) => x.name === "Cyclonic Fury");
  s.bond = data.weapons.findIndex((x) => x.name === "Sahvyt's Cutlass");
  s.omni = data.omnicells.findIndex((x) => x.name === "Discipline");
  s.cells.w0 = [data.cells.findIndex((x) => x.name === "Pulse Cell"), 2];
  return encodeBuild(s, "1.14.7", data);
}
test("Modern format maps native Pulse, omnicell, legendary ability and bond; wrong version is rejected", () => {
  const p = planBuild(example(), "1.14.7");
  assert.equal(p.compatible, true);
  assert.equal(p.cells[0].id, "CELL_RHYTHMIC_E");
  assert.equal(p.cells[0].rank, 3);
  assert.equal(p.legendaryPart, "PART_EB_LEGENDARY_SHOCK");
  assert.ok(p.gear.some((g) => g.id === "PR_DISCIPLINE"));
  assert.throws(() => planBuild(example(), "1.6.2"), /1.14.7/);
});
test("All modern cell ranks map to distinct native items; every supported modern weapon decodes", () => {
  for (const c of data.cells) {
    assert.equal(new Set(mapping.cells[c.key]).size, 3);
    assert.ok(mapping.cells[c.key].every(Boolean));
  }
  for (const w of data.weapons) {
    const s = emptyBuild();
    s.w = data.weapons.indexOf(w);
    s.wl = Object.hasOwn(w.power, 1) ? 1 : 0;
    const p = planBuild(encodeBuild(s, "1.14.7", data), "1.14.7");
    assert.equal(p.compatible, Boolean(mapping.weapons[w.key]), w.name);
  }
});
test("Import preserves previous equipment instances, other slots, dyes and persistent settings; reimport reuses instances", () => {
  const p = planBuild(example(), "1.14.7");
  const original = {
    stackedItems: [],
    instancedItems: [
      {
        catalogId: "WP_EB_THUNDERBIRD",
        instanceId: "previous",
        itemData: '{"CurrentLevel":0,"keep":true}',
        updateVersion: 7,
      },
    ],
  };
  const prepared = prepareModernInstances(original, p);
  assert.deepEqual(prepared.inv.instancedItems[0], original.instancedItems[0]);
  assert.notEqual(prepared.instances.weapon, "previous");
  const loadouts = Array.from({ length: 6 }, (_, i) => ({
    slot_index: i,
    custom_name: "",
    persistent: { keep: i },
    weapon: { instance_data: '{"PrimaryDyeId":"keep"}' },
  }));
  const equipped = equipBuild(
    loadouts,
    5,
    { ...p, instances: prepared.instances },
    prepared.inv,
  );
  assert.deepEqual(equipped.slice(0, 5), loadouts.slice(0, 5));
  const meta = JSON.parse(equipped[5].weapon.instance_data);
  assert.equal(meta.PrimaryDyeId, "keep");
  const parts = meta.SubTypeMetadataArray.find(
    (x) => x.ItemSubType === "subtype_eblade",
  ).EquippedItemParts;
  assert.ok(
    parts.some((x) => x.WeaponPartId === "WP_EB_MANTIS" && x.SlotIndex === 3),
  );
  assert.equal(equipped[5].player_role.item_id, "PR_DISCIPLINE");
  assert.equal(equipped[5].subweapon, null);
  assert.deepEqual(prepareModernInstances(prepared.inv, p), prepared);
  assert.deepEqual(equipped[5].persistent, loadouts[5].persistent);
});
test("Invalid modern socket/rank and unknown keys fail before applying", () => {
  const raw = JSON.parse(Buffer.from(example().split(".")[1], "base64url"));
  raw.cells.w0[1] = 4;
  assert.throws(
    () =>
      planBuild(
        "1147." + Buffer.from(JSON.stringify(raw)).toString("base64url"),
        "1.14.7",
      ),
    /cell/,
  );
  raw.cells.w0[1] = 3;
  raw.weapon[0] = "weapons/unknown";
  assert.throws(
    () =>
      planBuild(
        "1147." + Buffer.from(JSON.stringify(raw)).toString("base64url"),
        "1.14.7",
      ),
    /Unknown/,
  );
});
test("Modern repeaters use the native shared subtype and chamber/grip/mod/bond/ability indices", () => {
  const state = emptyBuild();
  state.w = data.weapons.findIndex((x) => x.name === "Dynamic Deadlights");
  state.bond = data.weapons.findIndex((x) => x.name === "Sahvyt's Avengers");
  state.parts = Object.fromEntries(
    [
      ["chambers", "Marksman Chamber"],
      ["grips", "Captain's Grip"],
      ["mods", "Tactician's Magazine"],
    ].map(([kind, name]) => [
      kind,
      data.parts.findIndex((x) => x.name === name),
    ]),
  );
  const plan = planBuild(encodeBuild(state, "1.14.7", data), "1.14.7");
  const prepared = prepareModernInstances(
    { stackedItems: [], instancedItems: [] },
    plan,
  );
  const result = equipBuild(
    [{ slot_index: 0 }],
    0,
    { ...plan, instances: prepared.instances },
    prepared.inv,
  );
  const meta = JSON.parse(result[0].weapon.instance_data).SubTypeMetadataArray;
  assert.equal(meta[0].ItemSubType, "subtype_ac");
  const parts = meta[0].EquippedItemParts;
  assert.equal(
    parts.find((x) => x.WeaponPartId === "PART_DP_LEGENDARY_SHOCK").SlotIndex,
    4,
  );
  assert.equal(
    parts.find((x) => x.WeaponPartId === "WP_DP_MANTIS").SlotIndex,
    3,
  );
  for (const [kind, index] of [
    ["chambers", 0],
    ["grips", 1],
    ["mods", 2],
  ])
    assert.equal(
      parts.find(
        (x) => x.WeaponPartId === plan.parts.find((p) => p.kind === kind).id,
      ).SlotIndex,
      index,
    );
});
