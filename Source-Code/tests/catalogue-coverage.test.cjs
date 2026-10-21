"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { catalogs, applyItems, requireItem } = require("../inventory.cjs");
const validation = require("../data/catalog-validation.json");

test("Internal debug items and unequipped placeholders are hidden and rejected before any inventory write", () => {
  const visibility = require("../public/visibility.js");
  for (const version of Object.keys(catalogs)) {
    const internal = validation[version].hiddenInternalPlayerPlaceholders;
    assert(internal.length > 0);
    const inventory = { stackedItems: [], instancedItems: [] };
    for (const id of internal) {
      assert.equal(
        visibility.catalog(catalogs, version).some((item) => item.id === id),
        false,
        id,
      );
      assert.throws(
        () => applyItems(inventory, { [id]: 1 }, "add", version),
        /cannot be edited/,
      );
      assert.deepEqual(inventory, { stackedItems: [], instancedItems: [] });
    }
  }
});

for (const version of Object.keys(catalogs)) {
  test(
    version +
      ": every editable catalogue item roundtrips with its native storage; add/set/zero and repeated equipment grants",
    () => {
      const entries = catalogs[version].filter((item) => item.editable);
      const empty = { stackedItems: [], instancedItems: [], keep: true };
      const changes = Object.fromEntries(
        entries.map((item) => [
          item.id,
          item.storage === "instance" || item.singleton ? 1 : 7,
        ]),
      );
      const granted = applyItems(empty, changes, "set", version, false);
      assert.deepEqual(empty, {
        stackedItems: [],
        instancedItems: [],
        keep: true,
      });
      assert.equal(granted.keep, true);
      const added = applyItems(granted, changes, "add", version, false);
      assert.equal(added.instancedItems.length, granted.instancedItems.length);
      for (const item of entries) {
        const instances = added.instancedItems.filter(
          (row) => row.catalogId === item.id,
        );
        const stacks = added.stackedItems.filter(
          (row) => row.catalogId === item.id,
        );
        if (item.storage === "instance") {
          assert.equal(instances.length, 1, item.id);
          assert.equal(instances[0].itemData, null, item.id);
          assert.equal(stacks.length, 0, item.id);
        } else {
          assert.equal(stacks.length, 1, item.id);
          assert.equal(stacks[0].quantity, item.singleton ? 1 : 14, item.id);
          assert.equal(instances.length, 0, item.id);
        }
      }
      const zeroes = Object.fromEntries(
        entries
          .filter((item) => item.storage === "stack")
          .map((item) => [item.id, 0]),
      );
      const cleared = applyItems(added, zeroes, "set", version, false);
      assert.equal(cleared.stackedItems.length, 0);
      assert.deepEqual(cleared.instancedItems, added.instancedItems);
      for (const item of catalogs[version].filter((item) => !item.editable))
        assert.throws(() => requireItem(version, item.id));
      assert.equal(validation[version].retained, catalogs[version].length);
      for (const id of validation[version].removed)
        assert.throws(() => requireItem(version, id));
    },
  );
}

test("Legacy categories exclude all omnicells and native-absent entries; modern keeps its six omnicells", () => {
  assert.equal(
    catalogs["1.6.2"].some((item) => item.group === "Omnicells"),
    false,
  );
  assert.equal(
    catalogs["1.14.7"].filter((item) => item.group === "Omnicells").length,
    6,
  );
  assert.equal(
    catalogs["1.6.2"].find((item) => item.id === "AC_HEAD_ARMSTRONG_00")
      .storage,
    "stack",
  );
  assert.throws(() =>
    applyItems(
      { stackedItems: [], instancedItems: [] },
      { PR_DISCIPLINE: 1 },
      "set",
      "1.6.2",
      false,
    ),
  );
});
