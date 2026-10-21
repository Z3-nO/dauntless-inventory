"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const saves = require("../saves.cjs");
const resets = require("../character-reset.cjs");

const appearance = JSON.stringify({
  CreationState: "Created",
  face: "retained",
});
const data = JSON.stringify({
  AppearanceData: appearance,
  LastChangelist: "native",
  HasFinishedTutorial: true,
  SERIE_test: "completed",
});
const inv = {
  stackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 123 }],
  instancedItems: [
    {
      catalogId: "WP_EB_LAVAROLLER",
      instanceId: "old",
      itemData: '{"CurrentLevel":1}',
    },
  ],
};
const loadouts = [0, 1, 2].map((slot_index) => ({
  slot_index,
  appearance,
  weapon: { item_id: "WP_EB_LAVAROLLER", instance_id: "old" },
  custom_name: "Custom",
  persistent: { title: "earned" },
}));

function fixture(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "character-reset-"));
  fs.mkdirSync(path.join(root, "data"));
  if (version === "1.14.7") {
    const file = path.join(root, "data/state.json");
    const hero = { id: "hero", name: "Test Slayer", data, updateVersion: 7 };
    const player = {
      characters: [hero, { id: "other", name: "Other", data }],
      inventory: { hero: inv, other: inv },
      loadouts: {
        hero: { loadouts, active_index: 2, persistent: { title: "earned" } },
        other: { loadouts, active_index: 1 },
      },
      progress: { shared: 77 },
      pjmMaps: { unlock: true },
      entitlements: ["keep"],
      loadoutSlots1147: { account: 3 },
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        players: {
          me: player,
          outsider: { characters: [], inventory: {}, keep: true },
        },
      }),
    );
    return { root, file, version, character: JSON.stringify(["me", "hero"]) };
  }
  const file = path.join(root, "data/undaunted.db");
  const key = "UUK_test-only-reset";
  fs.writeFileSync(path.join(root, "data/player.key"), key);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE users(userId TEXT PRIMARY KEY,name TEXT,notes INTEGER); CREATE TABLE userapikeys(userId TEXT PRIMARY KEY,keyHash TEXT); CREATE TABLE characters(characterId TEXT PRIMARY KEY,userId TEXT,name TEXT,data TEXT,updateVersion INTEGER,createdDate TEXT,lastModifiedDate TEXT); CREATE TABLE inventories(characterId TEXT PRIMARY KEY,stackedItems TEXT,instancedItems TEXT); CREATE TABLE loadouts(characterId TEXT PRIMARY KEY,userId TEXT,loadouts TEXT,persistent TEXT); CREATE TABLE breadcrumbs(characterId TEXT,userId TEXT,breadcrumbs TEXT,updateVersion INTEGER); CREATE TABLE encounteredcontent(characterId TEXT,userId TEXT,encounteredcontent TEXT);",
  );
  db.prepare("INSERT INTO users VALUES (?,?,?)").run("me", "Owner", 800);
  db.prepare("INSERT INTO userapikeys VALUES (?,?)").run(
    "me",
    crypto.createHash("sha256").update(key).digest("hex"),
  );
  for (const id of ["hero", "other", "outsider"]) {
    const user = id === "outsider" ? "them" : "me";
    db.prepare("INSERT INTO characters VALUES (?,?,?,?,?,?,?)").run(
      id,
      user,
      id === "hero" ? "Test Slayer" : id,
      data,
      7,
      "created",
      "modified",
    );
    db.prepare("INSERT INTO inventories VALUES (?,?,?)").run(
      id,
      JSON.stringify(inv.stackedItems),
      JSON.stringify(inv.instancedItems),
    );
    db.prepare("INSERT INTO loadouts VALUES (?,?,?,?)").run(
      id,
      user,
      JSON.stringify(loadouts),
      '{"title":"earned"}',
    );
    db.prepare("INSERT INTO breadcrumbs VALUES (?,?,?,?)").run(
      id,
      user,
      "earned",
      4,
    );
    db.prepare("INSERT INTO encounteredcontent VALUES (?,?,?)").run(
      id,
      user,
      "seen",
    );
  }
  db.close();
  return { root, file, version, character: "hero" };
}

function logical(connection) {
  if (connection.version === "1.14.7")
    return JSON.parse(fs.readFileSync(connection.file));
  const db = new DatabaseSync(connection.file, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "users",
        "characters",
        "inventories",
        "loadouts",
        "breadcrumbs",
        "encounteredcontent",
      ].map((table) => [
        table,
        db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all(),
      ]),
    );
  } finally {
    db.close();
  }
}

for (const version of ["1.6.2", "1.14.7"]) {
  test(
    version +
      ": reset is scoped to the selected character; durable backup restores name, appearance, inventory, quests and every slot",
    async () => {
      const connection = fixture(version);
      const activeFile = path.join(
        connection.root,
        "data/loadouts/me_hero.json",
      );
      if (version === "1.6.2") {
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        fs.writeFileSync(activeFile, '{"active_index":2}');
      }
      const before = logical(connection);
      const initial = saves.snapshot(connection);
      const request = {
        character: connection.character,
        revision: initial.revision,
        confirmName: "wrong",
        operation: "reset-character",
      };
      await assert.rejects(
        saves.saveChanges(connection, request),
        /confirmation/,
      );
      assert.deepEqual(logical(connection), before);
      request.confirmName = "Test Slayer";
      const result = await saves.saveChanges(connection, request);
      assert.ok(fs.existsSync(result.backup));
      const points = resets.resetPoints(connection, connection.character);
      assert.equal(points.length, 1);
      assert.equal(resets.resetPoints(connection, "another").length, 0);
      assert.throws(
        () =>
          resets.loadRestore(connection, {
            ...request,
            character: "another",
            backupId: points[0].id,
          }),
        /another character/,
      );
      const after = logical(connection);
      if (version === "1.14.7") {
        const p = after.players.me,
          old = before.players.me;
        assert.deepEqual(p.progress, old.progress);
        assert.deepEqual(p.pjmMaps, old.pjmMaps);
        assert.deepEqual(p.entitlements, old.entitlements);
        assert.deepEqual(p.loadoutSlots1147, old.loadoutSlots1147);
        assert.deepEqual(p.inventory.other, old.inventory.other);
        assert.deepEqual(p.loadouts.other, old.loadouts.other);
        assert.deepEqual(after.players.outsider, before.players.outsider);
        assert.equal(p.characters[0].name, old.characters[0].name);
        assert.deepEqual(JSON.parse(p.characters[0].data), {
          AppearanceData: appearance,
          LastChangelist: "native",
        });
        assert.equal(p.inventory.hero.stackedItems.length, 0);
        assert.equal(p.inventory.hero.instancedItems.length, 6);
        assert.ok(
          p.loadouts.hero.loadouts.every(
            (slot) =>
              slot.weapon.item_id === "WP_EB_TRAINING" &&
              slot.player_role === null &&
              slot.appearance === appearance,
          ),
        );
      } else {
        assert.deepEqual(after.users, before.users);
        for (const table of [
          "characters",
          "inventories",
          "loadouts",
          "breadcrumbs",
          "encounteredcontent",
        ])
          assert.deepEqual(
            after[table].filter((row) => row.characterId !== "hero"),
            before[table].filter((row) => row.characterId !== "hero"),
          );
        assert.equal(
          after.breadcrumbs.some((row) => row.characterId === "hero"),
          false,
        );
        assert.equal(
          after.encounteredcontent.some((row) => row.characterId === "hero"),
          false,
        );
        assert.deepEqual(
          JSON.parse(
            after.characters.find((row) => row.characterId === "hero").data,
          ),
          { AppearanceData: appearance, LastChangelist: "native" },
        );
      }
      await assert.rejects(
        saves.saveChanges(connection, {
          ...request,
          operation: "restore-character",
          revision: result.revision,
          backupId: "../../private.json",
        }),
        /Choose/,
      );
      assert.deepEqual(logical(connection), after);
      await assert.rejects(
        saves.saveChanges(connection, {
          ...request,
          revision: initial.revision,
        }),
        /changed/,
      );
      if (version === "1.6.2") {
        fs.writeFileSync(activeFile, '{"active_index":0}');
        await assert.rejects(
          saves.saveChanges(connection, {
            ...request,
            revision: result.revision,
            operation: "restore-character",
            backupId: points[0].id,
          }),
          /changed/,
        );
      }
      const restored = await saves.saveChanges(connection, {
        ...request,
        revision: saves.snapshot(connection).revision,
        operation: "restore-character",
        backupId: points[0].id,
      });
      assert.ok(fs.existsSync(restored.backup));
      if (version === "1.6.2")
        assert.equal(fs.readFileSync(activeFile, "utf8"), '{"active_index":2}');
      // Row ordering may change during transactional restoration; compare by identity.
      const final = logical(connection);
      if (version === "1.14.7") assert.deepEqual(final, before);
      else
        for (const table of Object.keys(before)) {
          const sort = (rows) => rows.map((row) => JSON.stringify(row)).sort();
          assert.deepEqual(sort(final[table]), sort(before[table]), table);
        }
    },
  );
}

test("Legacy restoration recovers an absent active-slot file and preserves other characters' active slots", async () => {
  const connection = fixture("1.6.2");
  const initial = saves.snapshot(connection);
  const request = {
    operation: "reset-character",
    character: connection.character,
    confirmName: "Test Slayer",
    revision: initial.revision,
  };
  await saves.saveChanges(connection, request);
  const point = resets.resetPoints(connection, connection.character)[0];
  const directory = path.join(connection.root, "data/loadouts");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "me_hero.json"), '{"active_index":1}');
  fs.writeFileSync(path.join(directory, "me_other.json"), '{"active_index":2}');
  await saves.saveChanges(connection, {
    ...request,
    operation: "restore-character",
    revision: saves.snapshot(connection).revision,
    backupId: point.id,
  });
  assert.equal(fs.existsSync(path.join(directory, "me_hero.json")), false);
  assert.equal(
    fs.readFileSync(path.join(directory, "me_other.json"), "utf8"),
    '{"active_index":2}',
  );
});

test("Legacy database commit failure rolls back both character restoration and active-slot changes", async () => {
  const connection = fixture("1.6.2");
  const request = {
    operation: "reset-character",
    character: connection.character,
    confirmName: "Test Slayer",
    revision: saves.snapshot(connection).revision,
  };
  await saves.saveChanges(connection, request);
  const point = resets.resetPoints(connection, connection.character)[0];
  const active = path.join(connection.root, "data/loadouts/me_hero.json");
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, '{"active_index":1}');
  const before = logical(connection);
  const originalExec = DatabaseSync.prototype.exec;
  let fail = true;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === "COMMIT" && fail) {
      fail = false;
      throw Error("Test commit failure");
    }
    return originalExec.call(this, sql);
  };
  try {
    await assert.rejects(
      saves.saveChanges(connection, {
        ...request,
        operation: "restore-character",
        revision: saves.snapshot(connection).revision,
        backupId: point.id,
      }),
      /Test commit failure/,
    );
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.deepEqual(logical(connection), before);
  assert.equal(fs.readFileSync(active, "utf8"), '{"active_index":1}');
});
