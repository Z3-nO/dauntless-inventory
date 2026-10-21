const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const native = require("../live-native.cjs");

test("Windows fractional heartbeat timestamps do not falsely disconnect Live; genuinely future timestamps stay rejected", (t) => {
  const c = fixture(t);
  const now = 1800000000000;
  const files = new Set(
    ["native", "client"].map((side) =>
      path.join(c.root, `data/materiali-live-${side}.json`),
    ),
  );
  for (const file of files)
    fs.writeFileSync(
      file,
      JSON.stringify({ protocol: 2, builds: true, connections: 1 }),
    );
  const stat = fs.statSync;
  let offset = 0.875;
  t.mock.method(Date, "now", () => now);
  t.mock.method(fs, "statSync", (file, ...args) => {
    const value = stat(file, ...args);
    return files.has(file) ? { ...value, mtimeMs: now + offset } : value;
  });
  assert.equal(native.heartbeat(c).available, true);
  assert.equal(native.heartbeat(c).builds, true);
  offset = 2000;
  assert.equal(native.heartbeat(c).available, false);
  offset = -7000;
  assert.equal(native.heartbeat(c).available, false);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "materiali-native-"));
  fs.mkdirSync(path.join(root, "data"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, version: "1.14.7" };
}

test("Live retries a concurrently written heartbeat, but persistent corruption still blocks every refresh", (t) => {
  const c = fixture(t);
  const files = new Set(
    ["native", "client"].map((side) =>
      path.join(c.root, `data/materiali-live-${side}.json`),
    ),
  );
  for (const file of files)
    fs.writeFileSync(
      file,
      JSON.stringify({ protocol: 2, builds: true, connections: 1 }),
    );
  const read = fs.readFileSync;
  const attempts = new Map();
  let corrupt = false;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (files.has(file)) {
      const count = (attempts.get(file) || 0) + 1;
      attempts.set(file, count);
      if (corrupt || count === 1) return "{";
    }
    return read(file, ...args);
  });
  assert.equal(native.heartbeat(c).builds, true);
  assert.deepEqual([...attempts.values()], [2, 2]);
  corrupt = true;
  assert.equal(native.heartbeat(c).available, false);
  assert.equal(native.signal(c, crypto.randomUUID()).queued, false);
  assert.equal(
    fs.existsSync(path.join(c.root, "data/materiali-live-refresh.txt")),
    false,
  );
});
test("Native Live: only a fresh single-player heartbeat can queue refresh", (t) => {
  const c = fixture(t),
    file = path.join(c.root, "data/materiali-live-native.json"),
    id = crypto.randomUUID();
  fs.writeFileSync(
    path.join(c.root, "data/materiali-live-client.json"),
    JSON.stringify({ protocol: 1, connections: 1, lastInvoked: id }),
  );
  assert.equal(native.signal(c, id).queued, false);
  for (const connections of [0, 2, 4]) {
    fs.writeFileSync(file, JSON.stringify({ protocol: 1, connections }));
    assert.equal(native.signal(c, id).queued, false);
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ protocol: 1, connections: 1, lastInvoked: id }),
  );
  assert.equal(native.signal(c, id).queued, true);
  assert.equal(
    fs.readFileSync(
      path.join(c.root, "data/materiali-live-refresh.txt"),
      "utf8",
    ),
    id,
  );
  fs.utimesSync(file, new Date(0), new Date(0));
  assert.equal(native.signal(c, crypto.randomUUID()).queued, false);
  assert.equal(native.signal({ ...c, version: "1.6.2" }, id).queued, false);
});
test("Native Live: malformed operations and malformed heartbeats never queue a command", (t) => {
  const c = fixture(t),
    file = path.join(c.root, "data/materiali-live-native.json");
  for (const value of ["x", "../../file", "-".repeat(36), "a".repeat(36)])
    assert.throws(() => native.signal(c, value), /Invalid/);
  fs.writeFileSync(file, "broken");
  assert.equal(native.heartbeat(c).available, false);
  assert.equal(
    fs.existsSync(path.join(c.root, "data/materiali-live-refresh.txt")),
    false,
  );
});

test("Native Live: missing local client and future heartbeat cannot claim ready", (t) => {
  const c = fixture(t),
    file = path.join(c.root, "data/materiali-live-native.json");
  fs.writeFileSync(file, JSON.stringify({ protocol: 1, connections: 1 }));
  assert.equal(native.heartbeat(c).available, false);
  const client = path.join(c.root, "data/materiali-live-client.json");
  fs.writeFileSync(client, JSON.stringify({ protocol: 1, connections: 1 }));
  fs.utimesSync(
    client,
    new Date(Date.now() + 60000),
    new Date(Date.now() + 60000),
  );
  assert.equal(native.heartbeat(c).available, false);
});

for (const version of ["1.6.2", "1.14.7"]) {
  test(`${version}: protocol 2 queues arbitrary existing slot commands and rejects invalid indices`, (t) => {
    const c = { ...fixture(t), version };
    for (const side of ["native", "client"])
      fs.writeFileSync(
        path.join(c.root, `data/materiali-live-${side}.json`),
        JSON.stringify({
          protocol: 2,
          pid: side === "client" ? 102 : 101,
          connections: 1,
          builds: true,
        }),
      );
    assert.equal(native.heartbeat(c).builds, true);
    for (const slot of [0, 5, 9, 15, 127]) {
      const id = crypto.randomUUID();
      assert.equal(native.signal(c, id, slot).queued, true);
      assert.equal(
        fs.readFileSync(
          path.join(c.root, "data/materiali-live-loadout.txt"),
          "utf8",
        ),
        `${id}\n${slot}\n`,
      );
    }
    const previous = fs.readFileSync(
      path.join(c.root, "data/materiali-live-loadout.txt"),
    );
    for (const slot of [-1, 128, 1.5, "5", NaN])
      assert.throws(
        () => native.signal(c, crypto.randomUUID(), slot),
        /Native build refresh requires/,
      );
    assert.deepEqual(
      fs.readFileSync(path.join(c.root, "data/materiali-live-loadout.txt")),
      previous,
    );
    fs.writeFileSync(
      path.join(c.root, "data/materiali-live-client.json"),
      JSON.stringify({ protocol: 1, connections: 1 }),
    );
    assert.equal(native.heartbeat(c).builds, false);
    assert.throws(
      () => native.signal(c, crypto.randomUUID(), 5),
      /current Live extension/,
    );
  });
}
