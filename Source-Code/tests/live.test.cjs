"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { modern } = require("../live-adapters.cjs");
const { create } = require("../live-runtime.cjs");
const hash = (x) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dauntless-live-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"));
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, "data/materiali-live.key"), key);
  let state = {
    players: {
      owner: {
        accountId: "account",
        characters: [{ id: "character", name: "Test Slayer", data: "{}" }],
        inventory: {
          character: {
            stackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 10 }],
            instancedItems: [],
          },
        },
      },
      other: {
        characters: [{ id: "other-character", name: "Other Slayer" }],
        inventory: {
          "other-character": { stackedItems: [], instancedItems: [] },
        },
      },
    },
  };
  let fail = false;
  const file = path.join(root, "data/state.json");
  fs.writeFileSync(file, JSON.stringify(state));
  const adapter = modern({
    root,
    getState: () => state,
    setState: (x) => (state = x),
    saveState() {
      if (fail) throw Error("Simulated disk failure");
      fs.writeFileSync(file, JSON.stringify(state));
    },
  });
  const runtime = create(adapter);
  const req = {
    method: "POST",
    headers: { host: "127.0.0.1:63000", "x-materiali-live-key": key },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const identity = hash([path.resolve(root).toLowerCase(), "1.14.7"]);
  const call = (action, request, override) =>
    runtime.admin(override || req, { identity, action, request });
  const request = () => ({
    id: crypto.randomUUID(),
    character: JSON.stringify(["owner", "character"]),
    revision: runtime.snapshot().revision,
    mode: "add",
    changes: { CURRENCY_NOTES: 7 },
  });
  return {
    root,
    runtime,
    call,
    request,
    req,
    identity,
    state: () => state,
    fail: () => (fail = true),
  };
}
test("Live keeps the same in-game character through repeated autosaves and clears game readiness when the native session disappears", (t) => {
  const f = fixture(t);
  const active = f.request().character;
  const server = path.join(f.root, "data/materiali-live-native.json");
  const client = path.join(f.root, "data/materiali-live-client.json");
  const writeHeartbeats = (connections) => {
    fs.writeFileSync(
      server,
      JSON.stringify({ protocol: 2, builds: true, pid: 42, connections }),
    );
    fs.writeFileSync(
      client,
      JSON.stringify({ protocol: 2, builds: true, pid: 43, connections: 1 }),
    );
  };
  writeHeartbeats(1);
  f.runtime.decorate(active, "GET", "/inventory/account/character", {});
  const first = f.runtime.snapshot();
  assert.equal(first.gameCharacter, active);
  for (let i = 0; i < 40; i++) {
    f.state().players.owner.inventory.character.stackedItems[0].quantity++;
    const current = f.runtime.snapshot();
    assert.equal(current.gameCharacter, active);
    assert.equal(current.sessionId, first.sessionId);
    assert.notEqual(current.revision, first.revision);
  }
  writeHeartbeats(0);
  assert.equal(f.runtime.snapshot().gameCharacter, null);
  writeHeartbeats(1);
  assert.equal(f.runtime.snapshot().gameCharacter, active);
});

test("Live: authenticated server commit, full backup and stable retry without duplicate grants", (t) => {
  const f = fixture(t),
    before = structuredClone(f.state()),
    request = f.request();
  const result = f.call("apply", request);
  assert.equal(result.status, 200);
  assert.equal(result.json.characters[0].items.CURRENCY_NOTES, 17);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.json.backup)), before);
  assert.deepEqual(f.state().players.other, before.players.other);
  assert.equal(
    f.call("apply", request).json.characters[0].items.CURRENCY_NOTES,
    17,
  );
  assert.match(
    f.call("apply", { ...request, changes: { CURRENCY_NOTES: 8 } }).json.error,
    /reused/,
  );
});
test("Live: wrong secret, LAN, browser origins and wrong save identity cannot read or write", (t) => {
  const f = fixture(t),
    before = structuredClone(f.state());
  for (const req of [
    {
      ...f.req,
      headers: { ...f.req.headers, "x-materiali-live-key": "0".repeat(64) },
    },
    { ...f.req, socket: { remoteAddress: "192.168.1.2" } },
    { ...f.req, headers: { ...f.req.headers, origin: "https://example.com" } },
    { ...f.req, headers: { ...f.req.headers, host: "example.com:63000" } },
  ])
    assert.equal(f.call("snapshot", null, req).status, 403);
  assert.equal(
    f.runtime.admin(f.req, { identity: "wrong", action: "snapshot" }).status,
    409,
  );
  assert.deepEqual(f.state(), before);
});
test("Live: stale review, unknown character and destructive operations leave current state intact", (t) => {
  const f = fixture(t),
    before = structuredClone(f.state());
  const request = f.request();
  for (const extra of [
    { revision: "stale" },
    { character: "unknown" },
    { operation: "reset-character", confirmName: "Test Slayer" },
    { operation: "restore-character", confirmName: "Test Slayer" },
    { operation: "add-slots", sourceSlot: 0, count: 1 },
  ])
    assert.equal(f.call("apply", { ...request, ...extra }).status, 409);
  assert.deepEqual(f.state(), before);
});
test("Live: failed persistence rolls back in-memory state and retains the pre-write backup", (t) => {
  const f = fixture(t),
    before = structuredClone(f.state());
  f.fail();
  assert.equal(f.call("apply", f.request()).status, 409);
  assert.deepEqual(f.state(), before);
  assert.equal(
    fs.readdirSync(path.join(f.root, "backup/materiali-tool")).length,
    1,
  );
});
test("Live: delivery uses current absolute totals, preserves native rewards and isolates other characters", (t) => {
  const f = fixture(t),
    request = f.request();
  assert.equal(f.call("apply", request).status, 200);
  const empty = () => ({
    createdInstancedItems: [],
    updatedInstancedItems: [],
    updatedStackedItems: [{ catalogId: "OTHER_REWARD", quantity: 4 }],
    removedInstancedItems: [],
  });
  const untouched = f.runtime.decorate(
    JSON.stringify(["other", "other-character"]),
    "POST",
    "/inventory",
    empty(),
  );
  assert.equal(untouched.updatedStackedItems.length, 1);
  // A game reward arrives between importing and delivering: report 20, never the stale imported 17.
  f.state().players.owner.inventory.character.stackedItems[0].quantity += 3;
  const reply = f.runtime.decorate(
    request.character,
    "POST",
    "/inventory",
    empty(),
  );
  assert.deepEqual(reply.updatedStackedItems, [
    { catalogId: "OTHER_REWARD", quantity: 4 },
    { catalogId: "CURRENCY_NOTES", quantity: 20 },
  ]);
  assert.equal(f.runtime.snapshot().delivery[0].inventorySent, true);
  assert.equal(
    f.runtime.decorate(request.character, "POST", "/inventory", empty())
      .updatedStackedItems.length,
    1,
  );
});
test("Live: zero totals are delivered explicitly so the game can remove an exhausted stack", (t) => {
  const f = fixture(t),
    req = { ...f.request(), mode: "set", changes: { CURRENCY_NOTES: 0 } };
  assert.equal(f.call("apply", req).status, 200);
  const reply = f.runtime.decorate(req.character, "POST", "/inventory", {
    updatedStackedItems: [],
  });
  assert.deepEqual(reply.updatedStackedItems, [
    { catalogId: "CURRENCY_NOTES", quantity: 0 },
  ]);
});

test("Live Preview: build import is refused before the server writes any character data", (t) => {
  const f = fixture(t),
    before = structuredClone(f.state());
  const example = require("../data/build147-examples-test.json");
  const result = f.call("apply", {
    ...f.request(),
    changes: {},
    buildCode: example.code,
    slot: 0,
  });
  assert.equal(result.status, 409);
  assert.match(result.json.error, /Live build import is not supported/);
  assert.deepEqual(f.state(), before);
  assert.equal(
    fs.existsSync(path.join(f.root, "backup/materiali-tool")),
    false,
  );
});

test("Live builds retain stale-slot protection until both processes confirm application, including repeated imports", (t) => {
  const f = fixture(t);
  f.state().players.owner.loadouts = {
    character: {
      loadouts: Array.from({ length: 6 }, (_, slot_index) => ({
        slot_index,
        custom_name: "",
        persistent: { keep: slot_index },
      })),
    },
  };
  for (const [side, pid] of [
    ["native", 101],
    ["client", 102],
  ])
    fs.writeFileSync(
      path.join(f.root, `data/materiali-live-${side}.json`),
      JSON.stringify({ protocol: 2, pid, builds: true, connections: 1 }),
    );
  const code = require("../data/build147-examples-test.json").code;
  const req = { ...f.request(), changes: {}, buildCode: code, slot: 5 };
  const before = structuredClone(
    f.state().players.owner.loadouts.character.loadouts,
  );
  assert.equal(f.call("apply", req).status, 200);
  assert.equal(
    fs.readFileSync(
      path.join(f.root, "data/materiali-live-loadout.txt"),
      "utf8",
    ),
    req.id + "\n5\n",
  );
  assert.deepEqual(
    f.state().players.owner.loadouts.character.loadouts.slice(0, 5),
    before.slice(0, 5),
  );
  const imported = structuredClone(
    f.state().players.owner.loadouts.character.loadouts[5],
  );
  const stale = { data: before[5] };
  f.runtime.decorate(req.character, "GET", "/loadout/a/b/all", {
    payload: { loadouts: [imported] },
  });
  assert.equal(f.runtime.snapshot().delivery[0].loadoutSent, true);
  assert.deepEqual(
    f.runtime.protect(req.character, "POST", "/loadout/a/b/5", stale).data,
    imported,
  );
  const ack = (side, pid, slot = 5) =>
    fs.writeFileSync(
      path.join(f.root, `data/materiali-live-loadout-${side}.json`),
      JSON.stringify({ protocol: 2, pid, id: req.id, slot, applied: true }),
    );
  ack("server", 101);
  assert.equal(f.runtime.snapshot().delivery[0].buildApplied, false);
  ack("client", 999);
  assert.equal(f.runtime.snapshot().delivery[0].buildApplied, false);
  ack("client", 102, 4);
  assert.equal(f.runtime.snapshot().delivery[0].buildApplied, false);
  ack("client", 102);
  assert.equal(f.runtime.snapshot().delivery[0].buildApplied, true);
  assert.deepEqual(
    f.runtime.protect(req.character, "POST", "/loadout/a/b/5", stale),
    stale,
  );
  const second = {
    ...req,
    id: crypto.randomUUID(),
    revision: f.runtime.snapshot().revision,
  };
  assert.equal(f.call("apply", second).status, 200);
  fs.writeFileSync(
    path.join(f.root, "data/materiali-live-loadout-client.json"),
    "{}",
  );
  assert.equal(f.runtime.snapshot().delivery[0].buildApplied, true);
  const third = {
    ...second,
    id: crypto.randomUUID(),
    revision: f.runtime.snapshot().revision,
  };
  assert.match(f.call("apply", third).json.error, /still being applied/);
  const grant = { ...f.request(), revision: f.runtime.snapshot().revision };
  assert.match(f.call("apply", grant).json.error, /still being applied/);
});
