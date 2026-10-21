// Versioned build codes. Legacy indexes remain unchanged; modern codes use stable keys.
export const ARMOUR = ["Head", "Torso", "Arms", "Legs"];
export const SOCKETS = ["w0", "w1", ...ARMOUR, "lan"];
export const PART_KINDS = [
  "mods",
  "specials",
  "barrels",
  "chambers",
  "grips",
  "prisms",
];
export const WEAPON_PART_TYPES = {
  "Aether Strikers": "aetherstrikers",
  Axe: "axe",
  "Chain Blades": "chainblades",
  Hammer: "hammer",
  Repeater: "repeater",
  Sword: "sword",
  "War Pike": "warpike",
};

export function emptyBuild() {
  return {
    w: -1,
    wl: 1,
    parts: {},
    a: Object.fromEntries(ARMOUR.map((key) => [key, { i: -1, l: 1 }])),
    lan: -1,
    cells: {},
    omni: -1,
    bond: -1,
  };
}

function bytesToCode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromCode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("The build code contains invalid characters.");
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(
        Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      ),
    );
  } catch {
    throw Error("The build code could not be decoded.");
  }
}

export function socketKind(state, data, socket) {
  if (socket === "w0" || socket === "w1")
    return data.weapons[state.w]?.cells?.[socket === "w0" ? 0 : 1] || null;
  if (socket === "lan") return data.lanterns[state.lan]?.cells || null;
  return data.armours[state.a[socket]?.i]?.cells || null;
}

export function validateBuild(state, data) {
  const issues = [],
    weapon = data.weapons[state.w];
  for (const [key, [index, variant]] of Object.entries(state.cells)) {
    const cell = data.cells[index],
      kind = socketKind(state, data, key);
    if (!cell || !Number.isInteger(variant) || variant < 0 || variant > 2)
      issues.push("Invalid cell in " + key + ".");
    else if (!kind || (kind !== "Prismatic" && kind !== cell.slot))
      issues.push(cell.name + " does not fit the " + key + " socket.");
  }
  for (const [kind, index] of Object.entries(state.parts)) {
    const part = data.parts[index];
    if (
      !weapon ||
      part?.weaponType !== WEAPON_PART_TYPES[weapon.type] ||
      part?.partKind !== kind
    )
      issues.push("Incompatible weapon part: " + kind + ".");
    if (kind === "specials" && weapon?.restrict_specials)
      issues.push("This weapon has its own special ability.");
    if (data.version === "1.14.7" && ["barrels", "prisms"].includes(kind))
      issues.push("Modular repeater parts do not belong to 1.14.7.");
  }
  if (state.bond >= 0) {
    const bond = data.weapons[state.bond];
    if (
      !weapon?.bond ||
      !bond ||
      bond.bond ||
      bond.type !== weapon.type ||
      bond.elemental !== weapon.bond.elemental
    )
      issues.push(
        "The bonded weapon must match this legendary weapon's type and element.",
      );
  }
  return issues;
}

export function encodeBuild(state, version, data) {
  if (version === "1.6.2")
    return (
      "162." +
      bytesToCode([
        state.w,
        state.wl,
        PART_KINDS.map((key) => state.parts[key] ?? -1),
        ARMOUR.map((key) => [state.a[key].i, state.a[key].l]),
        state.lan,
        SOCKETS.map((key) =>
          state.cells[key] ? state.cells[key][0] * 3 + state.cells[key][1] : -1,
        ),
        ...(state.bond >= 0 ? [{ bond: state.bond }] : []),
      ])
    );
  if (version !== "1.14.7") throw Error("Unsupported version.");
  const key = (category, index) =>
    index >= 0 ? data[category][index]?.key : null;
  return (
    "1147." +
    bytesToCode({
      format: 1,
      version,
      weapon: [key("weapons", state.w), state.wl],
      parts: Object.fromEntries(
        Object.entries(state.parts).map(([kind, index]) => [
          kind,
          key("parts", index),
        ]),
      ),
      armour: Object.fromEntries(
        ARMOUR.map((slot) => [
          slot,
          [key("armours", state.a[slot].i), state.a[slot].l],
        ]),
      ),
      lantern: key("lanterns", state.lan),
      omnicell: key("omnicells", state.omni),
      bond: key("weapons", state.bond),
      cells: Object.fromEntries(
        Object.entries(state.cells).map(([slot, [index, variant]]) => [
          slot,
          [key("cells", index), variant + 1],
        ]),
      ),
    })
  );
}

export function decodeBuild(input, datasets) {
  if (typeof input !== "string" || input.length > 24000)
    throw Error("The build code is missing or too long.");
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    try {
      code = decodeURIComponent(new URL(code).hash.slice(1));
    } catch {
      throw Error("Invalid build link.");
    }
  }
  code = code.replace(/^#/, "").replace(/^b\./, "");
  const version = code.startsWith("1147.") ? "1.14.7" : "1.6.2";
  if (
    /^\d+\./.test(code) &&
    !code.startsWith("1147.") &&
    !code.startsWith("162.")
  )
    throw Error("Unsupported build version.");
  code = code.replace(/^(?:162|1147)\./, "");
  const value = fromCode(code),
    data = datasets[version],
    state = emptyBuild();
  const index = (n, category) => {
    if (!Number.isInteger(n) || n < -1 || n >= data[category].length)
      throw Error("Unknown " + category + " item in the build.");
    return n;
  };
  const level = (n) => {
    if (n !== 0 && n !== 1)
      throw Error("The equipment level must be Base or Max.");
    return n;
  };
  const lookup = (key, category) => {
    if (key === null) return -1;
    if (typeof key !== "string")
      throw Error("Invalid " + category + " identifier.");
    const i = data[category].findIndex((item) => item.key === key);
    if (i < 0) throw Error("Unknown " + category + " item: " + key);
    return i;
  };
  if (version === "1.6.2") {
    if (
      !Array.isArray(value) ||
      ![6, 7].includes(value.length) ||
      !Array.isArray(value[2]) ||
      value[2].length !== 6 ||
      !Array.isArray(value[3]) ||
      value[3].length !== 4 ||
      !Array.isArray(value[5]) ||
      value[5].length !== 7
    )
      throw Error("Invalid 1.6.2 build structure.");
    if (value.length === 7) {
      const extra = value[6];
      if (
        !extra ||
        typeof extra !== "object" ||
        Array.isArray(extra) ||
        Object.keys(extra).length !== 1 ||
        !Object.hasOwn(extra, "bond")
      )
        throw Error("Invalid legacy build extension.");
      state.bond = index(extra.bond, "weapons");
      if (state.bond < 0) throw Error("Invalid bonded weapon.");
    }
    state.w = index(value[0], "weapons");
    state.wl = level(value[1]);
    state.lan = index(value[4], "lanterns");
    value[2].forEach((n, i) => {
      index(n, "parts");
      if (n >= 0) state.parts[PART_KINDS[i]] = n;
    });
    ARMOUR.forEach((slot, i) => {
      const a = value[3][i];
      if (!Array.isArray(a) || a.length !== 2)
        throw Error("Invalid armour record.");
      state.a[slot] = { i: index(a[0], "armours"), l: level(a[1]) };
    });
    value[5].forEach((n, i) => {
      if (!Number.isSafeInteger(n) || n < -1)
        throw Error("Invalid cell record.");
      if (n >= 0)
        state.cells[SOCKETS[i]] = [index(Math.floor(n / 3), "cells"), n % 3];
    });
  } else {
    if (
      !value ||
      Array.isArray(value) ||
      value.format !== 1 ||
      value.version !== version ||
      !Array.isArray(value.weapon) ||
      value.weapon.length !== 2 ||
      !value.armour ||
      !value.parts ||
      !value.cells
    )
      throw Error("Invalid 1.14.7 build structure.");
    state.w = lookup(value.weapon[0], "weapons");
    state.wl = level(value.weapon[1]);
    state.lan = lookup(value.lantern, "lanterns");
    state.omni = lookup(value.omnicell, "omnicells");
    state.bond = lookup(value.bond, "weapons");
    for (const slot of ARMOUR) {
      const a = value.armour[slot];
      if (!Array.isArray(a) || a.length !== 2)
        throw Error("Invalid armour record.");
      state.a[slot] = { i: lookup(a[0], "armours"), l: level(a[1]) };
    }
    for (const [kind, key] of Object.entries(value.parts)) {
      if (!PART_KINDS.includes(kind)) throw Error("Unknown weapon part slot.");
      state.parts[kind] = lookup(key, "parts");
      if (state.parts[kind] < 0) throw Error("Invalid weapon part.");
    }
    for (const [slot, cell] of Object.entries(value.cells)) {
      if (
        !SOCKETS.includes(slot) ||
        !Array.isArray(cell) ||
        cell.length !== 2 ||
        !Number.isInteger(cell[1]) ||
        cell[1] < 1 ||
        cell[1] > 3
      )
        throw Error("Invalid cell record.");
      state.cells[slot] = [lookup(cell[0], "cells"), cell[1] - 1];
      if (state.cells[slot][0] < 0) throw Error("Invalid cell.");
    }
  }
  for (const slot of ARMOUR) {
    const item = data.armours[state.a[slot].i];
    if (item && item.type !== slot) throw Error("Armour is in the wrong slot.");
  }
  if (version === "1.14.7") {
    const weapon = data.weapons[state.w];
    if (weapon?.power && !Object.hasOwn(weapon.power, state.wl))
      throw Error("This weapon has no selected upgrade level.");
    for (const slot of ARMOUR) {
      const armour = data.armours[state.a[slot].i];
      if (
        armour?.resistance &&
        !Object.hasOwn(armour.resistance, state.a[slot].l)
      )
        throw Error("This armour has no selected upgrade level.");
    }
  }
  const issues = validateBuild(state, data);
  if (issues.length) throw Error(issues.join(" "));
  return { version, state };
}
