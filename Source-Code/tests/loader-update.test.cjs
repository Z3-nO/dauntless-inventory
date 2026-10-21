const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedModernLoader } = require("../live-native.cjs");

const previous =
  "baa606152802b1aedac17a45c8c613511383b2c87ddc2d927a9d2c185fbe3222";
const current =
  "cfe9b7b336b67676d4b071d9cc210fc375a04b2b4d3c399927828e3ea479dcf2";

test("Both inspected Forever loader releases are accepted only when package and game agree", () => {
  for (const value of [previous, current]) {
    assert.equal(verifiedModernLoader([value, value]), value);
  }
  assert.throws(
    () => verifiedModernLoader([previous, current]),
    /different loader versions/,
  );
  assert.throws(
    () => verifiedModernLoader([current, previous]),
    /different loader versions/,
  );
});

test("Unknown, corrupted or incomplete loader pairs remain blocked", () => {
  for (const hashes of [
    [],
    [current],
    [current, current, current],
    ["0".repeat(64), "0".repeat(64)],
    [current, "0".repeat(64)],
  ]) {
    assert.throws(() => verifiedModernLoader(hashes), /not supported/);
  }
});
