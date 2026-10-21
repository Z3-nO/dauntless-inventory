"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const preferences = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-images-"));
process.env.MATERIALI_USER_DATA = preferences;
const saves = require("../saves.cjs"),
  images = require("../images.cjs");
const { sqliteSlotInfo, jsonSlotInfo } = require("../slot-management.cjs");
const { catalogs } = require("../inventory.cjs");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function fixture(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-slots-"));
  fs.mkdirSync(path.join(root, "data"));
  const slots = Array.from({ length: version === "1.6.2" ? 3 : 6 }, (_, i) => ({
    slot_index: i,
    custom_name: "Keep " + i,
    update_version: 7,
    weapon: { instance_id: "weapon", instance_data: "{}" },
    custom: { retain: i },
  }));
  const inv = {
    stackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 71 }],
    instancedItems: [],
  };
  if (version === "1.14.7") {
    fs.mkdirSync(path.join(root, "backend"));
    fs.writeFileSync(
      path.join(root, "backend/loadouts-fix1147.js"),
      "const MAX=16,PATH_SLOTS=5;",
    );
    const state = {
      extra: { retain: true },
      players: {
        me: {
          characters: [{ id: "hero", name: "Test" }],
          inventory: { hero: inv },
          loadouts: {
            hero: {
              loadouts: slots,
              active_index: 2,
              persistent: { keep: true },
            },
          },
          loadoutSlots1147: {
            account: 1,
            characters: { hero: 5 },
            unknown: "retain",
          },
        },
        other: { characters: [], unchanged: 42 },
      },
    };
    const file = path.join(root, "data/state.json");
    fs.writeFileSync(file, JSON.stringify(state));
    return { root, file, version, id: JSON.stringify(["me", "hero"]), slots };
  }
  fs.mkdirSync(path.join(root, "backend/metagame"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "backend/metagame/.env"),
    "LOADOUT_SLOTS=10\n",
  );
  fs.writeFileSync(path.join(root, "data/player.key"), "UUK_test");
  fs.mkdirSync(path.join(root, "data/loadouts"));
  fs.writeFileSync(
    path.join(root, "data/loadouts/me_hero.json"),
    '{"active_index":2}',
  );
  const file = path.join(root, "data/undaunted.db"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE userapikeys(keyHash TEXT,userId TEXT);CREATE TABLE characters(characterId TEXT,name TEXT,userId TEXT);CREATE TABLE inventories(characterId TEXT,stackedItems TEXT,instancedItems TEXT);CREATE TABLE loadouts(characterId TEXT,loadouts TEXT,persistent TEXT);",
  );
  db.prepare("INSERT INTO userapikeys VALUES(?,?)").run(
    digest("UUK_test"),
    "me",
  );
  db.prepare("INSERT INTO characters VALUES('hero','Test','me')").run();
  db.prepare("INSERT INTO inventories VALUES(?,?,?)").run(
    "hero",
    JSON.stringify(inv.stackedItems),
    "[]",
  );
  db.prepare("INSERT INTO loadouts VALUES(?,?,?)").run(
    "hero",
    JSON.stringify(slots),
    '{"keep":true}',
  );
  db.close();
  return { root, file, version, id: "hero", slots };
}
for (const version of ["1.6.2", "1.14.7"])
  test(
    version +
      ": add slots with backup; preserve old slots, inventory and active slot; reject overflow and stale requests",
    async () => {
      const c = fixture(version),
        before = saves.snapshot(c),
        original = fs.readFileSync(c.file),
        count = version === "1.6.2" ? 7 : 10;
      assert.equal(
        before.characters[0].slots.length,
        version === "1.6.2" ? 10 : 6,
      );
      assert.equal(before.characters[0].slotInfo.saved, c.slots.length);
      const req = {
        operation: "add-slots",
        character: c.id,
        revision: before.revision,
        count,
        sourceSlot: 1,
      };
      const result = await saves.saveChanges(c, req);
      assert.ok(fs.existsSync(result.backup));
      assert.equal(
        result.characters[0].slotInfo.saved,
        version === "1.6.2" ? 10 : 16,
      );
      let written;
      if (version === "1.14.7") {
        assert.deepEqual(fs.readFileSync(result.backup), original);
        const state = JSON.parse(fs.readFileSync(c.file)),
          old = JSON.parse(original);
        written = state.players.me.loadouts.hero.loadouts;
        assert.equal(state.players.me.loadouts.hero.active_index, 2);
        assert.equal(state.players.me.loadoutSlots1147.account, 11);
        assert.equal(state.players.me.loadoutSlots1147.unknown, "retain");
        assert.deepEqual(state.players.me.inventory, old.players.me.inventory);
        assert.deepEqual(state.players.other, old.players.other);
        assert.deepEqual(state.extra, old.extra);
      } else {
        const db = new DatabaseSync(c.file, { readOnly: true }),
          bak = new DatabaseSync(result.backup, { readOnly: true });
        written = JSON.parse(
          db.prepare("SELECT loadouts FROM loadouts").get().loadouts,
        );
        assert.deepEqual(
          db.prepare("SELECT * FROM inventories").all(),
          bak.prepare("SELECT * FROM inventories").all(),
        );
        assert.equal(
          bak.prepare("PRAGMA integrity_check").get().integrity_check,
          "ok",
        );
        db.close();
        bak.close();
        assert.equal(
          fs.readFileSync(
            path.join(c.root, "data/loadouts/me_hero.json"),
            "utf8",
          ),
          '{"active_index":2}',
        );
      }
      c.slots.forEach((slot, i) => assert.deepEqual(written[i], slot));
      for (let i = c.slots.length; i < written.length; i++) {
        assert.deepEqual(written[i].weapon, c.slots[1].weapon);
        assert.equal(written[i].slot_index, i);
      }
      const unchanged = digest(fs.readFileSync(c.file));
      await assert.rejects(
        saves.saveChanges(c, { ...req, revision: result.revision, count: 1 }),
        /limit/,
      );
      await assert.rejects(saves.saveChanges(c, req), /changed/);
      assert.equal(digest(fs.readFileSync(c.file)), unchanged);
    },
  );
test("Limits come from server configuration; saved slots beyond three are never truncated", () => {
  const c = fixture("1.6.2"),
    twelve = Array.from({ length: 12 }, (_, i) => ({ slot_index: i }));
  assert.equal(sqliteSlotInfo(c.root, twelve).available, 12);
  fs.writeFileSync(
    path.join(c.root, "backend/metagame/.env"),
    "LOADOUT_SLOTS='24' # custom server\n",
  );
  assert.equal(sqliteSlotInfo(c.root, twelve).limit, 24);
  assert.equal(sqliteSlotInfo(c.root, twelve).available, 24);
  assert.equal(sqliteSlotInfo("", twelve).limit, null);
  assert.equal(sqliteSlotInfo("", twelve).canAdd, false);
  const j = fixture("1.14.7"),
    player = {
      pjmMaps: { main: { nodes: { LoadoutSlot_01: { node_status: 2 } } } },
    };
  assert.equal(jsonSlotInfo(j.root, player, "hero", []).characterSlots, 1);
  assert.equal(jsonSlotInfo(j.root, player, "hero", []).limit, 12);
});
test("Missing source, negative counts and overflow leave saves unchanged", async () => {
  const c = fixture("1.6.2"),
    before = saves.snapshot(c),
    bytes = fs.readFileSync(c.file);
  for (const changes of [
    { sourceSlot: undefined, count: 1 },
    { sourceSlot: 1, count: -1 },
    { sourceSlot: 1, count: 8 },
    { sourceSlot: 99, count: 1 },
  ]) {
    await assert.rejects(
      saves.saveChanges(c, {
        operation: "add-slots",
        character: c.id,
        revision: before.revision,
        ...changes,
      }),
    );
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  }
});
test("Bundled icon paths exist for both versions; native textures resolve to the selected game's Paks directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-paths-")),
    game = path.join(root, "Game1147");
  fs.mkdirSync(path.join(game, "Archon/Content/Paks"), { recursive: true });
  fs.writeFileSync(
    path.join(game, "Archon/Content/Paks/Archon_0-WindowsClient.pak"),
    "test",
  );
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ GameDir: game }),
  );
  for (const version of ["1.6.2", "1.14.7"]) {
    const info = images.standardPaths(
      root,
      version,
      path.resolve(__dirname, ".."),
    );
    assert.equal(info.bundledMissing, 0);
    assert.ok(info.bundledAvailable > 0);
    assert.equal(info.nativeRoot, path.join(game, "Archon/Content/Paks"));
    assert.equal(info.archives, 1);
    const icons = require("../data/icon-map.json");
    for (const id of Object.keys(icons[version]))
      assert.ok(
        fs.existsSync(images.find(version, id, path.resolve(__dirname, ".."))),
      );
  }
});
test("Repeated texture prefixes match; stale custom links fall back to the standard bundled icon", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-export-")),
    id = "WP_EB_LAVAROLLER";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=",
    "base64",
  );
  const custom = path.join(root, "T_UI_ICON_" + id + ".png");
  fs.writeFileSync(custom, png);
  const found = await images.scan(root, "1.6.2", catalogs["1.6.2"]);
  assert.equal(found.matched, 1);
  assert.equal(images.find("1.6.2", id, path.resolve(__dirname, "..")), custom);
  fs.renameSync(custom, custom + ".moved");
  assert.match(
    images.find("1.6.2", id, path.resolve(__dirname, "..")),
    /builder/,
  );
});
