const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../public/visibility.js");
const catalogs = require("../data/catalogs.json");

test("Version selection excludes unsupported entries and never carries modern omnicells into legacy", () => {
  const legacy = policy.catalog(catalogs, "1.6.2");
  const modern = policy.catalog(catalogs, "1.14.7");
  assert.equal(legacy.length, 4429);
  assert.equal(modern.length, 5778);
  assert.equal(
    legacy.some((x) => x.group === "Omnicells"),
    false,
  );
  assert.equal(modern.filter((x) => x.group === "Omnicells").length, 6);
  for (const rows of [legacy, modern]) {
    assert.equal(
      rows.some((x) => x.group === "Unverified technical entries"),
      false,
    );
    assert.equal(
      rows.some((x) => x.id === "TOKEN_CELL_EXCHANGE"),
      false,
    );
  }
  assert.deepEqual(policy.catalog(catalogs, "unsupported"), []);
  assert.equal(
    catalogs["1.6.2"].some((x) => !x.editable),
    true,
    "Keep source catalogue and save rules intact",
  );
});

test("Preset controls hide unavailable indices, retain all valid slots beyond three and hide creation in Live", () => {
  const character = {
    slots: Array.from({ length: 16 }, (_, index) => ({
      index,
      saved: true,
      available: true,
    })),
    slotInfo: { canAdd: true },
  };
  character.slots[2].saved = false;
  character.slots[5].available = false;
  assert.deepEqual(
    policy.slots(character).map((x) => x.index),
    [0, 1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.equal(policy.canAdd(character, false), true);
  assert.equal(policy.canAdd(character, true), false);
  character.slotInfo.canAdd = false;
  assert.equal(policy.canAdd(character, false), false);
  assert.equal(policy.canAdd(null, false), false);
});
