// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_EXE = 512 * 1024 * 1024;
function compareVersions(left, right) {
  const parse = (value) => {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
    )
      throw Error("Invalid application version.");
    return value.split(".").map(Number);
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function checkedUrl(value, { loopback = false } = {}) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(loopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw Error("Application updates require HTTPS.");
  return url;
}
function decodeManifest(envelope, publicKey, repository) {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 16000 ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.payload) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
  )
    throw Error("Invalid application update manifest.");
  const bytes = Buffer.from(envelope.payload, "base64url");
  const key = crypto.createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !crypto.verify(
      null,
      bytes,
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  )
    throw Error("Application update signature is invalid.");
  const data = JSON.parse(bytes.toString("utf8"));
  compareVersions(data.version, "0.0.0");
  if (
    data.schema !== 1 ||
    data.kind !== "inventory-desktop" ||
    data.channel !== "stable" ||
    data.platform !== "win32-x64" ||
    !Number.isSafeInteger(data.bytes) ||
    data.bytes < 2 ||
    data.bytes > MAX_EXE ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256)
  )
    throw Error("Unsupported application update.");
  const url = checkedUrl(data.url);
  const expected =
    "/" +
    repository +
    "/releases/download/v" +
    data.version +
    "/DauntlessInventoryLive-" +
    data.version +
    ".exe";
  if (
    url.hostname !== "github.com" ||
    url.port ||
    url.search ||
    url.pathname !== expected
  )
    throw Error(
      "Application update does not belong to the configured release repository.",
    );
  if (
    data.sourceUrl !==
    "https://github.com/" + repository + "/tree/v" + data.version
  )
    throw Error("Application update is missing its matching source release.");
  return {
    ...data,
    envelope,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
function safeDirectory(directory) {
  const resolved = path.resolve(directory);
  let current = resolved;
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw Error("Update directories cannot contain links.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(resolved, { recursive: true });
  current = resolved;
  for (;;) {
    if (fs.lstatSync(current).isSymbolicLink())
      throw Error("Update directories cannot contain links.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}
function writeJson(file, data) {
  safeDirectory(path.dirname(file));
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
    throw Error("Unsafe update metadata file.");
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
async function verifyExecutable(file, release) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== release.bytes)
    throw Error("Application update size is invalid.");
  if ((await hashFile(file)) !== release.sha256)
    throw Error("Application update failed its integrity check.");
  const handle = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(2);
    fs.readSync(handle, header, 0, 2, 0);
    if (header.toString("ascii") !== "MZ")
      throw Error("The downloaded update is not a Windows executable.");
  } finally {
    fs.closeSync(handle);
  }
}

module.exports = {
  MAX_EXE,
  compareVersions,
  checkedUrl,
  decodeManifest,
  hashFile,
  safeDirectory,
  writeJson,
  verifyExecutable,
};
