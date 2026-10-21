// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const LIVE_MODULES = new Set([
  "live-install.cjs",
  "live-runtime.cjs",
  "live-adapters.cjs",
  "live-native.cjs",
  "saves.cjs",
  "inventory.cjs",
  "loadouts.cjs",
  "build-import.cjs",
  "build1147.cjs",
  "build-export.cjs",
  "slot-management.cjs",
  "character-reset.cjs",
  "live-client.cjs",
  "directories.cjs",
  "settings.cjs",
  "images.cjs",
  "package.json",
  "LICENSE",
  "NOTICE.txt",
]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function compareVersions(left, right) {
  const parse = (value) => {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
    )
      throw Error("Invalid update version.");
    return value.split(".").map(Number);
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

function safeFile(name) {
  if (
    typeof name !== "string" ||
    name.length > 180 ||
    !/^[A-Za-z0-9_./-]+$/.test(name)
  )
    throw Error("Invalid update file path.");
  const parts = name.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[.]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    throw Error("Unsafe update file path.");
  if (
    LIVE_MODULES.has(name) ||
    /^data\/.+\.(json|mjs|txt)$/.test(name) ||
    /^native\/(dxgi\.dll|UndauntedInternalServer\.dll|manifest(?:162)?\.json)$/.test(
      name,
    )
  )
    return name;
  throw Error("Unexpected file in Live update.");
}

function decodeRelease(envelope, publicKey, toolVersion) {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    envelope.payload.length > 180000 ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.payload) ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
  )
    throw Error("Invalid signed update manifest.");
  const payload = Buffer.from(envelope.payload, "base64url");
  const key = crypto.createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !crypto.verify(
      null,
      payload,
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  )
    throw Error("Live update signature is invalid. No files installed.");
  const release = JSON.parse(payload.toString("utf8"));
  if (
    release.schema !== 1 ||
    release.installerApi !== 1 ||
    release.channel !== "stable"
  )
    throw Error("Unsupported Live update format.");
  compareVersions(release.version, "0.0.0");
  if (compareVersions(release.minToolVersion, toolVersion) > 0)
    throw Error("This module needs a newer Inventory application.");
  if (
    !Array.isArray(release.files) ||
    !release.files.length ||
    release.files.length > 128
  )
    throw Error("Invalid Live update file list.");
  let size = 0;
  const names = new Set();
  for (const file of release.files) {
    safeFile(file.path);
    const folded = file.path.toLowerCase();
    if (names.has(folded)) throw Error("Duplicate update file path.");
    names.add(folded);
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_FILE ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error("Invalid update file integrity metadata.");
    size += file.bytes;
  }
  if (size > MAX_TOTAL) throw Error("Live update is too large.");
  for (const name of [
    ...LIVE_MODULES,
    "native/dxgi.dll",
    "native/manifest.json",
    "native/UndauntedInternalServer.dll",
    "native/manifest162.json",
    "data/catalogs.json",
  ])
    if (!names.has(name.toLowerCase()))
      throw Error("Live update is incomplete: " + name);
  return { ...release, digest: hash(payload) };
}

function checkedPath(root, relative) {
  safeFile(relative);
  const base = path.resolve(root),
    result = path.resolve(base, relative);
  if (!result.startsWith(base + path.sep))
    throw Error("Unsafe update destination.");
  return result;
}

function verifyDirectory(folder, publicKey, toolVersion) {
  const envelope = JSON.parse(
    fs.readFileSync(path.join(folder, "release.json"), "utf8"),
  );
  const release = decodeRelease(envelope, publicKey, toolVersion);
  if (fs.lstatSync(path.join(folder, "files")).isSymbolicLink())
    throw Error("Update file links are not supported.");
  const root = fs.realpathSync(path.join(folder, "files"));
  for (const file of release.files) {
    const target = checkedPath(root, file.path);
    if (
      !fs.realpathSync(target).startsWith(root + path.sep) ||
      fs.lstatSync(target).isSymbolicLink()
    )
      throw Error("Update file links are not supported.");
    const bytes = fs.readFileSync(target);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw Error("Live update file failed verification: " + file.path);
  }
  return release;
}

function updateUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error(
      "Use an HTTPS update source without credentials or query parameters.",
    );
  return url;
}

async function download(url, limit, fetcher = fetch) {
  const response = await fetcher(updateUrl(url), {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error("Update download failed (HTTP " + response.status + ").");
  if (Number(response.headers.get("content-length")) > limit)
    throw Error("Update response is too large.");
  let size = 0;
  const chunks = [];
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw Error("Update response is too large.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

module.exports = {
  MAX_TOTAL,
  MAX_FILE,
  LIVE_MODULES,
  hash,
  safeFile,
  compareVersions,
  decodeRelease,
  checkedPath,
  verifyDirectory,
  updateUrl,
  download,
  writeJson,
};
