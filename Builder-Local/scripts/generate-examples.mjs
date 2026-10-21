import fs from "node:fs";
import {
  emptyBuild,
  encodeBuild,
  decodeBuild,
  ARMOUR,
  SOCKETS,
  socketKind,
} from "../public/build-code.mjs";
const root = new URL("../", import.meta.url),
  read = (file) => JSON.parse(fs.readFileSync(new URL(file, root), "utf8"));
const data = read("public/data/1.14.7.json"),
  legacy = read("public/data/1.6.2.json"),
  datasets = { "1.6.2": legacy, "1.14.7": data };
const find = (category, name) => {
  const index = data[category].findIndex((item) => item.name === name);
  if (index < 0) throw Error("Missing example component: " + name);
  return index;
};
const state = emptyBuild();
state.w = find("weapons", "Cyclonic Fury");
state.bond = find("weapons", "Sahvyt's Cutlass");
state.lan = find("lanterns", "Shrike's Zeal");
state.omni = find("omnicells", "Discipline");
const armours = {
  Head: "Hellplate Casque",
  Torso: "Hellplate Cuirass",
  Arms: "Hellplate Bracers",
  Legs: "Hellplate Greaves",
};
for (const slot of ARMOUR) state.a[slot].i = find("armours", armours[slot]);
state.parts.mods = find("parts", "Keen Edge");
state.parts.specials = find("parts", "Ardent Cyclone");
const cells = {
  w0: "Cunning Cell",
  w1: "Pulse Cell",
  Head: "Predator Cell",
  Torso: "Cunning Cell",
  Arms: "Berserker Cell",
  Legs: "Ragehunter Cell",
  lan: "Conduit Cell",
};
for (const slot of SOCKETS) {
  const index = find("cells", cells[slot]),
    kind = socketKind(state, data, slot);
  if (kind !== "Prismatic" && kind !== data.cells[index].slot)
    throw Error("Example cell does not fit " + slot);
  state.cells[slot] = [index, 2];
}
const classic =
  "162.WzUxLDEsWzY1LDY5LC0xLC0xLC0xLC0xXSxbWzMwLDFdLFszMSwxXSxbMjksMV0sWzMyLDFdXSw2LFs4OSw3NywxMjgsMTM3LDk1LDkyLDE1OF1d";
const modern = encodeBuild(state, "1.14.7", data);
decodeBuild(modern, datasets);
decodeBuild(classic, datasets);
fs.mkdirSync(new URL("examples", root), { recursive: true });
for (const [version, name, code, file] of [
  ["1.6.2", "Hellion · Classic", classic, "1.6.2-hellion.dfbuild.json"],
  [
    "1.14.7",
    "Shock legendary · Reforged",
    modern,
    "1.14.7-shock-legendary.dfbuild.json",
  ],
]) {
  fs.writeFileSync(
    new URL("examples/" + file, root),
    JSON.stringify(
      { format: "dauntless-local-build", schema: 1, version, name, code },
      null,
      2,
    ) + "\n",
  );
}
console.log("Generated and validated both example build files.");
