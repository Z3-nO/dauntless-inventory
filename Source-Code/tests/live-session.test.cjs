const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../public/live-session.js");

function snapshot(revision = "new", active = "a") {
  return {
    live: true,
    revision,
    activeCharacter: active,
    characters: [
      { id: "a", name: "First Slayer" },
      { id: "b", name: "Second Slayer" },
    ],
    nativeRefresh: { available: true, builds: true, connections: 1 },
    delivery: [],
  };
}

test("Live follows the identified game character and never defaults to an unrelated first profile", () => {
  assert.equal(policy.selected(snapshot("r", "b"), "a"), "b");
  assert.equal(policy.ready(snapshot("r", "b"), "b"), true);
  assert.equal(policy.ready(snapshot("r", "b"), "a"), false);
  const unknown = snapshot("r", "not-in-this-save");
  assert.equal(policy.selected(unknown, "a"), "a");
  assert.equal(policy.selected(unknown, "missing"), null);
  assert.equal(policy.ready(unknown, "a"), false);
  for (const connections of [0, 2, 4]) {
    const result = snapshot();
    result.nativeRefresh.connections = connections;
    assert.equal(policy.gameCharacter(result), null);
    assert.equal(policy.ready(result, "a"), false);
  }
  const stale = snapshot();
  stale.nativeRefresh.available = false;
  assert.equal(policy.selected(stale, "b"), "b");
  assert.equal(policy.ready(stale, "b"), false);
});

function browser() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: id === "character" ? "a" : "",
        textContent: "",
        hidden: false,
      });
    return elements.get(id);
  };
  const calls = [],
    adopted = [],
    notices = [],
    reviews = [];
  let next = async () => snapshot();
  const context = vm.createContext({
    $: element,
    LiveSession: policy,
    liveConnected: true,
    liveSessionRequested: true,
    liveWritesReady: true,
    autoDiscoverLive: false,
    connected: true,
    pending: false,
    buildBusy: false,
    addingSlots: false,
    connectionGeneration: 1,
    revision: "old",
    characters: snapshot().characters,
    currentVersion: "1.14.7",
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      hidden: false,
      addEventListener() {},
      dispatchEvent() {},
      querySelectorAll: () => reviews,
    },
    setInterval() {},
    api: async (route) => {
      calls.push(route);
      return next();
    },
    notice: (message) => notices.push(message),
    updateReview() {},
    refreshBuildButton() {},
    refreshPresetExportButton() {},
  });
  context.version = () => context.currentVersion;
  context.settingsVersion = context.version;
  context.selectedCharacter = () =>
    context.characters.find(
      (character) => character.id === element("character").value,
    );
  context.fillCharacters = (result) => {
    adopted.push(result);
    element("character").value =
      policy.selected(result, element("character").value) || "";
    context.characters = result.characters;
    context.revision = result.revision;
    context.connected = policy.ready(result, element("character").value);
    context.showLive(result);
  };
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/live-ui.js"), "utf8"),
    context,
  );
  return {
    context,
    calls,
    adopted,
    notices,
    reviews,
    element,
    respond: (callback) => {
      next = callback;
    },
  };
}

test("Repeated game autosaves refresh the current revision without a reconnect or profile change", async () => {
  const f = browser();
  for (let tick = 0; tick < 40; tick++) {
    f.respond(async () => snapshot("revision-" + tick));
    assert.equal(await f.context.refreshLiveNow(), true);
    assert.equal(f.context.revision, "revision-" + tick);
    assert.equal(f.element("character").value, "a");
  }
  assert.equal(f.calls.length, 40);
  assert(f.calls.every((route) => route === "live-status"));
  assert.equal(f.context.connected, true);
});

test("A transient outage pauses writes, shows reconnecting, retains the profile and resumes automatically", async () => {
  const f = browser();
  f.respond(async () => {
    throw Error("temporary backend outage");
  });
  assert.equal(await f.context.refreshLiveNow(), false);
  assert.equal(f.context.connected, false);
  assert.equal(f.context.liveSessionRequested, true);
  assert.match(f.element("connection").textContent, /Reconnecting/);
  assert.equal(f.element("character").value, "a");
  f.respond(async () => snapshot("recovered"));
  assert.equal(await f.context.refreshLiveNow(), true);
  assert.match(f.element("connection").textContent, /Live · First Slayer/);
  assert.equal(f.context.revision, "recovered");
});

test("Changed game data invalidates an open review rather than silently changing a confirmed write", async () => {
  const f = browser();
  let closed = 0;
  f.reviews.push(
    { id: "confirm", close: () => closed++ },
    {
      id: "settings-dialog",
      close: () => assert.fail("Settings must remain open"),
    },
  );
  await f.context.refreshLiveNow();
  assert.equal(closed, 1);
  assert.equal(f.notices.length, 1);
  assert(f.calls.every((route) => route === "live-status"));
});

test("Late status from an old version cannot overwrite a newer UI selection", async () => {
  const f = browser();
  let resolve;
  f.respond(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.context.refreshLiveNow();
  f.context.connectionGeneration++;
  f.context.currentVersion = "1.6.2";
  resolve(snapshot());
  assert.equal(await pending, false);
  assert.equal(f.adopted.length, 0);
  assert.equal(f.context.revision, "old");
});

test("An in-flight write prevents poll results from rebasing the revision under that write", async () => {
  const f = browser();
  f.context.pending = true;
  await f.context.refreshLiveNow();
  assert.equal(f.adopted.length, 0);
  assert.equal(f.context.revision, "old");
});
