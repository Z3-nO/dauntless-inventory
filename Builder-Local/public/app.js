// Adapted from Dauntless Forever Builder by A2K, under AGPL-3.0-only.
import { encodeBuild, decodeBuild, emptyBuild } from "./build-code.mjs";
import { setupCatalogue } from "./catalogue.mjs";
const [legacyData, modernData, ICONS, VOX, catalogues, modernIcons] =
  await Promise.all(
    [
      "/data/1.6.2.json",
      "/data/1.14.7.json",
      "/data/icons162.json",
      "/data/vox162.json",
      "/data/catalogues.json",
      "/data/icons1147.json",
    ].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Error("Could not load local data: " + url);
      return response.json();
    }),
  );
const legacyItemIds = new Set(catalogues["1.6.2"].map((item) => item.id));
const hasVersionItem = (item) =>
  currentVersion !== "1.6.2" || legacyItemIds.has(item.catalogId);
const datasets = { "1.6.2": legacyData, "1.14.7": modernData };
let currentVersion = "1.6.2",
  D = legacyData;

const img = (file, cls) => {
  const source =
    (currentVersion === "1.14.7" ? modernIcons[file] : null) || ICONS[file];
  return source
    ? `<img class="${cls || "ico"}" src="${source}" alt="" loading="lazy">`
    : "";
};
const kindIcon = (k, cls) =>
  img(`/assets/icons/perks/${k}.png`, (cls || "kico") + " k-" + k);
const elemIcon = (e) => img(`/assets/icons/elements/${e}.png`, "eico");
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const TYPES = [
  "Sword",
  "Axe",
  "Hammer",
  "Chain Blades",
  "War Pike",
  "Aether Strikers",
  "Repeater",
];
const PART_DIR = {
  "Aether Strikers": "aetherstrikers",
  Axe: "axe",
  "Chain Blades": "chainblades",
  Hammer: "hammer",
  Repeater: "repeater",
  Sword: "sword",
  "War Pike": "warpike",
};
const REP_PARTS = ["barrels", "chambers", "grips", "prisms"];
const PART_LABEL = {
  mods: "Mod",
  specials: "Special",
  barrels: "Barrel",
  chambers: "Chamber",
  grips: "Grip",
  prisms: "Prism",
};
const ARMOUR = ["Head", "Torso", "Arms", "Legs"];
let KINDS = ["Power", "Technique", "Mobility", "Defence", "Utility"];
const ELEMENTS = ["Blaze", "Frost", "Shock", "Terra", "Radiant", "Umbral"];

let W, A, L, C, P, PARTS, Wi, Ai, Li, Ci, Pi;
const byName = (arr) =>
  Object.fromEntries(arr.map((item, index) => [item.name, index]));
function activateDataset(version) {
  currentVersion = version;
  D = datasets[version];
  ({
    weapons: W,
    armours: A,
    lanterns: L,
    cells: C,
    perks: P,
    parts: PARTS,
  } = D);
  Wi = byName(W);
  Ai = byName(A);
  Li = byName(L);
  Ci = byName(C);
  Pi = byName(P);
  KINDS =
    version === "1.6.2"
      ? ["Power", "Technique", "Mobility", "Defence", "Utility"]
      : ["Brutality", "Finesse", "Alacrity", "Fortitude", "Insight"];
  $("game-version").value = version;
  $("version-label").textContent = "For Dauntless " + version;
  $("version-description").textContent =
    "Choose equipment and cells for " + version + ", then export your build.";
  $("new-gear-label").hidden = version === "1.6.2";
  $("new-gear").checked = false;
  $("format-note").textContent =
    version === "1.6.2"
      ? "162. codes · compatible with the online Builder and Dauntless Inventory."
      : "1147. codes · export a build file to import it with Dauntless Inventory.";
}
activateDataset(currentVersion);
const partsFor = (type, kind) =>
  PARTS.map((p, i) => [p, i]).filter(
    ([p]) => p.weaponType === PART_DIR[type] && p.partKind === kind,
  );
const levels = (it) =>
  Object.keys((it && (it.power || it.resistance)) || { 0: 0 })
    .map(Number)
    .sort((a, b) => a - b);
const atLevel = (list, lvl) =>
  (list || []).filter((x) => x.from == null || (lvl >= x.from && lvl <= x.to));
const title = (s) =>
  String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------- state
// { w: weapon index, wl: level, parts: {mods, specials, barrels, ...: part index}, a: {Head: {i, l}, ...}, lan: index,
//   cells: {w0, w1, Head, Torso, Arms, Legs, lan: [cell index, variant 0..2]} }
const empty = emptyBuild;
function example() {
  const s = empty();
  const c3 = (n) => [Ci[n], 2];
  s.w = Wi["Inferno's Razor"] ?? -1;
  const mod = partsFor("Sword", "mods").find(([p]) => p.name === "Keen Edge");
  if (mod) s.parts.mods = mod[1];
  const sp = partsFor("Sword", "specials")[0];
  if (sp) s.parts.specials = sp[1];
  s.a.Head.i = Ai["Hellplate Casque"] ?? -1;
  s.a.Torso.i = Ai["Hellplate Cuirass"] ?? -1;
  s.a.Arms.i = Ai["Hellplate Bracers"] ?? -1;
  s.a.Legs.i = Ai["Hellplate Greaves"] ?? -1;
  s.lan = Li["Shrike's Zeal"] ?? 0;
  s.cells = {
    w0: c3("Rage Cell"),
    w1: c3("Discipline Cell"),
    Head: c3("Predator Cell"),
    Torso: c3("Weighted Strikes Cell"),
    Arms: c3("Sharpened Cell"),
    Legs: c3("Ragehunter Cell"),
    lan: c3("Conduit Cell"),
  };
  for (const k of Object.keys(s.cells))
    if (s.cells[k][0] == null) delete s.cells[k];
  if (currentVersion === "1.14.7") {
    s.omni = D.omnicells.findIndex((item) => item.name === "Discipline");
    s.cells = {};
    const preferred = {
      w0: "Overpower Cell",
      w1: "Rage Cell",
      Head: "Predator Cell",
      Torso: "Cunning Cell",
      Arms: "Berserker Cell",
      Legs: "Ragehunter Cell",
      lan: "Conduit Cell",
    };
    for (const socket of ["w0", "w1", ...ARMOUR, "lan"]) {
      const kind =
        socket === "w0" || socket === "w1"
          ? W[s.w]?.cells?.[socket === "w0" ? 0 : 1]
          : socket === "lan"
            ? L[s.lan]?.cells
            : A[s.a[socket].i]?.cells;
      if (!kind) continue;
      const index = C.findIndex(
        (item) =>
          (kind === "Prismatic" || item.slot === kind) &&
          item.name === preferred[socket],
      );
      if (index >= 0) s.cells[socket] = [index, 2];
    }
  }
  return s;
}
let S = null,
  isExample = false;

// ---------------------------------------------------------------- build code (share with friends)
function encode(state) {
  return encodeBuild(state, currentVersion, D);
}
function loadCode(input) {
  const loaded = decodeBuild(input, datasets);
  if (loaded.version !== currentVersion) {
    try {
      $("build-name").value =
        localStorage.getItem("df-local-name-" + loaded.version) || "";
    } catch {}
  }
  activateDataset(loaded.version);
  S = loaded.state;
  isExample = false;
  render();
  renderCatalogue();
}

// ---------------------------------------------------------------- what each slot holds
const weapon = () => (S.w >= 0 ? W[S.w] : null);
function slotCellKind(key) {
  if (key === "w0" || key === "w1") {
    const w = weapon();
    return w && w.cells ? w.cells[key === "w0" ? 0 : 1] : null;
  }
  if (key === "lan") return S.lan >= 0 ? L[S.lan].cells : null;
  const a = S.a[key].i >= 0 ? A[S.a[key].i] : null;
  return a ? a.cells : null;
}
function fits(cell, kind) {
  return !!kind && (kind === "Prismatic" || cell.slot === kind);
}
function tidyCells() {
  // a cell that no longer fits its socket (gear changed) comes out
  for (const k of Object.keys(S.cells)) {
    const kind = slotCellKind(k);
    if (!kind || !fits(C[S.cells[k][0]], kind)) delete S.cells[k];
  }
  const w = weapon();
  if (w && !levels(w).includes(S.wl)) S.wl = levels(w)[0];
  for (const key of ARMOUR) {
    const armour = A[S.a[key].i];
    if (armour && !levels(armour).includes(S.a[key].l))
      S.a[key].l = levels(armour)[0];
  }
  if (S.bond >= 0) {
    const bond = W[S.bond];
    if (
      !w?.bond ||
      !bond ||
      bond.bond ||
      bond.type !== w.type ||
      bond.elemental !== w.bond.elemental
    )
      S.bond = -1;
  }
  for (const k of Object.keys(S.parts)) {
    const p = PARTS[S.parts[k]];
    if (
      !w ||
      !p ||
      p.weaponType !== PART_DIR[w.type] ||
      (k === "specials" && w.restrict_specials) ||
      (w.type === "Repeater" && w.rarity === "exotic" && k !== "mods")
    )
      delete S.parts[k];
  }
}
function variantOf(k) {
  const c = C[S.cells[k][0]];
  const names = Object.keys(c.variants);
  return {
    cell: c,
    name: names[S.cells[k][1]] || names[names.length - 1],
    v: c.variants[names[S.cells[k][1]] || names[names.length - 1]],
  };
}

// ---------------------------------------------------------------- totals
function totals() {
  const pts = {},
    add = (n, v) => {
      if (!n || !v) return;
      pts[n] = (pts[n] || 0) + v;
    };
  const w = weapon();
  let power = null,
    element = w ? w.elemental : null;
  if (w) {
    power = w.power ? (w.power[S.wl] ?? w.power[0]) : null;
    for (const p of atLevel(w.perks, S.wl)) add(p.name, p.value);
  }
  if (w && w.type === "Repeater" && S.parts.barrels != null) {
    const b = PARTS[S.parts.barrels];
    if (b.power) power = b.power[S.wl] ?? b.power[0];
    if (b.elemental) element = b.elemental;
  }
  let resist = 0;
  const el = {};
  ELEMENTS.forEach((e) => (el[e] = 0));
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    if (!a) continue;
    resist += Number(
      (a.resistance || {})[S.a[k].l] ?? (a.resistance || {})[0] ?? 0,
    );
    for (const p of atLevel(a.perks, S.a[k].l)) add(p.name, p.value);
    if (a.strength) el[a.strength] += 1;
    if (a.weakness) el[a.weakness] -= 1;
  }
  for (const k of Object.keys(S.cells)) {
    const { v } = variantOf(k);
    for (const [n, val] of Object.entries(v.perks || {})) add(n, val);
  }
  if (w?.bond && S.bond >= 0)
    for (const perk of atLevel(W[S.bond].perks, S.wl))
      add(perk.name, perk.value);
  const exotics = [
    w,
    ...ARMOUR.map((k) => (S.a[k].i >= 0 ? A[S.a[k].i] : null)),
  ].filter((x) => x && x.rarity === "exotic");
  return { pts, power, element, resist, el, exotics };
}

// ---------------------------------------------------------------- rendering
const elTag = (e) =>
  `<span class="el e-${esc(e || "none")}">${e && ICONS[`/assets/icons/elements/${e}.png`] ? elemIcon(e) : "<i></i>"}${esc(e || "Neutral")}</span>`;
function lvlToggle(key, item, cur) {
  const lv = levels(item);
  return `<span class="lvl" role="group" aria-label="Level">${[0, 1].map((n) => `<button type="button" data-lvl="${key}" data-v="${n}" class="${cur === n ? "on" : ""}" ${lv.includes(n) ? "" : "disabled"}>${n ? "Max" : "Base"}</button>`).join("")}</span>`;
}
function socket(key) {
  const kind = slotCellKind(key);
  if (!kind) return "";
  if (!S.cells[key])
    return `<button type="button" class="sock emptys k-${kind}" data-cell="${key}">${kindIcon(kind) || '<span class="gem"></span>'}<span class="t">${kind} cell</span></button>`;
  const { cell, name } = variantOf(key);
  return `<button type="button" class="sock filled k-${cell.slot}" data-cell="${key}" title="${esc(kind)} socket">${kindIcon(cell.slot) || `<span class="gem"><span>${esc(name.slice(1, 2))}</span></span>`}<span class="t">${esc(name)}</span></button>`;
}
function renderRack() {
  const w = weapon(),
    out = [];
  // weapon
  let wMeta = "",
    wParts = "";
  if (w) {
    const t = totals();
    wMeta = `<div class="meta"><span>${esc(w.type)}</span>${elTag(t.element)}<span>${esc(w.damage || "")}</span><span>Power <span class="num">${t.power ?? "-"}</span></span>${w.rarity === "exotic" ? '<span class="flag">Exotic</span>' : ""}</div>`;
    const kinds =
      currentVersion === "1.14.7" && w.type === "Repeater"
        ? w.rarity === "exotic"
          ? ["mods"]
          : ["chambers", "grips", "mods"]
        : w.type === "Repeater"
          ? w.rarity === "exotic"
            ? ["mods"]
            : [...REP_PARTS, "mods"]
          : w.restrict_specials
            ? ["mods"]
            : ["mods", "specials"];
    wParts = `<div class="parts">${kinds
      .map((k) => {
        const p = S.parts[k] != null ? PARTS[S.parts[k]] : null;
        return `<button type="button" class="part" data-part="${k}">${p ? img(p.icon, "pico") : ""}<em>${PART_LABEL[k]}</em>${p ? esc(p.name) : '<span class="note">none</span>'}</button>`;
      })
      .join("")}</div>`;
  }
  out.push(
    `<div class="slot"><div class="slot-head"><span class="slot-kind">Weapon</span><button type="button" class="pick ${w ? "" : "empty"}" data-pick="weapon">${w ? img(w.icon, "gico") : ""}<b>${w ? esc(w.name) : "Choose a weapon"}</b>${w ? `<span class="sub">${esc(title(w.source))}</span>` : ""}</button>${w ? lvlToggle("w", w, S.wl) : ""}</div>${wMeta}${wParts}${w && w.cells ? `<div class="sockets">${socket("w0")}${socket("w1")}</div>` : ""}</div>`,
  );
  // armour
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    const res = a
      ? ((a.resistance || {})[S.a[k].l] ?? (a.resistance || {})[0])
      : null;
    const perks = a
      ? atLevel(a.perks, S.a[k].l)
          .map((p) => `+${p.value} ${esc(p.name)}`)
          .join(", ")
      : "";
    out.push(
      `<div class="slot"><div class="slot-head"><span class="slot-kind">${k}</span><button type="button" class="pick ${a ? "" : "empty"}" data-pick="${k}">${a ? img(a.icon, "gico") : ""}<b>${a ? esc(a.name) : "Choose " + k.toLowerCase() + " armour"}</b>${a ? `<span class="sub">${esc(title(a.source))}</span>` : ""}</button>${a ? lvlToggle(k, a, S.a[k].l) : ""}</div>${a ? `<div class="meta"><span>Resist <span class="num">${res ?? "-"}</span></span>${a.strength ? `<span>Strong vs ${elTag(a.strength)}</span>` : ""}${a.weakness ? `<span>Weak to ${elTag(a.weakness)}</span>` : ""}${perks ? `<span>${perks}</span>` : ""}${a.rarity === "exotic" ? '<span class="flag">Exotic</span>' : ""}</div><div class="sockets">${socket(k)}</div>` : ""}</div>`,
    );
  }
  // lantern
  const l = S.lan >= 0 ? L[S.lan] : null;
  out.push(
    `<div class="slot"><div class="slot-head"><span class="slot-kind">Lantern</span><button type="button" class="pick ${l ? "" : "empty"}" data-pick="lantern">${l ? img(l.icon, "gico") : ""}<b>${l ? esc(l.name) : "Choose a lantern"}</b></button></div>${l ? `<div class="meta"><span><b>Tap:</b> ${esc((l.lantern_ability || {}).instant || "")}</span><span><b>Hold:</b> ${esc((l.lantern_ability || {}).hold || "")}</span></div>${l.cells ? `<div class="sockets">${socket("lan")}</div>` : ""}` : ""}</div>`,
  );
  if (w?.bond) {
    const bond = W[S.bond];
    out.splice(
      1,
      0,
      `<div class="slot"><div class="slot-head"><span class="slot-kind">Bond</span><button class="pick ${bond ? "" : "empty"}" data-pick="bond">${bond ? img(bond.icon, "gico") : ""}<b>${bond ? esc(bond.name) : "Choose a bonded weapon"}</b></button></div><div class="meta">Inherits the bonded weapon's perk and unique effect at the selected weapon level.</div></div>`,
    );
  }
  if (currentVersion === "1.14.7") {
    const omni = D.omnicells[S.omni];
    out.push(
      `<div class="slot"><div class="slot-head"><span class="slot-kind">Omnicell</span><button class="pick ${omni ? "" : "empty"}" data-pick="omnicell">${omni ? img(omni.icon, "gico") : ""}<b>${omni ? esc(omni.name) : "Choose an omnicell"}</b></button></div>${omni ? `<div class="meta omni-description"><span><b>Passive:</b> ${esc(omni.passive)}</span><span><b>Active:</b> ${esc(omni.active)}</span></div>` : ""}</div>`,
    );
  }
  $("rack").innerHTML = out.join("");
}
function perkText(p, tier) {
  const e = p.effects[String(tier)];
  if (!e) return "";
  const d = Array.isArray(e.description)
    ? e.description.filter(Boolean).join(", ")
    : e.description;
  return d || "";
}
function renderSide() {
  const t = totals();
  const exo = currentVersion === "1.6.2" && t.exotics.length > 1;
  const selectedGear = [
    weapon(),
    ...ARMOUR.map((key) => A[S.a[key].i]),
    L[S.lan],
    ...Object.values(S.parts).map((index) => PARTS[index]),
    ...Object.values(S.cells).map(([index]) => C[index]),
  ].filter(Boolean);
  const unavailable = selectedGear.filter((item) => !hasVersionItem(item));
  const warnings = [];
  if (exo)
    warnings.push(
      `Only one Exotic can be equipped at a time (${t.exotics.map((x) => x.name).join(", ")}).`,
    );
  if (unavailable.length)
    warnings.push(
      "Unavailable in this client version: " +
        unavailable.map((item) => item.name).join(", ") +
        ". Choose replacement equipment before importing into Inventory.",
    );
  $("warn").hidden = !warnings.length;
  $("warn").textContent = warnings.join(" ");
  const cellsUsed = Object.keys(S.cells).length,
    sockets = ["w0", "w1", ...ARMOUR, "lan"].filter((k) =>
      slotCellKind(k),
    ).length;
  $("stats").innerHTML = [
    ["Power", t.power ?? "-"],
    ["Resistance", t.resist || "-"],
    ["Cells", `${cellsUsed}/${sockets}`],
  ]
    .map(
      ([k, v]) =>
        `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`,
    )
    .join("");
  $("elems").innerHTML =
    ELEMENTS.filter((e) => t.el[e])
      .map(
        (e) =>
          `<span class="echip el e-${e}">${ICONS[`/assets/icons/elements/${e}.png`] ? elemIcon(e) : "<i></i>"}${e} <b>${t.el[e] > 0 ? "+" + t.el[e] : t.el[e]}</b></span>`,
      )
      .join("") ||
    '<span class="note">No elemental strengths or weaknesses from armour yet.</span>';
  const list = Object.entries(t.pts)
    .filter(([n]) => Pi[n] != null)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("perk-count").textContent = list.length ? `${list.length} active` : "";
  $("perks").innerHTML = list.length
    ? list
        .map(([n, v]) => {
          const p = P[Pi[n]],
            tier = Math.min(6, v);
          return `<div class="perk ${v > 6 ? "over" : ""}"><div class="n k-${p.type}">${kindIcon(p.type, "kico sm")}${esc(n)}<small>${esc(p.type)}</small></div><div class="pips k-${p.type}" aria-label="+${v} of 6">${[1, 2, 3, 4, 5, 6].map((x) => `<i class="${x <= tier ? "on" : ""}"></i>`).join("")}<b>+${v}</b></div><div class="d">${esc(perkText(p, tier))}</div></div>`;
        })
        .join("")
    : '<div class="empty-note">No perks yet. Armour pieces and cells add perk points; each perk works up to +6.</div>';
  const ues = [];
  const w = weapon();
  if (w)
    for (const u of atLevel(w.unique_effects, S.wl))
      ues.push([u.title ? `${w.name} (${u.title})` : w.name, u.description]);
  for (const k of ["mods", "specials", ...REP_PARTS])
    if (S.parts[k] != null) {
      const p = PARTS[S.parts[k]];
      for (const e of p.part_effect || [])
        ues.push([`${PART_LABEL[k]}: ${p.name}`, e]);
    }
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    if (a)
      for (const u of atLevel(a.unique_effects, S.a[k].l))
        ues.push([a.name, u.description]);
  }
  if (w?.bond && S.bond >= 0)
    for (const effect of atLevel(W[S.bond].unique_effects, S.wl))
      ues.push(["Bond: " + W[S.bond].name, effect.description]);
  if (currentVersion === "1.14.7" && D.omnicells[S.omni]) {
    const omni = D.omnicells[S.omni];
    ues.push(
      [omni.name + " passive", omni.passive],
      [omni.name + " active", omni.active],
    );
  }
  $("ue").innerHTML = ues.length
    ? ues
        .map(
          ([h, d]) =>
            `<div><b>${esc(h)}:</b> ${esc(String(d || "").trim())}</div>`,
        )
        .join("")
    : '<div class="empty-note">Weapon abilities, mods, specials and exotic effects show here.</div>';
  $("code").value = encode(S);
}
function render() {
  tidyCells();
  renderRack();
  renderSide();
  $("example-flag").hidden = !isExample;
  save();
}

// ---------------------------------------------------------------- picker
let pickCtx = null;
function openPicker(ctx) {
  pickCtx = ctx;
  $("dlg-q").value = "";
  ctx.filter = ctx.filter ?? (ctx.chips ? ctx.chips[0] : null);
  $("dlg-title").textContent = ctx.title;
  drawPicker();
  $("dlg").showModal();
  setTimeout(() => $("dlg-q").focus(), 30);
}
function drawPicker() {
  const ctx = pickCtx,
    q = $("dlg-q").value.trim().toLowerCase();
  $("dlg-chips").innerHTML = (ctx.chips || [])
    .map(
      (c) =>
        `<button type="button" class="chip ${c === ctx.filter ? "on" : ""}" data-chip="${esc(c)}">${esc(c)}</button>`,
    )
    .join("");
  const items = ctx
    .items(ctx.filter)
    .filter(
      (it) =>
        (!$("new-gear").checked || it.isNew) &&
        (!q || it.search.toLowerCase().includes(q)),
    );
  $("dlg-list").innerHTML =
    (ctx.allowNone
      ? `<button type="button" class="opt" data-opt="-1"><div class="r1"><b>None</b></div><div class="r2">Empty this slot</div></button>`
      : "") +
    (items.length
      ? items
          .map(
            (it) =>
              `<div class="opt ${it.icon ? "has-ico" : ""}" role="button" tabindex="0" data-opt="${it.id}">${it.icon || ""}<div class="oc"><div class="r1"><b>${esc(it.name)}</b>${it.tag || ""}</div>${it.sub ? `<div class="r2">${it.sub}</div>` : ""}${it.vars ? `<div class="vars">${it.vars}</div>` : ""}</div></div>`,
          )
          .join("")
      : '<p class="note" style="padding:10px">Nothing matches.</p>');
}
$("dlg-q").addEventListener("input", drawPicker);
$("dlg-x").addEventListener("click", () => $("dlg").close());
$("dlg").addEventListener("click", (e) => {
  if (e.target === $("dlg")) {
    $("dlg").close();
    return;
  }
  const chip = e.target.closest("[data-chip]");
  if (chip) {
    pickCtx.filter = chip.dataset.chip;
    drawPicker();
    return;
  }
  const v = e.target.closest("[data-var]");
  const o = e.target.closest("[data-opt]");
  if (!o) return;
  pickCtx.choose(Number(o.dataset.opt), v ? Number(v.dataset.var) : null);
  $("dlg").close();
  isExample = false;
  render();
});
$("dlg").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const o = e.target.closest("[data-opt]");
    if (o) o.click();
  }
});

const cellSub = (c) => {
  const top = c.variants[Object.keys(c.variants).pop()];
  const pn = Object.keys(top.perks || {})[0];
  const p = P[Pi[pn]];
  return p ? esc(p.description || "") : "";
};
function pickWeapon() {
  const cur = weapon();
  openPicker({
    title: "Weapon",
    chips: TYPES,
    filter: cur ? cur.type : TYPES[0],
    items: (type) =>
      W.map((w, i) => ({ id: i, w }))
        .filter((x) => hasVersionItem(x.w) && x.w.type === type)
        .sort((a, b) => a.w.name.localeCompare(b.w.name))
        .map(({ id, w }) => ({
          id,
          isNew: w.newSince162,
          icon: img(w.icon, "oico"),
          name: w.name,
          search: w.name + " " + (w.source || ""),
          tag: `${elTag(w.elemental)}${w.rarity === "exotic" ? ' <span class="flag">Exotic</span>' : ""}`,
          sub: `${esc(title(w.source))} &middot; ${esc((w.cells || []).join(" + ") || "no cells")}${
            (w.perks || []).length
              ? " &middot; " +
                esc(
                  atLevel(w.perks, 1)
                    .map((p) => "+" + p.value + " " + p.name)
                    .join(", "),
                )
              : ""
          }`,
        })),
    choose: (i) => {
      if (i >= 0 && weapon() && W[i].type !== weapon().type) S.parts = {};
      S.w = i;
    },
  });
}
function pickArmour(k) {
  openPicker({
    title: k + " armour",
    allowNone: true,
    items: () =>
      A.map((a, i) => ({ id: i, a }))
        .filter((x) => hasVersionItem(x.a) && x.a.type === k)
        .sort((x, y) => x.a.name.localeCompare(y.a.name))
        .map(({ id, a }) => ({
          id,
          isNew: a.newSince162,
          icon: img(a.icon, "oico"),
          name: a.name,
          search:
            a.name +
            " " +
            (a.source || "") +
            " " +
            (a.perks || []).map((p) => p.name).join(" "),
          tag: `${a.rarity === "exotic" ? '<span class="flag">Exotic</span>' : ""}`,
          sub: `${esc(title(a.source))} &middot; ${esc(a.cells || "no cell")} cell &middot; ${esc(
            atLevel(a.perks, 1)
              .map((p) => "+" + p.value + " " + p.name)
              .join(", ") || (a.unique_effects ? "unique effect" : "no perk"),
          )}${a.strength ? " &middot; strong vs " + esc(a.strength) : ""}`,
        })),
    choose: (i) => {
      S.a[k].i = i;
    },
  });
}
function pickLantern() {
  openPicker({
    title: "Lantern",
    allowNone: true,
    items: () =>
      L.map((l, i) => ({ l, i }))
        .filter(({ l }) => hasVersionItem(l))
        .map(({ l, i }) => ({
          id: i,
          isNew: l.newSince162,
          icon: img(l.icon, "oico"),
          name: l.name,
          search: l.name,
          sub: esc((l.lantern_ability || {}).instant || ""),
        })),
    choose: (i) => {
      S.lan = i;
    },
  });
}
function pickPart(kind) {
  const w = weapon();
  if (!w) return;
  openPicker({
    title: PART_LABEL[kind],
    allowNone: true,
    items: () =>
      partsFor(w.type, kind)
        .filter(([p]) => hasVersionItem(p))
        .map(([p, i]) => ({
          id: i,
          isNew: p.newSince162,
          icon: img(p.icon, "oico"),
          name: p.name,
          search: p.name,
          tag: p.elemental ? elTag(p.elemental) : "",
          sub: esc((p.part_effect || []).join(" ")),
        })),
    choose: (i) => {
      if (i < 0) delete S.parts[kind];
      else S.parts[kind] = i;
    },
  });
}
function pickCell(key) {
  const kind = slotCellKind(key);
  if (!kind) return;
  const chips = kind === "Prismatic" ? ["All", ...KINDS] : null;
  openPicker({
    title: `${kind} cell`,
    chips,
    filter: chips ? "All" : null,
    allowNone: true,
    items: (f) =>
      C.map((c, i) => ({ c, i }))
        .filter(
          ({ c }) =>
            hasVersionItem(c) &&
            fits(c, kind) &&
            (!f || f === "All" || c.slot === f),
        )
        .sort((a, b) => a.c.name.localeCompare(b.c.name))
        .map(({ c, i }) => ({
          id: i,
          isNew: c.newSince162,
          icon: kindIcon(c.slot, "oico cell"),
          name: c.name,
          search:
            c.name +
            " " +
            Object.keys(Object.values(c.variants)[0].perks || {}).join(" "),
          tag: chips ? `<span class="note k-${c.slot}">${c.slot}</span>` : "",
          sub: cellSub(c),
          vars: Object.keys(c.variants)
            .map(
              (v, n) =>
                `<span data-var="${n}" class="k-${c.slot}">${esc(v.split(" ")[0])}</span>`,
            )
            .join(""),
        })),
    choose: (i, v) => {
      if (i < 0) delete S.cells[key];
      else S.cells[key] = [i, v == null ? 2 : v];
    },
  });
}

function pickOmnicell() {
  openPicker({
    title: "Omnicell",
    allowNone: true,
    items: () =>
      D.omnicells.map((item, index) => ({
        id: index,
        isNew: true,
        icon: img(item.icon, "oico"),
        name: item.name,
        search: item.name + " " + item.passive,
        sub: esc(item.passive),
      })),
    choose: (index) => {
      S.omni = index;
    },
  });
}
function pickBond() {
  const w = weapon();
  if (!w?.bond) return;
  openPicker({
    title: "Bonded weapon",
    allowNone: true,
    items: () =>
      W.map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            !item.bond &&
            item.type === w.type &&
            item.elemental === w.bond.elemental,
        )
        .map(({ item, index }) => ({
          id: index,
          isNew: item.newSince162,
          icon: img(item.icon, "oico"),
          name: item.name,
          search: item.name,
          sub: esc(
            atLevel(item.perks, S.wl)
              .map((perk) => "+" + perk.value + " " + perk.name)
              .join(", "),
          ),
        })),
    choose: (index) => {
      S.bond = index;
    },
  });
}

$("rack").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.pick === "weapon") pickWeapon();
  else if (t.dataset.pick === "lantern") pickLantern();
  else if (t.dataset.pick === "omnicell") pickOmnicell();
  else if (t.dataset.pick === "bond") pickBond();
  else if (t.dataset.pick) pickArmour(t.dataset.pick);
  else if (t.dataset.part) pickPart(t.dataset.part);
  else if (t.dataset.cell) pickCell(t.dataset.cell);
  else if (t.dataset.lvl) {
    const v = Number(t.dataset.v);
    if (t.dataset.lvl === "w") S.wl = v;
    else S.a[t.dataset.lvl].l = v;
    isExample = false;
    render();
  }
});

// ---------------------------------------------------------------- sharing
function say(t) {
  $("msg").textContent = t;
  clearTimeout(say.t);
  say.t = setTimeout(() => ($("msg").textContent = ""), 3500);
}
async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    say(done);
  } catch {
    $("code").focus();
    $("code").select();
    say("Copying is blocked here: the code is selected, press Ctrl+C.");
  }
}
function asText() {
  const t = totals(),
    w = weapon(),
    lines = ["Dauntless Forever Builder (" + currentVersion + ")"];
  const cell = (k) => (S.cells[k] ? variantOf(k).name : null);
  if (w) {
    const parts = Object.keys(S.parts)
      .map((k) => `${PART_LABEL[k]}: ${PARTS[S.parts[k]].name}`)
      .join(", ");
    lines.push(
      `Weapon: ${w.name} (${S.wl ? "Max" : "Base"})${parts ? " - " + parts : ""}${[cell("w0"), cell("w1")].filter(Boolean).length ? " - " + [cell("w0"), cell("w1")].filter(Boolean).join(", ") : ""}`,
    );
  }
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    if (a)
      lines.push(
        `${k}: ${a.name} (${S.a[k].l ? "Max" : "Base"})${cell(k) ? " - " + cell(k) : ""}`,
      );
  }
  if (S.lan >= 0)
    lines.push(
      `Lantern: ${L[S.lan].name}${cell("lan") ? " - " + cell("lan") : ""}`,
    );
  const perks = Object.entries(t.pts)
    .filter(([n]) => Pi[n] != null)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `+${v} ${n}`)
    .join(", ");
  if (perks) lines.push(`Perks: ${perks}`);
  if (S.bond >= 0) lines.push("Bond: " + W[S.bond].name);
  if (S.omni >= 0) lines.push("Omnicell: " + D.omnicells[S.omni].name);
  lines.push(`Build code: ${encode(S)}`);
  return lines.join("\n");
}
$("b-copycode").addEventListener("click", () =>
  copy(
    $("code").value,
    "Build code copied. Friends paste it in the Build code box.",
  ),
);
$("b-copytext").addEventListener("click", () =>
  copy(asText(), "Build copied as text, ready for Discord."),
);
$("b-load").addEventListener("click", () => {
  try {
    loadCode($("code").value);
    say("Build loaded for " + currentVersion + ".");
  } catch (error) {
    say(error.message);
  }
});
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("b-load").click();
});
$("b-reset").addEventListener("click", () => {
  S = empty();
  isExample = false;
  render();
});

// ---------------------------------------------------------------- remembered on this browser only
function save() {
  try {
    localStorage.setItem("df-local-build-" + currentVersion, encode(S));
    localStorage.setItem("df-local-version", currentVersion);
    localStorage.setItem(
      "df-local-name-" + currentVersion,
      $("build-name").value,
    );
  } catch {}
}
// Dark by default; the Light / Dark button is remembered on this browser
function theme(t) {
  document.documentElement.dataset.theme = t;
  $("b-theme").textContent = t === "dark" ? "Light mode" : "Dark mode";
}
let themeNow = "dark";
try {
  const t = localStorage.getItem("df-local-theme");
  if (t === "light" || t === "dark") themeNow = t;
} catch {}
theme(themeNow);
$("b-theme").addEventListener("click", () => {
  themeNow = themeNow === "dark" ? "light" : "dark";
  theme(themeNow);
  try {
    localStorage.setItem("df-local-theme", themeNow);
  } catch {}
});
function boot() {
  let preferred = "1.6.2";
  try {
    preferred = localStorage.getItem("df-local-version") || preferred;
  } catch {}
  if (!datasets[preferred]) preferred = "1.6.2";
  activateDataset(preferred);
  try {
    $("build-name").value =
      localStorage.getItem("df-local-name-" + preferred) || "";
  } catch {}
  let loaded = false;
  try {
    if (location.hash.length > 3) {
      loadCode(location.hash.slice(1));
      loaded = true;
    }
  } catch (error) {
    say(error.message);
  }
  if (!loaded) {
    try {
      const saved = localStorage.getItem("df-local-build-" + currentVersion);
      if (saved) {
        loadCode(saved);
        loaded = true;
      }
    } catch {}
  }
  if (!loaded) {
    S = example();
    isExample = true;
    render();
  }
  try {
    $("build-name").value =
      localStorage.getItem("df-local-name-" + currentVersion) || "";
  } catch {}
  renderCatalogue();
}

// ---------------------------------------------------------------- build card (voxel sprites drawn on a canvas, for Discord)
const VOX_W = {
  Sword: "sword",
  Axe: "axe",
  Hammer: "hammer",
  "Chain Blades": "chainblades",
  "War Pike": "pike",
  "Aether Strikers": "strikers",
  Repeater: "repeater",
};
const VOX_A = { Head: "helm", Torso: "torso", Arms: "gloves", Legs: "boots" };
const voxImgs = {};
// per-item weapon sprite, voxelised from its real icon (key = the icon path); falls back to the weapon-type sprite
function armourKey(k, a) {
  return a && a.icon && VOX[a.icon]
    ? a.icon
    : `${VOX_A[k]}.${a.strength && CARD_EL[a.strength] ? a.strength : "Neutral"}`;
}
function lanternKey(l) {
  return l && l.icon && VOX[l.icon] ? l.icon : "lantern";
}
function weaponKey(w, el) {
  return w && w.icon && VOX[w.icon] ? w.icon : `${VOX_W[w.type]}.${el}`;
}
function voxImg(key) {
  if (!VOX[key]) return null;
  if (!voxImgs[key]) {
    const im = new Image();
    im.src = VOX[key];
    voxImgs[key] = im;
  }
  return voxImgs[key];
}
function voxReady() {
  return Promise.all(
    Object.values(voxImgs).map((im) =>
      im.complete && im.naturalWidth
        ? null
        : new Promise((r) => {
            im.onload = r;
            im.onerror = r;
          }),
    ),
  );
}
const CARD_EL = {
  Blaze: "#f07548",
  Frost: "#5cb6e8",
  Shock: "#b08bf0",
  Terra: "#79b851",
  Radiant: "#e2c057",
  Umbral: "#9a8bc4",
  Neutral: "#8a949e",
};
const CARD_K = {
  Brutality: "#e5604f",
  Finesse: "#e79a45",
  Alacrity: "#5cbf6a",
  Fortitude: "#5b9be0",
  Insight: "#a67fe0",
  Power: "#e5604f",
  Technique: "#e79a45",
  Mobility: "#5cbf6a",
  Defence: "#5b9be0",
  Utility: "#a67fe0",
  Prismatic: "#a3afbb",
};
function drawSprite(ctx, im, x, y, w, h) {
  // fit inside the box, centred, voxels stay crisp
  if (!im || !im.naturalWidth) return;
  const k = Math.min(w / im.naturalWidth, h / im.naturalHeight),
    dw = Math.round(im.naturalWidth * k),
    dh = Math.round(im.naturalHeight * k);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    im,
    Math.round(x + (w - dw) / 2),
    Math.round(y + (h - dh) / 2),
    dw,
    dh,
  );
  ctx.imageSmoothingEnabled = true;
}
function gemDraw(ctx, x, y, r, color) {
  // small hexagonal cell gem
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.45)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.22, 0, 7);
  ctx.fill();
}
function fitText(ctx, text, maxW, size, weight, family) {
  for (let s = size; s >= 10; s -= 1) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxW) return s;
  }
  return 10;
}
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/),
    lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
async function drawCard(canvas) {
  const t = totals(),
    w = weapon(),
    el = t.element && CARD_EL[t.element] ? t.element : "Neutral",
    ac = CARD_EL[el];
  const keys = [];
  if (w) keys.push(weaponKey(w, el));
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    if (a) keys.push(armourKey(k, a));
  }
  if (S.lan >= 0) keys.push(lanternKey(L[S.lan]));
  keys.forEach(voxImg);
  await voxReady();
  try {
    await document.fonts.load('800 48px "Saira Condensed"');
    await document.fonts.load('700 16px "Saira Condensed"');
  } catch {}
  const W_ = 1200,
    H_ = 675,
    ctx = canvas.getContext("2d");
  canvas.width = W_;
  canvas.height = H_;
  const SANS = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    DISP =
      '"Saira Condensed", "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif';
  // background: dark stone with a tint of the weapon's element and a faint diagonal weave
  const g = ctx.createLinearGradient(0, 0, W_, H_);
  g.addColorStop(0, "#1b242d");
  g.addColorStop(1, "#0e1318");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W_, H_);
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = ac;
  ctx.lineWidth = 2;
  for (let i = -H_; i < W_; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H_, H_);
    ctx.stroke();
  }
  ctx.restore();
  const rg = ctx.createRadialGradient(280, 330, 40, 280, 330, 420);
  rg.addColorStop(0, ac + "55");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W_, H_);
  // frame
  ctx.strokeStyle = ac;
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, W_ - 28, H_ - 28);
  ctx.strokeStyle = "rgba(217,174,82,.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(22, 22, W_ - 44, H_ - 44);
  // title
  const name = w ? w.name : "Empty loadout";
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "top";
  const ts = fitText(ctx, name.toUpperCase(), 700, 56, "800", DISP);
  ctx.font = `800 ${ts}px ${DISP}`;
  ctx.fillText(name.toUpperCase(), 48, 40);
  ctx.font = `600 18px ${SANS}`;
  ctx.fillStyle = "#a5b2bf";
  const sub = [
    w ? w.type : "",
    el !== "Neutral" ? el : w ? "Neutral" : "",
    w ? (S.wl ? "Max" : "Base") : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  ctx.fillText(sub, 50, 44 + ts + 6);
  ctx.textAlign = "right";
  ctx.fillStyle = "#d9ae52";
  ctx.font = `700 18px ${DISP}`;
  ctx.fillText("DAUNTLESS FOREVER  ·  " + currentVersion, W_ - 48, 44);
  ctx.fillStyle = "#7b8794";
  ctx.font = `500 14px ${SANS}`;
  ctx.fillText(
    "Power " + (t.power ?? "-") + "   Resist " + (t.resist || "-"),
    W_ - 48,
    66,
  );
  ctx.textAlign = "left";
  // weapon sprite, big, on the left
  if (w) drawSprite(ctx, voxImg(weaponKey(w, el)), 50, 138, 290, 285);
  const cellName = (k) => (S.cells[k] ? variantOf(k).name : null),
    cellKind = (k) => (S.cells[k] ? C[S.cells[k][0]].slot : slotCellKind(k));
  // weapon cells and parts under it
  let y = 428;
  ctx.font = `600 15px ${SANS}`;
  for (const k of ["w0", "w1"]) {
    if (!w || !w.cells || !slotCellKind(k)) continue;
    gemDraw(ctx, 64, y + 9, 9, CARD_K[cellKind(k)] || "#888");
    ctx.fillStyle = S.cells[k] ? "#e6edf3" : "#6f7d8b";
    ctx.fillText(cellName(k) || slotCellKind(k) + " socket", 82, y);
    y += 24;
  }
  ctx.fillStyle = "#a5b2bf";
  ctx.font = `500 14px ${SANS}`;
  for (const k of Object.keys(S.parts)) {
    const p = PARTS[S.parts[k]];
    if (!p) continue;
    ctx.fillText(`${PART_LABEL[k]}: ${p.name}`, 50, y);
    y += 20;
  }
  const extraChoices = [];
  if (currentVersion === "1.14.7" && D.omnicells[S.omni])
    extraChoices.push("Omnicell: " + D.omnicells[S.omni].name);
  if (S.bond >= 0 && W[S.bond]) extraChoices.push("Bond: " + W[S.bond].name);
  for (const text of extraChoices) {
    ctx.fillStyle = "#d9ae52";
    const size = fitText(ctx, text, 310, 14, "600", SANS);
    ctx.font = `600 ${size}px ${SANS}`;
    ctx.fillText(text, 50, y);
    y += 20;
  }
  // armour column: sprite, name, cell
  let ay = 112;
  const ax = 380;
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    ctx.fillStyle = "rgba(255,255,255,.04)";
    ctx.fillRect(ax, ay, 380, 86);
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ax + 0.5, ay + 0.5, 379, 85);
    if (a) drawSprite(ctx, voxImg(armourKey(k, a)), ax + 6, ay + 4, 78, 78);
    ctx.fillStyle = "#7b8794";
    ctx.font = `700 11px ${SANS}`;
    ctx.fillText(k.toUpperCase(), ax + 94, ay + 10);
    ctx.fillStyle = a ? "#e6edf3" : "#6f7d8b";
    const ns = a ? fitText(ctx, a.name, 270, 24, "700", DISP) : 18;
    ctx.font = `700 ${ns}px ${DISP}`;
    ctx.fillText(a ? a.name : "empty", ax + 94, ay + 26);
    if (a) {
      const line = [
        S.a[k].l ? "Max" : "Base",
        ...atLevel(a.perks, S.a[k].l).map((p) => "+" + p.value + " " + p.name),
      ].join("  ·  ");
      ctx.fillStyle = "#a5b2bf";
      ctx.font = `500 13px ${SANS}`;
      ctx.fillText(line, ax + 94, ay + 52);
      if (slotCellKind(k)) {
        gemDraw(ctx, ax + 101, ay + 75, 7, CARD_K[cellKind(k)] || "#888");
        ctx.fillStyle = S.cells[k] ? "#d5dbe2" : "#6f7d8b";
        ctx.font = `600 12px ${SANS}`;
        ctx.fillText(
          cellName(k) || slotCellKind(k) + " socket",
          ax + 114,
          ay + 68,
        );
      }
    }
    ay += 92;
  }
  // lantern row
  const l = S.lan >= 0 ? L[S.lan] : null;
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.fillRect(ax, ay, 380, 70);
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.strokeRect(ax + 0.5, ay + 0.5, 379, 69);
  if (l) drawSprite(ctx, voxImg(lanternKey(l)), ax + 10, ay + 4, 62, 62);
  ctx.fillStyle = "#7b8794";
  ctx.font = `700 11px ${SANS}`;
  ctx.fillText("LANTERN", ax + 94, ay + 8);
  ctx.fillStyle = l ? "#e6edf3" : "#6f7d8b";
  ctx.font = `700 22px ${DISP}`;
  ctx.fillText(l ? l.name : "empty", ax + 94, ay + 24);
  if (l && slotCellKind("lan")) {
    gemDraw(ctx, ax + 101, ay + 56, 7, CARD_K[cellKind("lan")] || "#888");
    ctx.fillStyle = S.cells.lan ? "#d5dbe2" : "#6f7d8b";
    ctx.font = `600 12px ${SANS}`;
    ctx.fillText(
      cellName("lan") || slotCellKind("lan") + " socket",
      ax + 114,
      ay + 49,
    );
  }
  // perks on the right with pips
  const px = 790,
    pw = W_ - 48 - px;
  ctx.fillStyle = "#7b8794";
  ctx.font = `700 11px ${SANS}`;
  ctx.fillText("PERKS", px, 112);
  const list = Object.entries(t.pts)
    .filter(([n]) => Pi[n] != null)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12);
  let py = 130;
  for (const [n, v] of list) {
    const p = P[Pi[n]],
      tier = Math.min(6, v),
      col = CARD_K[p.type] || "#888";
    ctx.fillStyle = "#e6edf3";
    ctx.font = `600 15px ${SANS}`;
    ctx.fillText(n, px, py);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i < tier ? col : "rgba(255,255,255,.12)";
      ctx.fillRect(px + 212 + i * 20, py + 3, 15, 11);
    }
    ctx.fillStyle = v > 6 ? "#f08a5d" : col;
    ctx.font = `800 14px ${SANS}`;
    ctx.textAlign = "right";
    ctx.fillText("+" + v, px + pw, py + 1);
    ctx.textAlign = "left";
    py += 26;
  }
  if (!list.length) {
    ctx.fillStyle = "#6f7d8b";
    ctx.font = `500 14px ${SANS}`;
    ctx.fillText("No perks yet.", px, py);
    py += 26;
  }
  // element strengths from armour
  const els = ELEMENTS.filter((e) => t.el[e]);
  if (els.length) {
    py += 6;
    ctx.fillStyle = "#7b8794";
    ctx.font = `700 11px ${SANS}`;
    ctx.fillText("ARMOUR ELEMENTS", px, py);
    py += 18;
    let ex = px;
    for (const e of els) {
      const s = `${e} ${t.el[e] > 0 ? "+" + t.el[e] : t.el[e]}`;
      ctx.font = `700 13px ${SANS}`;
      const tw = ctx.measureText(s).width + 18;
      ctx.fillStyle = CARD_EL[e] + "33";
      ctx.fillRect(ex, py, tw, 22);
      ctx.fillStyle = CARD_EL[e];
      ctx.fillText(s, ex + 9, py + 4);
      ex += tw + 8;
    }
    py += 32;
  }
  // unique effects: a couple of lines
  const ues = [];
  if (w)
    for (const u of atLevel(w.unique_effects, S.wl)) ues.push(u.description);
  for (const k of ARMOUR) {
    const a = S.a[k].i >= 0 ? A[S.a[k].i] : null;
    if (a)
      for (const u of atLevel(a.unique_effects, S.a[k].l))
        ues.push(u.description);
  }
  if (ues.length && py < 560) {
    ctx.fillStyle = "#7b8794";
    ctx.font = `700 11px ${SANS}`;
    ctx.fillText("UNIQUE EFFECT", px, py);
    py += 18;
    ctx.fillStyle = "#a5b2bf";
    ctx.font = `500 13px ${SANS}`;
    for (const line of wrap(ctx, String(ues[0] || "").trim(), pw).slice(0, 4)) {
      if (py > 580) break;
      ctx.fillText(line, px, py);
      py += 17;
    }
  }
  // footer: build code stamp and the site
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(40, H_ - 62, W_ - 80, 34);
  ctx.fillStyle = "#d9ae52";
  ctx.font = `700 15px ${DISP}`;
  ctx.fillText("BUILD CODE", 52, H_ - 52);
  ctx.fillStyle = "#e6edf3";
  ctx.font = `500 13px ui-monospace, Consolas, monospace`;
  const code =
    currentVersion === "1.6.2"
      ? encode(S)
      : "1147 · Export build for the complete code";
  const cs = fitText(
    ctx,
    code,
    W_ - 420,
    13,
    "500",
    "ui-monospace, Consolas, monospace",
  );
  ctx.font = `500 ${cs}px ui-monospace, Consolas, monospace`;
  ctx.fillText(code, 150, H_ - 52);
  ctx.textAlign = "right";
  ctx.fillStyle = "#a5b2bf";
  ctx.font = `600 13px ${SANS}`;
  ctx.fillText("Dauntless Builder · Local", W_ - 52, H_ - 52);
  ctx.textAlign = "left";
}
async function openCard() {
  const cv = $("card-canvas");
  await drawCard(cv);
  $("cdlg").showModal();
}
$("b-card").addEventListener("click", openCard);
$("cdlg-x").addEventListener("click", () => $("cdlg").close());
$("cdlg").addEventListener("click", (e) => {
  if (e.target === $("cdlg")) $("cdlg").close();
});
$("b-card-dl").addEventListener("click", async () => {
  const blob = await new Promise((resolve) =>
    $("card-canvas").toBlob(resolve, "image/png"),
  );
  if (!blob) {
    $("cdlg-msg").textContent = "Could not create the image. Please try again.";
    return;
  }
  const a = document.createElement("a");
  a.download = "dauntless-build-" + currentVersion + ".png";
  a.href = URL.createObjectURL(blob);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("b-card-copy").addEventListener("click", async () => {
  try {
    const blob = await new Promise((r) =>
      $("card-canvas").toBlob(r, "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    $("cdlg-msg").textContent = "Card copied. Paste it into Discord.";
  } catch {
    $("cdlg-msg").textContent =
      "Copying is blocked here: use Download PNG and drag the file into Discord.";
  }
  clearTimeout(openCard.t);
  openCard.t = setTimeout(() => ($("cdlg-msg").textContent = ""), 4000);
});

const renderCatalogue = setupCatalogue({
  catalogues,
  datasets,
  getVersion: () => currentVersion,
  image: img,
  selectGear: ({ category, index, gear }) => {
    if (category === "weapons") {
      S.parts = {};
      S.w = index;
    } else if (category === "armours") S.a[gear.type].i = index;
    else if (category === "lanterns") S.lan = index;
    else if (category === "omnicells") S.omni = index;
    isExample = false;
    render();
  },
});

// Local build library and file exchange are separate from game saves.
function readLibrary() {
  try {
    const value = JSON.parse(localStorage.getItem("df-local-library") || "[]");
    return Array.isArray(value)
      ? value
          .filter(
            (item) =>
              item &&
              typeof item.id === "string" &&
              typeof item.code === "string" &&
              typeof item.name === "string",
          )
          .slice(0, 50)
      : [];
  } catch {
    return [];
  }
}
function storeLibrary(items) {
  localStorage.setItem("df-local-library", JSON.stringify(items));
}
function drawLibrary() {
  const holder = $("library-list");
  holder.replaceChildren();
  const entries = readLibrary();
  if (!entries.length) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      "No saved builds yet. Name your build and click Save build.";
    holder.append(note);
  }
  for (const item of entries) {
    const row = document.createElement("div");
    row.className = "library-row";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const version = document.createElement("small");
    version.textContent = item.version;
    const load = document.createElement("button");
    load.className = "btn";
    load.textContent = "Load";
    load.onclick = () => {
      try {
        loadCode(item.code);
        $("build-name").value = item.name;
        save();
        $("library").close();
      } catch (error) {
        say(error.message);
      }
    };
    const remove = document.createElement("button");
    remove.className = "btn";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", "Delete " + item.name);
    remove.onclick = () => {
      storeLibrary(readLibrary().filter((other) => other.id !== item.id));
      drawLibrary();
    };
    row.append(name, version, load, remove);
    holder.append(row);
  }
}
$("b-library").onclick = () => {
  drawLibrary();
  $("library").showModal();
};
$("library-close").onclick = () => $("library").close();
$("b-save").onclick = () => {
  try {
    const entries = readLibrary();
    if (entries.length >= 50)
      throw Error(
        "Your library has 50 builds. Export or delete an old build first.",
      );
    entries.unshift({
      id: crypto.randomUUID(),
      name: $("build-name").value.trim() || "Untitled build",
      version: currentVersion,
      code: encode(S),
    });
    storeLibrary(entries);
    save();
    say("Build saved on this browser.");
  } catch (error) {
    say(error.message);
  }
};
$("build-name").addEventListener("input", save);
$("game-version").onchange = () => {
  save();
  const requested = $("game-version").value;
  let rememberedCode = "";
  let rememberedName = "";
  try {
    rememberedCode = localStorage.getItem("df-local-build-" + requested) || "";
    rememberedName = localStorage.getItem("df-local-name-" + requested) || "";
  } catch {}
  activateDataset(requested);
  $("build-name").value = rememberedName;
  let loaded = false;
  try {
    if (rememberedCode) {
      loadCode(rememberedCode);
      loaded = true;
    }
  } catch {}
  if (!loaded) {
    S = example();
    isExample = true;
    render();
  }
  renderCatalogue();
};
$("b-export").onclick = () => {
  const file = new Blob(
    [
      JSON.stringify(
        {
          format: "dauntless-local-build",
          schema: 1,
          version: currentVersion,
          name: $("build-name").value.trim() || "Untitled build",
          code: encode(S),
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = "dauntless-" + currentVersion + ".dfbuild.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
$("b-import").onclick = () => $("build-file").click();
$("build-file").onchange = async () => {
  const file = $("build-file").files[0];
  if (!file) return;
  try {
    if (file.size > 64000) throw Error("Build file is too large.");
    let text = await file.text(),
      name = "";
    if (text.trim().startsWith("{")) {
      const object = JSON.parse(text);
      if (
        object.format !== "dauntless-local-build" ||
        object.schema !== 1 ||
        typeof object.code !== "string"
      )
        throw Error("Unrecognized build file.");
      text = object.code;
      if (object.version !== decodeBuild(text, datasets).version)
        throw Error("The file version does not match its build code.");
      name = typeof object.name === "string" ? object.name.slice(0, 80) : "";
    }
    loadCode(text);
    $("build-name").value = name;
    save();
    say("Build file imported for " + currentVersion + ".");
  } catch (error) {
    say(error.message);
  } finally {
    $("build-file").value = "";
  }
};
boot();
