// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manifest = require("../desktop-update-manifest.cjs");

async function publish({ source, executable, output, privateKeyFile }) {
  const config = JSON.parse(
    fs.readFileSync(path.join(source, "update-channel.json"), "utf8"),
  );
  const version = JSON.parse(
    fs.readFileSync(path.join(source, "package.json"), "utf8"),
  ).version;
  manifest.compareVersions(version, "0.0.0");
  const key = crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !crypto
      .createPublicKey(key)
      .equals(crypto.createPublicKey(config.publicKey))
  )
    throw Error(
      "The release key does not match the application's verification key.",
    );
  const repository = config.applicationRepository;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("Invalid application release repository.");
  const payload = {
    schema: 1,
    kind: "inventory-desktop",
    channel: "stable",
    platform: "win32-x64",
    version,
    bytes: fs.statSync(executable).size,
    sha256: await manifest.hashFile(executable),
    url:
      "https://github.com/" +
      repository +
      "/releases/download/v" +
      version +
      "/DauntlessInventoryLive-" +
      version +
      ".exe",
    sourceUrl: "https://github.com/" + repository + "/tree/v" + version,
  };
  await manifest.verifyExecutable(executable, payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = {
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, key).toString("base64url"),
  };
  manifest.decodeManifest(envelope, config.publicKey, repository);
  const target = path.join(output, "releases", version + ".json");
  if (fs.existsSync(target))
    throw Error("Application release already exists. Increase the version.");
  const latest = path.join(output, "latest.json");
  if (fs.existsSync(latest)) {
    const old = manifest.decodeManifest(
      JSON.parse(fs.readFileSync(latest, "utf8")),
      config.publicKey,
      repository,
    );
    if (manifest.compareVersions(version, old.version) <= 0)
      throw Error("A published application feed cannot go backwards.");
  }
  manifest.writeJson(target, envelope);
  manifest.writeJson(latest, envelope);
  return {
    version,
    bytes: payload.bytes,
    sha256: payload.sha256,
    assetUrl: payload.url,
  };
}
if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2)
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  if (!args.source || !args.exe || !args.out || !args.key) {
    console.error(
      "Usage: node scripts/publish-application-update.cjs --source Source-Code --exe dist/DauntlessInventoryLive.exe --out app-updates --key C:/Keys/release.pem",
    );
    process.exitCode = 1;
  } else
    publish({
      source: args.source,
      executable: args.exe,
      output: args.out,
      privateKeyFile: args.key,
    })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
module.exports = { publish };
