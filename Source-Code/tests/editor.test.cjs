"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const builder = require("../data/builder.json");
const { planBuild } = require("../build-import.cjs");
const { snapshot, saveChanges } = require("../saves.cjs");
const { applyItems } = require("../inventory.cjs");
const { equipBuild } = require("../loadouts.cjs");

function exampleCode() {
  const index = (category, name) =>
    builder.data[category].findIndex((row) => row.name === name);
  const cells = [
    "Rage Cell",
    "Discipline Cell",
    "Predator Cell",
    "Weighted Strikes Cell",
    "Sharpened Cell",
    "Ragehunter Cell",
    "Conduit Cell",
  ].map((name) => index("cells", name) * 3);
  const armours = [
    "Hellplate Casque",
    "Hellplate Cuirass",
    "Hellplate Bracers",
    "Hellplate Greaves",
  ].map((name) => [index("armours", name), 0]);
  const parts = [
    index("parts", "Keen Edge"),
    index("parts", "Valiant Overdrive"),
    -1,
    -1,
    -1,
    -1,
  ];
  const values = [
    index("weapons", "Inferno's Razor"),
    0,
    parts,
    armours,
    index("lanterns", "Shrike's Zeal"),
    cells,
  ];
  return "162." + Buffer.from(JSON.stringify(values)).toString("base64url");
}

const code = exampleCode();
const plan = planBuild(code, "1.6.2");
const startingInventory = {
  stackedItems: [
    { catalogId: "CURRENCY_NOTES", quantity: 71, custom: "retain" },
  ],
  instancedItems: [
    {
      catalogId: "WP_EB_LAVAROLLER",
      instanceId: "existing-sword",
      itemData: JSON.stringify({ CurrentLevel: 0, custom: "retain" }),
      updateVersion: 0,
    },
  ],
};
const startingSlots = [0, 1, 2].map((index) => ({
  slot_index: index,
  custom_name: "Slot " + (index + 1),
  update_version: 0,
  weapon: {
    item_id: "WP_EB_TRAINING",
    instance_id: "WP_EB_TRAINING",
    instance_data: JSON.stringify({ PrimaryDyeId: "my-dye" }),
  },
  marker: "retain-" + index,
}));

test("Builder URL and code decode to the same complete plan; cells become +3", () => {
  assert.equal(plan.compatible, true, JSON.stringify(plan.issues));
  assert.equal(plan.gear.length, 6);
  assert.equal(plan.cells.length, 7);
  assert.ok(
    plan.cells.every((cell) => cell.rank === 3 && cell.id.endsWith("_E")),
  );
  assert.deepEqual(
    planBuild("https://builder.dauntlessforever.com/#" + code, "1.6.2"),
    plan,
  );
  assert.throws(
    () => planBuild("https://example.com/#" + code, "1.6.2"),
    /Builder/,
  );
  assert.throws(() => planBuild("162.invalid", "1.6.2"), /decode/);
});

test("Only the explicit slot is replaced; empty or invalid slot selection is rejected", () => {
  const inventory = applyItems(
    startingInventory,
    plan.changes,
    "add",
    "1.6.2",
    true,
  );
  const result = equipBuild(startingSlots, 1, plan, inventory);
  assert.deepEqual(result[0], startingSlots[0]);
  assert.deepEqual(result[2], startingSlots[2]);
  assert.equal(result[1].weapon.instance_id, "existing-sword");
  const data = JSON.parse(result[1].weapon.instance_data);
  assert.equal(data.PrimaryDyeId, "my-dye");
  assert.equal(data.EquippedCells.length, 2);
  assert.equal(data.SubTypeMetadataArray[0].EquippedItemParts.length, 2);
  assert.throws(
    () => equipBuild(startingSlots, undefined, plan, inventory),
    /Explicitly/,
  );
  assert.throws(
    () => equipBuild(startingSlots, 99, plan, inventory),
    /Explicitly/,
  );
  const gearData = JSON.parse(inventory.instancedItems[0].itemData);
  assert.equal(gearData.CurrentLevel, 1);
  assert.equal(gearData.custom, "retain");
});

function fixture(version) {
  const root = fs.mkdtempSync(
    path.join(process.env.MATERIALI_TEST_ROOT || os.tmpdir(), "materiali-"),
  );
  fs.mkdirSync(path.join(root, "data"));
  if (version === "1.14.7") {
    const file = path.join(root, "data/state.json");
    const state = {
      extra: { retain: true },
      players: {
        me: {
          characters: [{ id: "hero", name: "Test Slayer" }],
          inventory: { hero: structuredClone(startingInventory) },
          loadouts: {
            hero: {
              loadouts: structuredClone(startingSlots),
              active_index: 2,
              persistent: { retain: true },
            },
          },
        },
        other: { characters: [], inventory: {}, retain: 42 },
      },
    };
    fs.writeFileSync(file, JSON.stringify(state));
    return { root, file, version, id: JSON.stringify(["me", "hero"]) };
  }
  const file = path.join(root, "data/undaunted.db");
  const key = "UUK_test-only";
  fs.writeFileSync(path.join(root, "data/player.key"), key);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE userapikeys(keyHash TEXT,userId TEXT);CREATE TABLE characters(characterId TEXT,name TEXT,userId TEXT);CREATE TABLE inventories(characterId TEXT,stackedItems TEXT,instancedItems TEXT);CREATE TABLE loadouts(characterId TEXT,loadouts TEXT,persistent TEXT);",
  );
  db.prepare("INSERT INTO userapikeys VALUES (?,?)").run(
    crypto.createHash("sha256").update(key).digest("hex"),
    "me",
  );
  db.prepare("INSERT INTO characters VALUES (?,?,?)").run(
    "hero",
    "Test Slayer",
    "me",
  );
  db.prepare("INSERT INTO characters VALUES (?,?,?)").run(
    "friend",
    "Other Slayer",
    "friend",
  );
  db.prepare("INSERT INTO inventories VALUES (?,?,?)").run(
    "hero",
    JSON.stringify(startingInventory.stackedItems),
    JSON.stringify(startingInventory.instancedItems),
  );
  db.prepare("INSERT INTO loadouts VALUES (?,?,?)").run(
    "hero",
    JSON.stringify(startingSlots),
    '{"retain":true}',
  );
  db.close();
  return { root, file, version, id: "hero" };
}

for (const version of ["1.6.2", "1.14.7"]) {
  test(
    version +
      ": full save transaction, backup, selected-slot preservation, idempotence and stale revision",
    async () => {
      const connection = fixture(version);
      const before = snapshot(connection);
      const request = {
        character: connection.id,
        revision: before.revision,
        ...(version === "1.6.2"
          ? { buildCode: code }
          : { changes: plan.changes, mode: "set", maximize: false }),
        slot: 1,
      };
      assert.deepEqual(
        before.characters[0].slots.map((slot) => slot.index),
        [0, 1, 2],
      );
      if (version === "1.6.2")
        await assert.rejects(
          saveChanges(connection, { ...request, slot: undefined }),
          /slot/,
        );
      const after = await saveChanges(connection, request);
      assert.ok(fs.existsSync(after.backup));
      assert.equal(after.characters.length, 1);
      assert.equal(after.characters[0].items.CURRENCY_NOTES, 71);
      assert.equal(
        after.characters[0].gear.find((row) => row.id === "WP_EB_LAVAROLLER")
          .level,
        version === "1.6.2" ? 1 : 0,
      );
      const repeated = await saveChanges(connection, {
        ...request,
        revision: after.revision,
      });
      assert.deepEqual(repeated.characters[0].items, after.characters[0].items);
      await assert.rejects(saveChanges(connection, request), /changed/);
      if (version === "1.6.2")
        await assert.rejects(
          saveChanges(connection, {
            ...request,
            revision: repeated.revision,
            slot: 999,
          }),
          /Explicitly/,
        );
      let slots;
      if (version === "1.14.7") {
        const saved = JSON.parse(fs.readFileSync(connection.file));
        slots = saved.players.me.loadouts.hero.loadouts;
        assert.equal(saved.players.me.loadouts.hero.active_index, 2);
        assert.deepEqual(saved.extra, { retain: true });
        assert.equal(saved.players.other.retain, 42);
      } else {
        const db = new DatabaseSync(connection.file, { readOnly: true });
        slots = JSON.parse(
          db
            .prepare("SELECT loadouts FROM loadouts WHERE characterId=?")
            .get("hero").loadouts,
        );
        assert.equal(
          db
            .prepare("SELECT persistent FROM loadouts WHERE characterId=?")
            .get("hero").persistent,
          '{"retain":true}',
        );
        db.close();
      }
      assert.deepEqual(slots[0], startingSlots[0]);
      assert.deepEqual(slots[2], startingSlots[2]);
    },
  );
}

test("Unknown/internal entries cannot be granted; instance removal is refused", () => {
  assert.throws(
    () =>
      applyItems(startingInventory, { TOKEN_CELL_EXCHANGE: 1 }, "add", "1.6.2"),
    /cannot be edited/,
  );
  assert.throws(
    () =>
      applyItems(startingInventory, { WP_EB_LAVAROLLER: 0 }, "set", "1.6.2"),
    /Removing/,
  );
});

if (require.main === module)
  fs.writeFileSync(path.join(__dirname, "../data/example-build.txt"), code);
module.exports = { exampleCode, fixture };

test("1.14.7 Power Surge persists with backup while preserving loadout records, currencies and other players", async () => {
  const connection = fixture("1.14.7");
  const before = JSON.parse(fs.readFileSync(connection.file));
  const state = snapshot(connection);
  const result = await saveChanges(connection, {
    character: connection.id,
    revision: state.revision,
    changes: { WP_EB_LAVAROLLER: 1 },
    mode: "set",
    maximize: true,
  });
  assert.ok(fs.existsSync(result.backup));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup)), before);
  const saved = JSON.parse(fs.readFileSync(connection.file));
  assert.deepEqual(saved.players.me.loadouts, before.players.me.loadouts);
  assert.deepEqual(saved.players.other, before.players.other);
  assert.deepEqual(
    saved.players.me.inventory.hero.stackedItems,
    before.players.me.inventory.hero.stackedItems,
  );
  assert.deepEqual(
    JSON.parse(saved.players.me.inventory.hero.instancedItems[0].itemData),
    {
      CurrentLevel: 1,
      CurrentXP: 0,
      custom: "retain",
    },
  );
  assert.equal(
    snapshot(connection).characters[0].gear.find(
      (row) => row.id === "WP_EB_LAVAROLLER",
    ).level,
    1,
  );
  const bytes = fs.readFileSync(connection.file);
  await assert.rejects(
    saveChanges(connection, {
      character: connection.id,
      revision: result.revision,
      changes: { WP_EB_LAVAROLLER: 1, WP_AC_SPRINGTIDE_L10R: 1 },
      mode: "set",
      maximize: true,
    }),
    /No verified Power Surge/,
  );
  assert.deepEqual(fs.readFileSync(connection.file), bytes);
});

test("1.14.7 legacy build conversion is blocked before writing", async () => {
  const c = fixture("1.14.7"),
    before = fs.readFileSync(c.file),
    state = snapshot(c);
  await assert.rejects(
    saveChanges(c, {
      character: c.id,
      revision: state.revision,
      buildCode: code,
      slot: 1,
    }),
    /disabled/,
  );
  assert.deepEqual(fs.readFileSync(c.file), before);
});
