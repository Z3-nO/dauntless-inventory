// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const packages = require("../live-update-package.cjs");

function publish({
  source,
  output,
  privateKeyFile,
  sourceUrl,
  minToolVersion = "0.12.0",
}) {
  source = path.resolve(source);
  output = path.resolve(output);
  const version = JSON.parse(
    fs.readFileSync(path.join(source, "package.json")),
  ).version;
  packages.compareVersions(version, minToolVersion);
  const key = crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
  const trusted = JSON.parse(
    fs.readFileSync(path.join(source, "update-channel.json")),
  );
  if (
    key.asymmetricKeyType !== "ed25519" ||
    crypto.createPublicKey(key).export({ format: "pem", type: "spki" }) !==
      trusted.publicKey
  )
    throw Error("The signing key does not match the application's public key.");
  if (!sourceUrl || !sourceUrl.startsWith("https://"))
    throw Error("Provide the corresponding source URL.");
  const names = new Set(packages.LIVE_MODULES);
  function collect(folder) {
    for (const entry of fs.readdirSync(path.join(source, folder), {
      withFileTypes: true,
    })) {
      const file = folder + "/" + entry.name;
      if (entry.isSymbolicLink())
        throw Error("Update sources cannot contain links.");
      if (entry.isDirectory()) collect(file);
      else {
        packages.safeFile(file);
        names.add(file);
      }
    }
  }
  collect("data");
  for (const file of [
    "dxgi.dll",
    "UndauntedInternalServer.dll",
    "manifest.json",
    "manifest162.json",
  ])
    names.add("native/" + file);
  const files = [...names].sort().map((name) => {
    const bytes = fs.readFileSync(path.join(source, name));
    return { path: name, bytes: bytes.length, sha256: packages.hash(bytes) };
  });
  const release = {
    schema: 1,
    installerApi: 1,
    channel: "stable",
    version,
    minToolVersion,
    publishedAt: new Date().toISOString(),
    sourceUrl,
    assetPath: "releases/" + version + "/",
    files,
  };
  const bytes = Buffer.from(JSON.stringify(release));
  const envelope = {
    payload: bytes.toString("base64url"),
    signature: crypto.sign(null, bytes, key).toString("base64url"),
  };
  packages.decodeRelease(envelope, trusted.publicKey, version);
  const destination = path.join(output, "releases", version);
  if (fs.existsSync(destination))
    throw Error(
      "Published version already exists. Increase the module version.",
    );
  fs.mkdirSync(path.join(destination, "files"), { recursive: true });
  for (const file of files) {
    const target = path.join(destination, "files", file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file.path), target);
  }
  packages.writeJson(path.join(destination, "release.json"), envelope);
  packages.verifyDirectory(destination, trusted.publicKey, version);
  packages.writeJson(path.join(output, "latest.json"), envelope);
  return {
    version,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

if (require.main === module) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce(
        (pairs, value, i, all) =>
          value.startsWith("--")
            ? [...pairs, [value.slice(2), all[i + 1]]]
            : pairs,
        [],
      ),
  );
  if (!args.source || !args.out || !args.key || !args["source-url"]) {
    console.error(
      "Usage: node scripts/publish-live-update.cjs --source <Source-Code> --out <updates> --key <private.pem> --source-url <https://source/tag>",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          publish({
            source: args.source,
            output: args.out,
            privateKeyFile: args.key,
            sourceUrl: args["source-url"],
            minToolVersion: args["min-tool"] || "0.12.0",
          }),
        ),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
module.exports = { publish };
