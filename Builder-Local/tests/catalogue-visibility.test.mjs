import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { visibleCatalogue } from "../public/catalogue.mjs";

const catalogues = JSON.parse(
  fs.readFileSync(new URL("../public/data/catalogues.json", import.meta.url)),
);
test("Catalogue hides unsupported and internal entries, derives categories from visible items, and keeps Omnicells version-specific", () => {
  for (const version of ["1.6.2", "1.14.7"]) {
    const visible = visibleCatalogue(catalogues, version);
    assert.equal(visible.length, version === "1.6.2" ? 4429 : 5778);
    assert.equal(
      visible.some(
        (item) =>
          /(?:^|_)(?:DEBUG|TEST|UNEQUIPPED)(?:_|$)/i.test(item.id) &&
          item.id !== "AR_UNEQUIPPED_HELM",
      ),
      false,
    );
    assert.equal(
      visible.some((item) => item.group === "Unverified technical entries"),
      false,
    );
    assert.equal(
      visible.filter((item) => item.group === "Omnicells").length,
      version === "1.6.2" ? 0 : 6,
    );
  }
  assert.deepEqual(visibleCatalogue(catalogues, "unknown"), []);
});
