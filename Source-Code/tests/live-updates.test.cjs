const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const packages = require("../live-update-package.cjs");
const { LiveUpdates } = require("../live-updates.cjs");
const transactions = require("../live-update-install.cjs");
const native = require("../live-native.cjs");
const saves = require("../saves.cjs");
const installed = require("../live-install.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dauntless-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" });
  const files = [
    ...packages.LIVE_MODULES,
    "native/dxgi.dll",
    "native/manifest.json",
    "native/UndauntedInternalServer.dll",
    "native/manifest162.json",
    "data/catalogs.json",
  ].map((name) => ({
    path: name,
    content: Buffer.from(
      name === "live-install.cjs"
        ? 'module.exports={version:"0.12.1",fingerprint:()=>"fixture",install:async()=>({})};'
        : name === "package.json"
          ? JSON.stringify({ version: "0.12.1" })
          : name + "\n",
    ),
  }));
  const payload = {
    schema: 1,
    installerApi: 1,
    channel: "stable",
    version: "0.12.1",
    minToolVersion: "0.12.0",
    assetPath: "releases/0.12.1/",
    files: files.map((file) => ({
      path: file.path,
      bytes: file.content.length,
      sha256: packages.hash(file.content),
    })),
  };
  function sign(value = payload, key = keys.privateKey) {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      payload: bytes.toString("base64url"),
      signature: crypto.sign(null, bytes, key).toString("base64url"),
    };
  }
  const releaseFolder = path.join(root, "release");
  fs.mkdirSync(releaseFolder);
  packages.writeJson(path.join(releaseFolder, "release.json"), sign());
  for (const file of files) {
    const destination = path.join(releaseFolder, "files", file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  const updater = new LiveUpdates({
    directory: path.join(root, "preferences"),
    config: { publicKey },
    toolVersion: "0.12.0",
  });
  return {
    root,
    keys,
    publicKey,
    files,
    payload,
    sign,
    releaseFolder,
    updater,
  };
}

test("Signed offline release imports, persists and revalidates before loading its installer", async (t) => {
  const f = fixture(t);
  const result = await f.updater.importFolder(f.releaseFolder);
  assert.equal(result.downloadedVersion, "0.12.1");
  assert.equal(f.updater.installer().version, "0.12.1");
  const reloaded = new LiveUpdates({
    directory: f.updater.directory,
    config: { publicKey: f.publicKey },
    toolVersion: "0.12.0",
  });
  assert.equal(reloaded.installer().fingerprint(), "fixture");
  const cached = reloaded.destination(reloaded.state.latest);
  fs.appendFileSync(
    path.join(cached, "files/live-install.cjs"),
    "throw Error('must never execute');",
  );
  assert.throws(() => reloaded.installer(), /failed verification/);
});

test("Payload tampering, unknown signer and corrupt signatures are rejected", (t) => {
  const f = fixture(t),
    envelope = f.sign();
  assert.equal(
    packages.decodeRelease(envelope, f.publicKey, "0.12.0").version,
    "0.12.1",
  );
  const other = crypto.generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      packages.decodeRelease(
        f.sign(f.payload, other.privateKey),
        f.publicKey,
        "0.12.0",
      ),
    /signature/,
  );
  assert.throws(
    () =>
      packages.decodeRelease(
        { ...envelope, payload: Buffer.from("{}").toString("base64url") },
        f.publicKey,
        "0.12.0",
      ),
    /signature/,
  );
  assert.throws(
    () =>
      packages.decodeRelease(
        { ...envelope, signature: "A".repeat(86) },
        f.publicKey,
        "0.12.0",
      ),
    /signature/,
  );
});

test("Signed manifests still enforce path, size, duplicate and completeness rules", (t) => {
  const f = fixture(t);
  const invalid = [
    {
      ...f.payload,
      files: [{ path: "../outside.cjs", bytes: 1, sha256: "0".repeat(64) }],
    },
    { ...f.payload, files: [...f.payload.files, f.payload.files[0]] },
    { ...f.payload, files: f.payload.files.slice(1) },
    {
      ...f.payload,
      files: [
        { ...f.payload.files[0], bytes: packages.MAX_FILE + 1 },
        ...f.payload.files.slice(1),
      ],
    },
    { ...f.payload, minToolVersion: "9.0.0" },
    { ...f.payload, schema: 99 },
  ];
  for (const payload of invalid)
    assert.throws(() =>
      packages.decodeRelease(f.sign(payload), f.publicKey, "0.12.0"),
    );
  for (const name of [
    "data/../../escape.json",
    "C:/escape.cjs",
    "data/con.json",
    "data/x./y.json",
    "data\\escape.json",
    "/data/x.json",
    "runtime/node.exe",
    "main.cjs",
    "data//x.json",
  ])
    assert.throws(() => packages.safeFile(name), name);
});

test("Offline import refuses missing/corrupt files and never changes the selected release", async (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    path.join(f.releaseFolder, "files/native/dxgi.dll"),
    "corrupt",
  );
  await assert.rejects(
    () => f.updater.importFolder(f.releaseFolder),
    /failed verification/,
  );
  assert.equal(f.updater.status().downloadedVersion, null);
  assert.equal(f.updater.busy, false);
});

test("Older versions and republished versions with different signed content cannot replace a cached release", async (t) => {
  const f = fixture(t);
  await f.updater.importFolder(f.releaseFolder);
  const previous = structuredClone(f.updater.state.latest);
  for (const version of ["0.11.9", "0.12.0"]) {
    packages.writeJson(
      path.join(f.releaseFolder, "release.json"),
      f.sign({ ...f.payload, version }),
    );
    await assert.rejects(
      () => f.updater.importFolder(f.releaseFolder),
      /older|rollback/,
    );
  }
  packages.writeJson(
    path.join(f.releaseFolder, "release.json"),
    f.sign({ ...f.payload, notes: "changed content" }),
  );
  await assert.rejects(
    () => f.updater.importFolder(f.releaseFolder),
    /changed release/,
  );
  assert.deepEqual(f.updater.state.latest, previous);
});

test("Unconfigured source is explicit; automatic preferences persist and unsafe URLs are refused", (t) => {
  const f = fixture(t);
  assert.equal(f.updater.status().configured, false);
  f.updater.saveSettings({
    feedUrl: "https://example.org/live/latest.json",
    automaticCheck: false,
    automaticInstall: false,
  });
  assert.equal(f.updater.status().automaticCheck, false);
  for (const feedUrl of [
    "http://example.org/feed",
    "file:///feed",
    "https://user:secret@example.org/feed",
    "https://example.org/feed?secret=x",
  ])
    assert.throws(() =>
      f.updater.saveSettings({
        feedUrl,
        automaticCheck: true,
        automaticInstall: true,
      }),
    );
  assert.throws(() =>
    f.updater.destination({ version: "../../x", digest: "x" }),
  );
  assert.throws(() =>
    f.updater.destination({ version: "0.12.1", digest: "../../x" }),
  );
});

async function serve(t, f, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/latest.json";
  f.updater.saveSettings({
    feedUrl: url,
    automaticCheck: true,
    automaticInstall: true,
  });
  return url;
}

test("Network update downloads signed files, verifies them and reuses its complete cache", async (t) => {
  const f = fixture(t);
  let filesDownloaded = 0;
  await serve(t, f, (req, res) => {
    if (req.url === "/latest.json") return res.end(JSON.stringify(f.sign()));
    const name = req.url.replace("/releases/0.12.1/files/", "");
    const file = f.files.find((item) => item.path === name);
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    filesDownloaded++;
    res.end(file.content);
  });
  await f.updater.check();
  assert.equal(filesDownloaded, f.files.length);
  assert.equal(f.updater.installer().version, "0.12.1");
  await f.updater.check();
  assert.equal(filesDownloaded, f.files.length);
});

test("Interrupted downloads preserve the old cache and remove only their own staging directory", async (t) => {
  const f = fixture(t);
  await f.updater.importFolder(f.releaseFolder);
  const previous = structuredClone(f.updater.state.latest);
  await serve(t, f, (req, res) => {
    if (req.url === "/latest.json")
      return res.end(
        JSON.stringify(
          f.sign({
            ...f.payload,
            version: "0.12.2",
            assetPath: "releases/0.12.2/",
          }),
        ),
      );
    res.writeHead(503);
    res.end("Unavailable");
  });
  await assert.rejects(() => f.updater.check(), /503/);
  assert.deepEqual(f.updater.state.latest, previous);
  assert.equal(
    fs
      .readdirSync(f.updater.directory)
      .some((name) => name.startsWith("staging-")),
    false,
  );
});

test("Redirects and oversized network responses are rejected", async (t) => {
  const f = fixture(t);
  const url = await serve(t, f, (req, res) => {
    res.writeHead(302, { Location: "/redirected" });
    res.end();
  });
  await assert.rejects(() => f.updater.check());
  const fake = async () =>
    new Response("too large", { headers: { "content-length": "1000000" } });
  await assert.rejects(() => packages.download(url, 5, fake), /too large/);
});

function installedFixture(t) {
  const f = fixture(t),
    root = path.join(f.root, "backend-root"),
    game = path.join(f.root, "game");
  const bridge = path.join(root, "backend/materiali-live");
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(path.join(game, "Archon/Binaries/Win64"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ GameDir: game }),
  );
  const recorder = path.join(root, "backend/recorder-1147.js"),
    dll = path.join(game, "Archon/Binaries/Win64/dxgi.dll");
  fs.writeFileSync(recorder, "old installed backend");
  fs.writeFileSync(dll, "old installed native");
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data/state.json"), "original player data");
  const manifest = {
    version: "0.11.3",
    files: [
      {
        file: "backend/recorder-1147.js",
        installedHash: packages.hash(fs.readFileSync(recorder)),
      },
    ],
    native: [{ file: dll, installedHash: packages.hash(fs.readFileSync(dll)) }],
  };
  fs.writeFileSync(path.join(bridge, "install.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(bridge, "existing.cjs"), "old bridge");
  t.mock.method(native, "assertGameClosed", () => {});
  t.mock.method(saves, "backendUp", async () => false);
  return {
    ...f,
    root,
    bridge,
    recorder,
    dll,
    connection: { root, version: "1.14.7" },
  };
}

test("Failed module replacement restores the exact previous DLL, backend and installed bridge; player save stays unchanged", async (t) => {
  const f = installedFixture(t);
  const before = [
    f.recorder,
    f.dll,
    path.join(f.bridge, "install.json"),
    path.join(f.bridge, "existing.cjs"),
  ].map((file) => [file, fs.readFileSync(file)]);
  const previousInstaller = {
    uninstall: async () => {
      fs.writeFileSync(f.recorder, "base backend");
      fs.rmSync(f.bridge, { recursive: true });
    },
  };
  const replacement = {
    install: async () => {
      fs.writeFileSync(f.recorder, "broken update");
      fs.writeFileSync(f.dll, "new DLL");
      fs.mkdirSync(f.bridge);
      fs.writeFileSync(path.join(f.bridge, "partial.cjs"), "partial");
      throw Error("simulated disk failure");
    },
  };
  await assert.rejects(
    () =>
      transactions.replaceInstalled(f.connection, replacement, {
        previousInstaller,
      }),
    /previous module was restored/,
  );
  for (const [file, bytes] of before)
    assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(f.bridge, "partial.cjs")), false);
  assert.equal(
    fs.readFileSync(path.join(f.root, "data/state.json"), "utf8"),
    "original player data",
  );
});

test("Running server and unrelated mod changes prevent update before any replacement", async (t) => {
  const f = installedFixture(t);
  let called = false;
  const replacement = {
    install: async () => {
      called = true;
    },
  };
  t.mock.method(saves, "backendUp", async () => true);
  await assert.rejects(
    () => transactions.replaceInstalled(f.connection, replacement),
    /Close the game/,
  );
  t.mock.method(saves, "backendUp", async () => false);
  fs.appendFileSync(f.recorder, "other mod");
  await assert.rejects(
    () => transactions.replaceInstalled(f.connection, replacement),
    /preserve/,
  );
  assert.equal(called, false);
});

test("Semantic version ordering compares numbers and refuses ambiguous values", () => {
  assert.equal(packages.compareVersions("0.12.10", "0.12.9"), 1);
  assert.equal(packages.compareVersions("0.12.0", "0.12.0"), 0);
  for (const value of [
    "latest",
    "v0.12.1",
    "0.12",
    "-1.0.0",
    "0.12.1-beta",
    "1000000.0.0",
  ])
    assert.throws(() => packages.compareVersions(value, "0.12.0"));
});

test("Automatic updates require one-time migration for old bridges and never downgrade newer installed modules", async (t) => {
  const f = fixture(t);
  t.mock.method(f.updater, "installer", () => ({
    version: "0.12.1",
    fingerprint: () => "new",
  }));
  let status = {
    installed: true,
    intact: true,
    version: "0.11.3",
    bridgeVerified: false,
  };
  t.mock.method(installed, "status", () => status);
  const migrated = await f.updater.apply(
    { root: f.root, version: "1.14.7" },
    { automatic: true },
  );
  assert.equal(migrated.updated, false);
  assert.match(migrated.message, /One-time setup/);
  status = {
    installed: true,
    intact: true,
    version: "0.13.0",
    bridgeVerified: true,
  };
  const newer = await f.updater.apply({ root: f.root, version: "1.14.7" });
  assert.match(newer.message, /downgrade refused/);
});

test("A running game prevents update before creating a transaction backup", async (t) => {
  const f = installedFixture(t);
  t.mock.method(native, "assertGameClosed", () => {
    throw Error("Close every Dauntless game");
  });
  await assert.rejects(
    () => transactions.replaceInstalled(f.connection, {}),
    /Close every/,
  );
  assert.equal(fs.existsSync(path.join(f.root, "backup")), false);
});

test("Version aliases and manifests with an incompatible package version are rejected", async (t) => {
  const f = fixture(t);
  for (const version of ["00.12.1", "0.012.1", "0.12.01"])
    assert.throws(() => packages.compareVersions(version, "0.12.0"));
  const entry = f.payload.files.find((file) => file.path === "package.json");
  const metadata = Buffer.from(JSON.stringify({ version: "0.12.2" }));
  entry.bytes = metadata.length;
  entry.sha256 = packages.hash(metadata);
  fs.writeFileSync(path.join(f.releaseFolder, "files/package.json"), metadata);
  packages.writeJson(path.join(f.releaseFolder, "release.json"), f.sign());
  await f.updater.importFolder(f.releaseFolder);
  assert.throws(() => f.updater.installer(), /does not match/);
});
