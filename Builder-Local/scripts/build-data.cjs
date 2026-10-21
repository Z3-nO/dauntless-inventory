"use strict";

// Rebuild the browser datasets from credited, pinned upstream sources.
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "sources");
const output = path.join(root, "public", "data");
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(source, name), "utf8"));
const catalogues = read("catalogues.json");
const legacy = read("data162.json");
const mappings = read("legacy-mappings.json");
const normalize = (value) =>
  String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const groups = {
  weapons: "Weapons",
  armours: "Armour",
  cells: "Cells",
  parts: "Weapon parts",
  lanterns: "Lanterns",
  omnicells: "Omnicells",
};

function nativeId(name, category, version) {
  const matches = catalogues[version].filter(
    (item) =>
      item.group === groups[category] &&
      normalize(item.name) === normalize(name),
  );
  return matches.length === 1 ? matches[0].id : null;
}

function files(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? files(file)
        : file.endsWith(".yml")
          ? [file]
          : [];
    })
    .sort();
}

// Values belong to their individual effect/tier, not to a different game version.
function resolve(value, inherited = {}) {
  if (typeof value === "string")
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) =>
      inherited[key] == null ? match : String(inherited[key]),
    );
  if (Array.isArray(value))
    return value.map((item) => resolve(item, inherited));
  if (!value || typeof value !== "object") return value;
  const context = { NL: "\n", ...inherited, ...value.values };
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "values")
      .map(([key, item]) => [
        key,
        resolve(item, {
          ...context,
          ...(key === "passive"
            ? value.passive_values
            : key === "active"
              ? value.active_values
              : {}),
        }),
      ]),
  );
}

function normalizeLevels(item) {
  for (const field of ["power", "resistance"])
    if (item[field]) {
      const values = item[field];
      item[field] = { 0: values.base };
      if (typeof values.powerSurged === "number")
        item[field][1] = values.powerSurged;
    }
  for (const field of ["perks", "unique_effects"])
    if (item[field]) {
      item[field] = item[field].map((effect) => {
        if (typeof effect.powerSurged !== "boolean") return effect;
        const { powerSurged, ...rest } = effect;
        return { ...rest, from: powerSurged ? 1 : 0, to: powerSurged ? 1 : 0 };
      });
    }
  return item;
}

for (const category of Object.keys(legacy)) {
  legacy[category].forEach((item, index) => {
    if (category === "perks") return; // Perk key arrays are gameplay metadata, not build identifiers.
    item.key = `legacy/${category}/${index}`;
    item.catalogId =
      mappings[category]?.[index] || nativeId(item.name, category, "1.6.2");
  });
}
legacy.omnicells = [];
legacy.version = "1.6.2";
legacy.provenance =
  "Dauntless Forever Builder / legacy 1.6.1 data, preserving original 162 code indexes.";

const modern = {
  version: "1.14.7",
  provenance:
    "Reforged data snapshot d3ec4a1a26c4d189792e7bd2e824df4cb080756b (2024-03-28), upstream balance label 1.14.6; target client 1.14.7 CL647472. Catalogue from installed Forever 1.14.7.",
};
const baseDirectory = path.join(source, "reforged", "data");
for (const category of [...Object.keys(groups), "perks"]) {
  modern[category] = files(path.join(baseDirectory, category))
    .map((file) => {
      const raw = yaml.load(fs.readFileSync(file, "utf8"));
      const relative = path
        .relative(baseDirectory, file)
        .replaceAll(path.sep, "/");
      const item = normalizeLevels(
        resolve(raw, {
          ...raw.values,
          type: raw.type?.toLowerCase(),
          typeAlt:
            { Head: "Head", Torso: "Torso", Arms: "Arm", Legs: "Leg" }[
              raw.type
            ] || raw.type,
          behemoth: raw.behemoth,
        }),
      );
      item.key = relative.replace(/\.yml$/, "");
      item.catalogId = nativeId(item.name, category, "1.14.7");
      item.source = raw.behemoth || relative.split("/")[1];
      if (category === "parts") {
        item.weaponType = relative.split("/")[1];
        item.partKind = relative.split("/")[2];
      }
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

const oldGearNames = new Set(
  ["weapons", "armours", "lanterns", "cells", "parts"].flatMap((category) =>
    legacy[category].map((item) => normalize(item.name)),
  ),
);
for (const category of Object.keys(groups))
  for (const item of modern[category])
    item.newSince162 = !oldGearNames.has(normalize(item.name));

// Upstream includes later-client entries in its legacy catalogue. Only publish
// identifiers present in that version's inspected native client catalogue.
const nativeValidation = read("catalog-validation.json");
for (const version of Object.keys(catalogues)) {
  const absent = new Set(nativeValidation[version].removed);
  catalogues[version] = catalogues[version].filter(
    (item) => !absent.has(item.id),
  );
}
const ids162 = new Set(catalogues["1.6.2"].map((item) => item.id));
for (const version of Object.keys(catalogues)) {
  const corrected = new Map(
    nativeValidation[version].storageCorrections.map((item) => [
      item.id,
      item.after,
    ]),
  );
  for (const item of catalogues[version])
    if (corrected.has(item.id)) item.storage = corrected.get(item.id);
}
for (const [version, list] of Object.entries(catalogues)) {
  for (const item of list)
    item.newIdentifier = version === "1.14.7" && !ids162.has(item.id);
}
fs.mkdirSync(output, { recursive: true });
for (const [file, value] of Object.entries({
  "1.6.2.json": legacy,
  "1.14.7.json": modern,
  "catalogues.json": catalogues,
}))
  fs.writeFileSync(path.join(output, file), JSON.stringify(value) + "\n");
const unresolved = JSON.stringify(modern).match(/\{\{[^}]+\}\}/g) || [];
const report = {
  legacy: Object.fromEntries(
    Object.keys(groups).map((key) => [key, legacy[key].length]),
  ),
  modern: Object.fromEntries(
    Object.keys(groups).map((key) => [key, modern[key].length]),
  ),
  perks: modern.perks.length,
  catalogue: Object.fromEntries(
    Object.entries(catalogues).map(([v, list]) => [v, list.length]),
  ),
  unresolvedTemplates: [...new Set(unresolved)],
};
fs.writeFileSync(
  path.join(output, "coverage.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
