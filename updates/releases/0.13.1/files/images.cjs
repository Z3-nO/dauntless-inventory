"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const USER =
  process.env.MATERIALI_USER_DATA ||
  path.join(
    process.env.LOCALAPPDATA || __dirname,
    "DauntlessMateriali",
    "preferences",
  );
const maps = new Map();
const bundledIcons = require("./data/icon-map.json");
const extOK = /\.(png|jpe?g|webp)$/i;
const normalize = (s) =>
  s
    .toUpperCase()
    .replace(/^(?:(?:T|UI|ICON)_)+/, "")
    .replace(/[^A-Z0-9]/g, "");
function settings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(USER, "images.json"), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(value) {
  fs.mkdirSync(USER, { recursive: true });
  const file = path.join(USER, "images.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
async function scan(root, version, catalog, remember = true) {
  if (!root || !fs.statSync(root).isDirectory())
    throw Error("Select a folder containing exported or game images.");
  root = fs.realpathSync(root);
  const files = [],
    stack = [root];
  let archives = 0,
    unreal = 0,
    visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fs.promises.readdir(dir, {
      withFileTypes: true,
    })) {
      if (++visited > 50000)
        throw Error(
          "Folder too large. Select a preview subfolder containing at most 50,000 entries.",
        );
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) {
        if (extOK.test(entry.name)) files.push(file);
        else if (/\.(pak|utoc|ucas)$/i.test(entry.name)) archives++;
        else if (/\.uasset$/i.test(entry.name)) unreal++;
      }
    }
  }
  const byName = new Map();
  for (const file of files) {
    const key = normalize(path.basename(file, path.extname(file)));
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(file);
  }
  let manifest = {};
  const manifestFile = path.join(root, "materiali-images.json");
  if (fs.existsSync(manifestFile)) {
    if (fs.statSync(manifestFile).size > 2000000)
      throw Error("Image map too large.");
    manifest = JSON.parse(
      fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""),
    );
  }
  const map = new Map();
  let ambiguous = 0;
  for (const item of catalog) {
    if (Object.hasOwn(manifest, item.id)) {
      const value = manifest[item.id];
      if (typeof value !== "string")
        throw Error("Invalid path in the image map: " + item.id);
      const file = fs.realpathSync(path.resolve(root, value));
      if (
        !inside(root, file) ||
        !extOK.test(file) ||
        !fs.statSync(file).isFile()
      )
        throw Error(
          "Image outside the selected folder or unsupported: " + item.id,
        );
      map.set(item.id, file);
      continue;
    }
    const matches =
      byName.get(normalize(item.id)) ||
      (item.name !== item.id ? byName.get(normalize(item.name)) : null) ||
      [];
    if (matches.length === 1) map.set(item.id, matches[0]);
    else if (matches.length > 1) ambiguous++;
  }
  maps.set(version, map);
  if (remember) {
    const config = settings();
    config[version] = root;
    writeSettings(config);
  }
  return {
    matched: map.size,
    images: files.length,
    archives,
    unreal,
    ambiguous,
    root,
    message:
      archives || unreal
        ? "Unreal archives require texture export first (for example with FModel). This tool does not extract them."
        : "",
  };
}
function importedFile(version, id) {
  const dir = path.join(USER, "images", version);
  for (const ext of ["png", "jpg", "webp"]) {
    const file = path.join(dir, id + "." + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
function find(version, id, base) {
  const bundled = bundledIcons[version]?.[id];
  const candidates = [
    importedFile(version, id),
    maps.get(version)?.get(id),
    bundled ? path.join(base, "assets", bundled) : null,
  ];
  for (const file of candidates)
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  return path.join(base, "assets", id + ".png");
}
function standardPaths(root, version, base = __dirname, selectedGameDir = "") {
  let gameDir = selectedGameDir || null;
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }
  };
  if (root && !gameDir) {
    for (const candidate of [
      path.join(root, "versions", version),
      path.join(root, version),
      root,
    ]) {
      const config = read(path.join(candidate, "config.json"));
      if (typeof config?.GameDir === "string" && config.GameDir.trim()) {
        gameDir = path.resolve(config.GameDir);
        break;
      }
    }
    if (!gameDir) {
      const config = read(path.join(root, "launcher.json"));
      const configured = config?.versions?.[version]?.gameDir;
      if (typeof configured === "string" && configured.trim())
        gameDir = path.resolve(configured);
    }
  }
  const nativeRoot = gameDir
    ? path.join(gameDir, "Archon", "Content", "Paks")
    : null;
  let archives = 0,
    nativeFound = false;
  if (nativeRoot)
    try {
      nativeFound = fs.statSync(nativeRoot).isDirectory();
      if (nativeFound)
        archives = fs
          .readdirSync(nativeRoot)
          .filter((n) => /\.(pak|utoc|ucas)$/i.test(n)).length;
    } catch {}
  const associations = Object.entries(bundledIcons[version] || {});
  const missing = associations
    .filter(([, file]) => !fs.existsSync(path.join(base, "assets", file)))
    .map(([id]) => id);
  return {
    bundledRoot: path.join(base, "assets", "builder"),
    bundledAssociations: associations.length,
    bundledAvailable: associations.length - missing.length,
    bundledMissing: missing.length,
    gameDir,
    nativeRoot,
    nativeFound,
    archives,
    exportRoot: settings()[version] || null,
  };
}
function importImage(version, id, base64) {
  if (typeof base64 !== "string" || base64.length > 12000000)
    throw Error("Image too large: 8 MB maximum.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 8000000) throw Error("Image too large: 8 MB maximum.");
  const ext = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "jpg"
      : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : null;
  if (!ext) throw Error("Unsupported format. Choose PNG, JPEG or WebP.");
  const dir = path.join(USER, "images", version);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, crypto.randomBytes(8).toString("hex") + ".tmp");
  fs.writeFileSync(tmp, bytes);
  for (const old of ["png", "jpg", "webp"]) {
    const file = path.join(dir, id + "." + old);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.renameSync(tmp, path.join(dir, id + "." + ext));
}
async function restore(catalogs) {
  for (const [version, root] of Object.entries(settings()))
    if (Object.hasOwn(catalogs, version)) {
      try {
        await scan(root, version, catalogs[version], false);
      } catch {}
    }
}
module.exports = { scan, find, importImage, restore, settings, standardPaths };
