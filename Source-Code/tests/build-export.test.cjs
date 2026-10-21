// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { exportPreset } = require("../build-export.cjs");
const legacy = require("../data/builder.json");
const modern = require("../data/modern/builder1147.json");
const {
  emptyBuild,
  encodeBuild,
  decodeBuild,
} = require("../data/modern/build-code.mjs");
const datasets = {
  "1.6.2": { ...legacy.data, version: "1.6.2" },
  "1.14.7": modern,
};
const { planBuild } = require("../build-import.cjs");
const { prepareModernInstances } = require("../build1147.cjs");
const { equipBuild } = require("../loadouts.cjs");
const { applyItems } = require("../inventory.cjs");
function fixture(version, state) {
  const plan = planBuild(
    encodeBuild(state, version, datasets[version]),
    version,
  );
  assert.equal(plan.compatible, true, plan.issues.join("; "));
  const empty = { stackedItems: [], instancedItems: [] };
  const prepared =
    version === "1.14.7"
      ? prepareModernInstances(empty, plan)
      : { inv: applyItems(empty, plan.changes, "add", version, true) };
  const slots = Array.from({ length: 8 }, (_, index) => ({
    slot_index: index,
    custom_name: "Preset " + (index + 1),
  }));
  const character = {
    id: "test-character",
    name: "Test Slayer",
    inv: prepared.inv,
    loadouts: equipBuild(
      slots,
      5,
      { ...plan, instances: prepared.instances },
      prepared.inv,
    ),
  };
  return {
    character,
    request: { version, character: character.id, slot: 5 },
    plan,
  };
}
function stateFor(version) {
  const s = emptyBuild(),
    data = datasets[version];
  s.w = data.weapons.findIndex(
    (x) =>
      x.name === (version === "1.6.2" ? "Inferno's Razor" : "Cyclonic Fury"),
  );
  for (const [slot, name] of Object.entries({
    Head: "Hellplate Casque",
    Torso: "Hellplate Cuirass",
    Arms: "Hellplate Bracers",
    Legs: "Hellplate Greaves",
  }))
    s.a[slot].i = data.armours.findIndex((x) => x.name === name);
  s.lan = data.lanterns.findIndex((x) => x.name === "Shrike's Zeal");
  if (version === "1.14.7") {
    s.bond = data.weapons.findIndex((x) => x.name === "Sahvyt's Cutlass");
    s.omni = data.omnicells.findIndex((x) => x.name === "Discipline");
    s.cells.w0 = [data.cells.findIndex((x) => x.name === "Pulse Cell"), 1];
  }
  for (const kind of ["specials", "mods"])
    s.parts[kind] = data.parts.findIndex(
      (x) => x.weaponType === "sword" && x.partKind === kind,
    );
  return s;
}
for (const version of Object.keys(datasets)) {
  test(
    "Export " +
      version +
      ": slot 6 round trip preserves equipment, cells, parts and inventory",
    () => {
      const f = fixture(version, stateFor(version)),
        before = structuredClone(f.character);
      const out = exportPreset([f.character], f.request, version),
        decoded = decodeBuild(out.file.code, datasets);
      assert.equal(decoded.version, version);
      assert.deepEqual(
        decoded.state,
        decodeBuild(
          encodeBuild(stateFor(version), version, datasets[version]),
          datasets,
        ).state,
      );
      assert.equal(out.file.format, "dauntless-local-build");
      assert.equal(out.file.schema, 1);
      assert.equal(out.file.version, version);
      assert.equal(out.slot, 5);
      assert.deepEqual(f.character, before);
    },
  );
  test(
    "Export " + version + ": every mapped weapon is readable by the Builder",
    () => {
      const data = datasets[version],
        mappings =
          version === "1.6.2"
            ? legacy.mappings
            : require("../data/modern/mappings.json");
      for (let w = 0; w < data.weapons.length; w++) {
        if (!mappings.weapons[version === "1.6.2" ? w : data.weapons[w].key])
          continue;
        const s = emptyBuild();
        s.w = w;
        s.wl =
          data.weapons[w].power && !Object.hasOwn(data.weapons[w].power, 1)
            ? 0
            : 1;
        const f = fixture(version, s),
          out = exportPreset([f.character], f.request, version);
        assert.equal(
          decodeBuild(out.code, datasets).state.w,
          w,
          data.weapons[w].name,
        );
      }
    },
  );
}
test("Export reads the exact saved instance level, never a different copy or cosmetic ID", () => {
  const f = fixture("1.14.7", stateFor("1.14.7")),
    weapon = f.character.inv.instancedItems.find(
      (x) => x.instanceId === f.character.loadouts[5].weapon.instance_id,
    );
  f.character.inv.instancedItems.unshift({
    ...weapon,
    instanceId: "other-copy",
    itemData: '{"CurrentLevel":0}',
  });
  const meta = JSON.parse(f.character.loadouts[5].weapon.instance_data);
  meta.TransmogCatalogId = "WP_EB_TRAINING";
  f.character.loadouts[5].weapon.instance_data = JSON.stringify(meta);
  assert.equal(
    decodeBuild(exportPreset([f.character], f.request, "1.14.7").code, datasets)
      .state.wl,
    1,
  );
  weapon.itemData = '{"CurrentLevel":0}';
  assert.equal(
    decodeBuild(exportPreset([f.character], f.request, "1.14.7").code, datasets)
      .state.wl,
    0,
  );
});
test("Legacy export preserves all three native cell ranks", () => {
  const f = fixture("1.6.2", stateFor("1.6.2")),
    cell = legacy.data.cells.findIndex(
      (x) => x.slot === legacy.data.weapons[stateFor("1.6.2").w].cells[1],
    );
  // Select a cell that matches the native weapon's second socket.
  for (const [rank, suffix] of ["C", "UC", "E"].entries()) {
    const entry = f.character.loadouts[5].weapon,
      meta = JSON.parse(entry.instance_data);
    meta.EquippedCells = [
      {
        CellID: legacy.mappings.cells[cell].replace(/_E$/, "_" + suffix),
        SlotIndex: 1,
      },
    ];
    entry.instance_data = JSON.stringify(meta);
    const state = decodeBuild(
      exportPreset([f.character], f.request, "1.6.2").code,
      datasets,
    ).state;
    assert.deepEqual(state.cells.w1, [cell, rank]);
  }
});
test("Export rejects wrong ownership, version, unsaved slot and unknown items without changing anything", () => {
  const f = fixture("1.14.7", stateFor("1.14.7")),
    before = structuredClone(f.character);
  for (const request of [
    { ...f.request, character: "other" },
    { ...f.request, version: "1.6.2" },
    { ...f.request, slot: 100 },
    { ...f.request, slot: "5" },
    { ...f.request, slot: -1 },
  ])
    assert.throws(() => exportPreset([f.character], request, "1.14.7"));
  assert.deepEqual(f.character, before);
  const entry = f.character.loadouts[5].weapon;
  entry.item_id = "UNKNOWN";
  assert.equal(
    decodeBuild(exportPreset([f.character], f.request, "1.14.7").code, datasets)
      .state.w,
    stateFor("1.14.7").w,
  );
  delete entry.item_id;
  entry.instance_id = "missing";
  assert.throws(
    () => exportPreset([f.character], f.request, "1.14.7"),
    /instance/,
  );
});
test("Export ignores cached metadata for other weapon types, rejects unsupported cells and duplicate sockets", () => {
  const f = fixture("1.14.7", stateFor("1.14.7")),
    entry = f.character.loadouts[5].weapon,
    meta = JSON.parse(entry.instance_data);
  meta.SubTypeMetadataArray.unshift({
    ItemSubType: "subtype_gaxe",
    EquippedItemParts: [{ WeaponPartId: "UNKNOWN", SlotIndex: 0 }],
  });
  entry.instance_data = JSON.stringify(meta);
  assert.ok(exportPreset([f.character], f.request, "1.14.7").code);
  meta.EquippedCells = [{ CellID: "UNKNOWN", SlotIndex: 0 }];
  entry.instance_data = JSON.stringify(meta);
  assert.throws(
    () => exportPreset([f.character], f.request, "1.14.7"),
    /cannot represent cell/,
  );
  meta.EquippedCells = [meta.EquippedCells[0], meta.EquippedCells[0]];
  meta.EquippedCells[0].CellID = "CELL_RHYTHMIC_E";
  entry.instance_data = JSON.stringify(meta);
  assert.throws(
    () => exportPreset([f.character], f.request, "1.14.7"),
    /duplicate/,
  );
});

test("Live export reads current server memory with authentication and no save, receipt or backup writes", (t) => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    crypto = require("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dauntless-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"));
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, "data/materiali-live.key"), key);
  for (const version of Object.keys(datasets)) {
    const f = fixture(version, stateFor(version));
    const adapter = {
      root,
      version,
      characters: () => [f.character],
      commit: () => assert.fail("Unexpected save"),
      receipts: () => assert.fail("Unexpected receipt"),
      saveReceipts: () => assert.fail("Unexpected receipt write"),
    };
    const runtime = require("../live-runtime.cjs").create(adapter);
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:63000", "x-materiali-live-key": key },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const identity = crypto
      .createHash("sha256")
      .update(JSON.stringify([path.resolve(root).toLowerCase(), version]))
      .digest("hex");
    const body = { identity, action: "build-export", request: f.request };
    assert.equal(
      runtime.admin(
        {
          ...req,
          headers: { ...req.headers, "x-materiali-live-key": "0".repeat(64) },
        },
        body,
      ).status,
      403,
    );
    const out = runtime.admin(req, body);
    assert.equal(out.status, 200);
    assert.equal(out.json.slot, 5);
    const owned = f.character.inv.instancedItems.find(
      (x) => x.instanceId === f.character.loadouts[5].weapon.instance_id,
    );
    owned.itemData = '{"CurrentLevel":0}';
    assert.equal(
      decodeBuild(runtime.admin(req, body).json.code, datasets).state.wl,
      0,
    );
    assert.deepEqual(fs.readdirSync(path.join(root, "data")), [
      "materiali-live.key",
    ]);
  }
});

test("Legacy legendary export preserves its native soul bond in the optional backwards-compatible record", () => {
  const s = emptyBuild();
  s.w = legacy.data.weapons.findIndex((x) => x.name === "Sanity Check");
  const f = fixture("1.6.2", s),
    entry = f.character.loadouts[5].weapon;
  const meta = JSON.parse(entry.instance_data);
  meta.SubTypeMetadataArray = [
    {
      ItemSubType: "subtype_ihammer",
      EquippedItemParts: [
        { WeaponPartId: "PART_SOUL_WP_IH_CROWBEAR", SlotIndex: 3 },
        { WeaponPartId: "PART_IH_LEGENDARY_UMBRAL", SlotIndex: 2 },
      ],
    },
  ];
  entry.instance_data = JSON.stringify(meta);
  const out = exportPreset([f.character], f.request, "1.6.2");
  assert.equal(out.summary.bond, "Fall of Night");
  assert.equal(
    decodeBuild(out.code, datasets).state.bond,
    legacy.data.weapons.findIndex((x) => x.name === "Fall of Night"),
  );
  assert.throws(() => planBuild(out.code, "1.6.2"), /updated local Builder/);
});
test("Export preserves every mapped weapon part, including each version's different repeater layout", () => {
  const types = require("../data/modern/build-code.mjs").WEAPON_PART_TYPES;
  for (const version of Object.keys(datasets)) {
    const data = datasets[version],
      mappings =
        version === "1.6.2"
          ? legacy.mappings
          : require("../data/modern/mappings.json");
    for (const [i, part] of data.parts.entries()) {
      if (!mappings.parts[version === "1.6.2" ? i : part.key]) continue;
      const s = emptyBuild();
      s.w = data.weapons.findIndex(
        (w, index) =>
          types[w.type] === part.weaponType &&
          !w.restrict_specials &&
          w.rarity !== "exotic" &&
          mappings.weapons[version === "1.6.2" ? index : w.key],
      );
      s.parts[part.partKind] = i;
      const f = fixture(version, s),
        out = exportPreset([f.character], f.request, version);
      assert.equal(
        decodeBuild(out.code, datasets).state.parts[part.partKind],
        i,
        version + " " + part.name,
      );
    }
  }
});
