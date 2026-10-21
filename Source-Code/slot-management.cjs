"use strict";
const fs = require("node:fs");
const path = require("node:path");

const isSlot = (s) => s && typeof s === "object" && !Array.isArray(s);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function read(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8");
  } catch {
    return "";
  }
}
function sqliteSlotInfo(root, slots) {
  const env = read(root, "backend/metagame/.env");
  const explicit = env.match(
    /^\s*(?:export\s+)?LOADOUT_SLOTS\s*=\s*["']?(\d+)["']?\s*(?:#.*)?$/m,
  );
  const source =
    read(root, "backend/metagame/dist/controllers/loadout.js") ||
    read(root, "backend/metagame/src/controllers/loadout.ts");
  const fallback = source.match(/process\.env\.LOADOUT_SLOTS\s*\?\?\s*(\d+)/);
  const limit = explicit || fallback ? Number((explicit || fallback)[1]) : null;
  const valid = integer(limit) && limit > 0 && limit <= 1024;
  return describe(
    slots,
    valid ? limit : slots.length,
    valid ? limit : null,
    explicit
      ? "LOADOUT_SLOTS in backend/metagame/.env"
      : valid
        ? "Installed metagame server default"
        : "Saved slots only; server limit unavailable",
  );
}
function jsonSlotInfo(root, player, characterId, slots) {
  const source = read(root, "backend/loadouts-fix1147.js");
  const limits = source.match(/\bMAX\s*=\s*(\d+)\s*,\s*PATH_SLOTS\s*=\s*(\d+)/);
  const maximum = limits ? Number(limits[1]) : null;
  const pathMaximum = limits ? Number(limits[2]) : null;
  const valid =
    integer(maximum) &&
    maximum > 0 &&
    maximum <= 1024 &&
    integer(pathMaximum) &&
    pathMaximum < maximum;
  if (!valid)
    return describe(
      slots,
      slots.length,
      null,
      "Saved slots only; server limit unavailable",
    );
  const metadata = player.loadoutSlots1147;
  const nodes = Object.entries(player.pjmMaps?.main?.nodes || {});
  let earned = 0;
  for (let i = 1; i <= pathMaximum; i++) {
    if (
      nodes.some(
        ([key, n]) =>
          (n?.node_id || key) === "LoadoutSlot_" + String(i).padStart(2, "0") &&
          n.node_status === 2,
      )
    )
      earned++;
  }
  const savedPath = metadata?.characters?.[characterId];
  const characterSlots = Math.max(
    earned,
    integer(savedPath) && savedPath <= pathMaximum ? savedPath : 0,
  );
  const maxAccountSlots = maximum - pathMaximum;
  const rawAccount = metadata?.account;
  const accountSlots = Math.max(
    integer(rawAccount) && rawAccount >= 1 && rawAccount <= maxAccountSlots
      ? rawAccount
      : 1,
    Math.min(maxAccountSlots, Math.max(1, slots.length - characterSlots)),
  );
  const retained = Math.max(characterSlots, slots.length - accountSlots);
  return {
    ...describe(
      slots,
      Math.min(maximum, accountSlots + retained),
      maxAccountSlots + characterSlots,
      "Installed 1.14.7 server and saved Slayer Path unlocks",
    ),
    serverLimit: maximum,
    accountSlots,
    characterSlots,
    maxAccountSlots,
  };
}
function describe(slots, available, limit, source) {
  const saved = slots.filter(isSlot).length;
  return {
    saved,
    available: Math.max(slots.length, available),
    limit,
    canAdd:
      limit !== null &&
      (saved < Math.max(slots.length, available) || slots.length < limit),
    source,
  };
}
function listSlots(slots, info) {
  return Array.from({ length: info.available }, (_, index) => ({
    index,
    name:
      slots[index]?.custom_name ||
      (isSlot(slots[index]) ? "Loadout " + (index + 1) : "Not saved yet"),
    saved: isSlot(slots[index]),
    available: info.limit === null || index < info.limit,
  }));
}
function createSlots(character, sourceSlot, count) {
  const { loadouts, slotInfo } = character;
  if (!integer(sourceSlot) || !isSlot(loadouts[sourceSlot]))
    throw Error("Explicitly select an existing slot to copy.");
  if (!integer(count) || count < 1)
    throw Error("Enter a positive whole number of slots to add.");
  if (!slotInfo.canAdd || slotInfo.limit === null)
    throw Error(
      "The connected server does not provide a verified slot limit, or its limit has been reached.",
    );
  const result = structuredClone(loadouts),
    created = [];
  for (let i = 0; i < slotInfo.limit && created.length < count; i++) {
    if (isSlot(result[i])) continue;
    const clone = structuredClone(loadouts[sourceSlot]);
    clone.slot_index = i;
    clone.custom_name = "Loadout " + (i + 1);
    clone.update_version = 0;
    result[i] = clone;
    created.push(i);
  }
  if (created.length !== count)
    throw Error(
      "Requested slots exceed the connected server's available limit.",
    );
  return {
    inv: character.inv,
    loadouts: result,
    created,
    accountSlots:
      slotInfo.maxAccountSlots == null
        ? null
        : Math.max(
            slotInfo.accountSlots,
            result.length - slotInfo.characterSlots,
          ),
  };
}
module.exports = { sqliteSlotInfo, jsonSlotInfo, listSlots, createSlots };
