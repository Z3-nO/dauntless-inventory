import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { emptyBuild, encodeBuild, decodeBuild } from "../public/build-code.mjs";
const datasets = Object.fromEntries(
  ["1.6.2", "1.14.7"].map((v) => [
    v,
    JSON.parse(
      fs.readFileSync(
        new URL("../public/data/" + v + ".json", import.meta.url),
      ),
    ),
  ]),
);
test("Legacy optional bond record retains the native preset bond; existing six-record codes remain unchanged", () => {
  const d = datasets["1.6.2"],
    s = emptyBuild();
  s.w = d.weapons.findIndex((x) => x.name === "Sanity Check");
  const original = encodeBuild(s, "1.6.2", d);
  assert.equal(
    JSON.parse(Buffer.from(original.slice(4), "base64url")).length,
    6,
  );
  s.bond = d.weapons.findIndex((x) => x.name === "Fall of Night");
  const code = encodeBuild(s, "1.6.2", d);
  assert.equal(JSON.parse(Buffer.from(code.slice(4), "base64url")).length, 7);
  assert.deepEqual(decodeBuild(code, datasets).state, s);
  const raw = JSON.parse(Buffer.from(code.slice(4), "base64url"));
  raw[6] = { bond: 99999 };
  assert.throws(() =>
    decodeBuild(
      "162." + Buffer.from(JSON.stringify(raw)).toString("base64url"),
      datasets,
    ),
  );
});
