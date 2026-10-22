// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
function validate(value) {
  if (
    !value ||
    !["1.6.2", "1.14.7"].includes(value.version) ||
    !["add", "set"].includes(value.mode) ||
    typeof value.maximize !== "boolean"
  )
    throw Error("Invalid editor draft.");
  if (
    !value.selection ||
    typeof value.selection !== "object" ||
    Array.isArray(value.selection) ||
    Object.keys(value.selection).length > 15000
  )
    throw Error("Invalid editor selection.");
  for (const [id, count] of Object.entries(value.selection))
    if (
      !/^[A-Za-z0-9_.-]{1,256}$/.test(id) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 99999999
    )
      throw Error("Invalid draft item.");
  if (typeof value.buildCode !== "string" || value.buildCode.length > 1000000)
    throw Error("Invalid draft build code.");
  if (
    value.character !== undefined &&
    (typeof value.character !== "string" || value.character.length > 1024)
  )
    throw Error("Invalid draft character.");
  return {
    version: value.version,
    mode: value.mode,
    maximize: value.maximize,
    selection: value.selection,
    buildCode: value.buildCode,
    ...(value.character === undefined ? {} : { character: value.character }),
  };
}
function save(file, value) {
  const draft = validate(value),
    bytes = JSON.stringify({ saved: Date.now(), draft });
  if (Buffer.byteLength(bytes) > 2000000)
    throw Error("The editor draft is too large.");
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw Error("Unsafe saved editor draft.");
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function take(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
    throw Error("Invalid saved editor draft.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const draft =
    Date.now() - value.saved >= 0 && Date.now() - value.saved < 86400000
      ? validate(value.draft)
      : null;
  fs.unlinkSync(file);
  return draft;
}
module.exports = { validate, save, take };
