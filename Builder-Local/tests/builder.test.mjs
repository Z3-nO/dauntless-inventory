import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import {
  ARMOUR,
  SOCKETS,
  emptyBuild,
  encodeBuild,
  decodeBuild,
  socketKind,
} from "../public/build-code.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const datasets = {
  "1.6.2": read("public/data/1.6.2.json"),
  "1.14.7": read("public/data/1.14.7.json"),
};
const classicCode =
  "162.WzUxLDEsWzY1LDY5LC0xLC0xLC0xLC0xXSxbWzMwLDFdLFszMSwxXSxbMjksMV0sWzMyLDFdXSw2LFs4OSw3NywxMjgsMTM3LDk1LDkyLDE1OF1d";
const wrap = (object) =>
  "1147." + Buffer.from(JSON.stringify(object)).toString("base64url");
const unpack = (code) => JSON.parse(Buffer.from(code.slice(5), "base64url"));
function modernBuild() {
  const data = datasets["1.14.7"],
    state = emptyBuild();
  state.w = data.weapons.findIndex((item) => item.name === "Cyclonic Fury");
  state.bond = data.weapons.findIndex(
    (item) => item.type === "Sword" && item.elemental === "Shock" && !item.bond,
  );
  for (const slot of ARMOUR)
    state.a[slot].i = data.armours.findIndex(
      (item) => item.type === slot && item.resistance[1] !== undefined,
    );
  state.lan = data.lanterns.findIndex((item) => item.name === "Shrike's Zeal");
  state.omni = data.omnicells.findIndex((item) => item.name === "Discipline");
  for (const socket of SOCKETS) {
    const kind = socketKind(state, data, socket);
    if (kind) {
      const index = data.cells.findIndex(
        (item) => kind === "Prismatic" || item.slot === kind,
      );
      state.cells[socket] = [index, 2];
    }
  }
  state.parts.mods = data.parts.findIndex(
    (item) => item.weaponType === "sword" && item.partKind === "mods",
  );
  return state;
}

test("Classic 162 codes preserve original indexes and the complete original build", () => {
  const { version, state } = decodeBuild(classicCode, datasets);
  assert.equal(version, "1.6.2");
  assert.equal(encodeBuild(state, version, datasets[version]), classicCode);
  assert.equal(datasets[version].weapons[state.w].name, "Inferno's Razor");
  assert.equal(Object.keys(state.cells).length, 7);
  assert.deepEqual(
    decodeBuild(
      "https://builder.dauntlessforever.com/#" + classicCode,
      datasets,
    ).state,
    state,
  );
  assert.deepEqual(decodeBuild("#" + classicCode, datasets).state, state);
});

test("Modern build roundtrip retains stable item keys, levels, parts, omnicell, bond and all cells", () => {
  const state = modernBuild(),
    code = encodeBuild(state, "1.14.7", datasets["1.14.7"]),
    loaded = decodeBuild(code, datasets);
  assert.equal(loaded.version, "1.14.7");
  assert.deepEqual(loaded.state, state);
  assert.equal(unpack(code).omnicell, "omnicells/Discipline");
  assert.deepEqual(
    decodeBuild("http://127.0.0.1:49316/#" + code, datasets),
    loaded,
  );
});

test("Malformed and incompatible modern imports fail rather than discard selected items", () => {
  const original = unpack(
    encodeBuild(modernBuild(), "1.14.7", datasets["1.14.7"]),
  );
  for (const change of [
    (value) => (value.weapon[0] = "weapons/not-present"),
    (value) => (value.cells.w0[1] = 4),
    (value) => (value.cells.unexpected = ["cells/finesse/CunningCell", 3]),
    (value) => (value.armour.Head = value.armour.Torso),
    (value) => (value.bond = value.weapon[0]),
    (value) =>
      (value.parts.mods = "parts/aetherstrikers/mods/CyclonicStrikeplate"),
    (value) => (value.weapon[1] = 15),
    (value) => (value.version = "1.6.2"),
  ]) {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => decodeBuild(wrap(value), datasets));
  }
  assert.throws(() => decodeBuild("1148.test", datasets), /version/);
  assert.throws(() => decodeBuild("1147.!!!", datasets));
  assert.throws(() => decodeBuild("x".repeat(25000), datasets));
});

test("Every modern weapon and armour piece survives code export/import at its supported level", () => {
  const data = datasets["1.14.7"];
  for (let i = 0; i < data.weapons.length; i++) {
    const state = emptyBuild();
    state.w = i;
    state.wl = data.weapons[i].power?.[1] === undefined ? 0 : 1;
    assert.deepEqual(
      decodeBuild(encodeBuild(state, data.version, data), datasets).state,
      state,
    );
  }
  for (let i = 0; i < data.armours.length; i++) {
    const item = data.armours[i],
      state = emptyBuild();
    state.a[item.type] = { i, l: item.resistance?.[1] === undefined ? 0 : 1 };
    assert.deepEqual(
      decodeBuild(encodeBuild(state, data.version, data), datasets).state,
      state,
    );
  }
});

test("Modern sockets reject legacy families, wrong ranks and incompatible cell placement", () => {
  const data = datasets["1.14.7"],
    state = modernBuild(),
    head = data.armours[state.a.Head.i];
  const wrong = data.cells.findIndex((cell) => cell.slot !== head.cells);
  state.cells.Head = [wrong, 2];
  assert.throws(
    () => decodeBuild(encodeBuild(state, data.version, data), datasets),
    /does not fit/,
  );
  assert.deepEqual([...new Set(data.cells.map((cell) => cell.slot))].sort(), [
    "Alacrity",
    "Brutality",
    "Finesse",
    "Fortitude",
    "Insight",
  ]);
  assert.equal(
    data.cells.some((cell) => cell.name === "Discipline Cell"),
    false,
  );
  assert.equal(
    data.omnicells.some((cell) => cell.name === "Discipline"),
    true,
  );
});

test("Both catalogues retain native-supported source entries and exclude entries from other client versions", () => {
  const source = read("sources/catalogues.json"),
    generated = read("public/data/catalogues.json");
  const validation = read("sources/catalog-validation.json");
  for (const version of Object.keys(source))
    assert.deepEqual(
      generated[version].map((item) => item.id),
      source[version]
        .filter((item) => !validation[version].removed.includes(item.id))
        .map((item) => item.id),
    );
  assert.equal(generated["1.6.2"].length, 5407);
  assert.equal(generated["1.14.7"].length, 5805);
  assert.equal(
    generated["1.6.2"].some((item) => item.group === "Omnicells"),
    false,
  );
  const old = new Set(generated["1.6.2"].map((item) => item.id));
  assert.equal(
    generated["1.14.7"].filter((item) => item.newIdentifier).length,
    source["1.14.7"].filter((item) => !old.has(item.id)).length,
  );
});

test("Legacy metadata is preserved while modern balance and templates remain separate", () => {
  const source = read("sources/data162.json"),
    legacy = datasets["1.6.2"],
    modern = datasets["1.14.7"];
  for (const category of Object.keys(source))
    for (let i = 0; i < source[category].length; i++) {
      if (category === "perks") {
        assert.deepEqual(legacy[category][i], source[category][i]);
        continue;
      }
      const { key, catalogId, ...item } = legacy[category][i];
      assert.deepEqual(item, source[category][i]);
    }
  assert.equal(JSON.stringify(modern).includes("{{"), false);
  assert.equal(modern.omnicells.length, 6);
  assert.equal(modern.weapons.length, 231);
  assert.equal(modern.armours.length, 139);
  assert.notDeepEqual(
    modern.perks.find((item) => item.name === "Rage").effects,
    legacy.perks.find((item) => item.name === "Rage").effects,
  );
});

test("Every planner icon resolves offline and every category has unique stable keys", () => {
  const old = read("public/data/icons162.json"),
    modern = read("public/data/icons1147.json");
  for (const data of Object.values(datasets))
    for (const category of [
      "weapons",
      "armours",
      "lanterns",
      "parts",
      "omnicells",
    ]) {
      assert.equal(
        new Set(data[category].map((item) => item.key)).size,
        data[category].length,
      );
      for (const item of data[category])
        if (item.icon) {
          const file =
            (data.version === "1.14.7" ? modern[item.icon] : null) ||
            old[item.icon];
          assert.ok(file, item.name);
          assert.ok(
            fs.statSync(path.join(root, "public", file)).size > 0,
            item.name,
          );
        }
    }
  const fonts = fs.readFileSync(path.join(root, "public/fonts.css"), "utf8");
  assert.equal(/https?:/.test(fonts), false);
});

test("Local server serves both versions and refuses writes, traversal, nonlocal hosts and runtime downloads", async () => {
  const require = createRequire(import.meta.url),
    { createServer } = require("../server.cjs"),
    server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const file of [
      "/",
      "/app.js",
      "/build-code.mjs",
      "/catalogue.mjs",
      "/data/1.6.2.json",
      "/data/1.14.7.json",
      "/data/catalogues.json",
      "/assets/helmet.webp",
    ]) {
      const response = await fetch(base + file);
      assert.equal(response.status, 200, file);
      assert.match(
        response.headers.get("content-security-policy"),
        /connect-src 'self'/,
      );
      await response.arrayBuffer();
    }
    assert.equal(
      (await fetch(base + "/api/apply", { method: "POST", body: "{}" })).status,
      405,
    );
    assert.equal((await fetch(base + "/runtime/node.exe")).status, 404);
    assert.equal((await fetch(base + "/%2e%2e%2fserver.cjs")).status, 404);
    const rejected = await new Promise((resolve, reject) => {
      const request = http.get(
        base,
        { headers: { Host: "untrusted.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    });
    assert.equal(rejected, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
