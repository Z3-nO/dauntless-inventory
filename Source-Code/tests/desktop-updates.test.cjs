// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { DesktopUpdates } = require("../desktop-updates.cjs");
const manifest = require("../desktop-update-manifest.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-app-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const bytes = Buffer.from("MZverified-fixture");
  const payload = {
    schema: 1,
    kind: "inventory-desktop",
    channel: "stable",
    platform: "win32-x64",
    version: "0.13.0",
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    url: "https://github.com/owner/inventory/releases/download/v0.13.0/DauntlessInventoryLive-0.13.0.exe",
    sourceUrl: "https://github.com/owner/inventory/tree/v0.13.0",
  };
  const sign = (data = payload) => {
    const value = Buffer.from(JSON.stringify(data));
    return {
      payload: value.toString("base64url"),
      signature: crypto
        .sign(null, value, keys.privateKey)
        .toString("base64url"),
    };
  };
  let latest = sign(),
    contents = bytes,
    downloads = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith("latest.json"))
      return new Response(JSON.stringify(latest));
    downloads++;
    return new Response(contents);
  };
  const options = {
    directory: path.join(root, "application-updates"),
    config: {
      publicKey,
      applicationRepository: "owner/inventory",
      applicationFeedUrl: "https://example.org/latest.json",
    },
    currentVersion: "0.12.99",
    currentExecutable: path.join(root, "original.exe"),
    userData: root,
    helperSource: path.join(__dirname, "../scripts/restart-application.ps1"),
    fetcher,
  };
  const updater = new DesktopUpdates(options);
  return {
    root,
    keys,
    publicKey,
    bytes,
    payload,
    sign,
    options,
    updater,
    downloads: () => downloads,
    setFeed: (value) => (latest = value),
    setBytes: (value) => (contents = value),
  };
}

test("Application manifests authenticate the exact EXE, platform, release repository and source tag", (t) => {
  const f = fixture(t);
  assert.equal(f.updater.decode(f.sign()).version, "0.13.0");
  const wrong = crypto
    .generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" });
  assert.throws(
    () => manifest.decodeManifest(f.sign(), wrong, "owner/inventory"),
    /signature/,
  );
  const changed = f.sign();
  changed.payload = Buffer.from("{}").toString("base64url");
  assert.throws(() => f.updater.decode(changed), /signature/);
  for (const change of [
    { version: "00.13.0" },
    { platform: "linux" },
    { bytes: manifest.MAX_EXE + 1 },
    { sha256: "invalid" },
    { url: "https://example.org/app.exe" },
    { url: f.payload.url + "?token=secret" },
    { sourceUrl: "https://example.org/source" },
    { kind: "inventory-live" },
  ])
    assert.throws(() => f.updater.decode(f.sign({ ...f.payload, ...change })));
});
test("Application downloads are cached and verified again before a restart or original-EXE bootstrap", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  assert.equal(f.updater.status().ready, true);
  assert.equal(f.downloads(), 1);
  await f.updater.check();
  assert.equal(f.downloads(), 1);
  const next = new DesktopUpdates(f.options);
  const release = await next.bootstrapTarget();
  assert.equal(release.version, "0.13.0");
  fs.appendFileSync(release.executable, "changed");
  await assert.rejects(() => next.createHandoff(), /size|integrity/);
  assert.equal(await next.bootstrapTarget(), null);
});
test("Corrupt and interrupted application downloads never become executable update candidates", async (t) => {
  const f = fixture(t);
  f.setBytes(Buffer.from("MZbad"));
  await assert.rejects(() => f.updater.check(), /size/);
  assert.equal(f.updater.status().ready, false);
  assert(
    !fs
      .readdirSync(f.updater.folder(f.updater.decode(f.sign())))
      .some((name) => name.endsWith(".part")),
  );
  f.updater.fetcher = async (url) =>
    String(url).endsWith("latest.json")
      ? new Response(JSON.stringify(f.sign()))
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("MZ"));
              controller.error(Error("connection lost"));
            },
          }),
        );
  await assert.rejects(() => f.updater.check(), /connection lost/);
  assert.equal(f.updater.state.ready, undefined);
});

test("A corrupted completed cache is quarantined and downloaded again without touching the original EXE", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.options.currentExecutable, "original");
  await f.updater.check();
  const target = await f.updater.cached(f.updater.state.ready);
  fs.appendFileSync(target.executable, "corrupt");
  await f.updater.check();
  assert.equal(f.downloads(), 2);
  await f.updater.cached(f.updater.state.ready);
  assert.equal(
    fs.readFileSync(f.options.currentExecutable, "utf8"),
    "original",
  );
  assert(
    fs
      .readdirSync(path.dirname(target.executable))
      .some((name) => name.endsWith(".disabled")),
  );
});

test("The application publisher uses the existing trust key and refuses changed published versions", async (t) => {
  const f = fixture(t),
    source = path.join(f.root, "source"),
    output = path.join(f.root, "published");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ version: "0.13.0" }),
  );
  fs.writeFileSync(
    path.join(source, "update-channel.json"),
    JSON.stringify(f.options.config),
  );
  const executable = path.join(f.root, "release.exe"),
    privateKeyFile = path.join(f.root, "test.pem");
  fs.writeFileSync(executable, f.bytes);
  fs.writeFileSync(
    privateKeyFile,
    f.keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const { publish } = require("../scripts/publish-application-update.cjs");
  assert.equal(
    (await publish({ source, output, executable, privateKeyFile })).version,
    "0.13.0",
  );
  const published = JSON.parse(
    fs.readFileSync(path.join(output, "latest.json")),
  );
  assert.equal(f.updater.decode(published).sha256, f.payload.sha256);
  await assert.rejects(
    () => publish({ source, output, executable, privateKeyFile }),
    /already exists/,
  );
  fs.writeFileSync(
    privateKeyFile,
    crypto
      .generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await assert.rejects(
    () => publish({ source, output, executable, privateKeyFile }),
    /does not match/,
  );
});
test("A failed later download preserves the previous completed application and rejects release downgrades", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  const previous = f.updater.state.ready;
  f.setFeed(
    f.sign({
      ...f.payload,
      version: "0.13.1",
      url: f.payload.url.replaceAll("0.13.0", "0.13.1"),
      sourceUrl: f.payload.sourceUrl.replace("0.13.0", "0.13.1"),
    }),
  );
  f.setBytes(Buffer.from("wrong"));
  await assert.rejects(() => f.updater.check());
  assert.deepEqual(f.updater.state.ready, previous);
  f.setFeed(
    f.sign({
      ...f.payload,
      version: "0.12.0",
      url: f.payload.url.replaceAll("0.13.0", "0.12.0"),
      sourceUrl: f.payload.sourceUrl.replace("0.13.0", "0.12.0"),
    }),
  );
  await assert.rejects(() => f.updater.check(), /older/);
});
test("A published application version cannot be replaced by different signed bytes", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  f.setFeed(f.sign({ ...f.payload, sha256: "a".repeat(64) }));
  await assert.rejects(() => f.updater.check(), /cannot change/);
});
test("Application update settings persist and automatic opening can be disabled", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  f.updater.settings({ automaticDownload: false, applyOnNextStart: false });
  const next = new DesktopUpdates(f.options);
  assert.equal(next.status().automaticDownload, false);
  assert.equal(await next.bootstrapTarget(), null);
  assert.throws(
    () => next.settings({ automaticDownload: "yes", applyOnNextStart: true }),
    /preferences/,
  );
  const handoff = await next.createHandoff();
  assert.equal(handoff.job.targetVersion, "0.13.0");
  assert.equal(handoff.job.previousExecutable, f.options.currentExecutable);
  assert(!Object.keys(handoff.job).some((key) => /game|save|dll/i.test(key)));
});
test("The new app only activates after its own verified startup; failed releases do not loop", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  let handoff = await f.updater.createHandoff();
  fs.writeFileSync(handoff.job.failedFile, "{}");
  assert.equal(await f.updater.bootstrapTarget(), null);
  const options = {
    ...f.options,
    currentVersion: "0.13.0",
    currentExecutable: handoff.job.executable,
  };
  const next = new DesktopUpdates(options);
  await next.announceStart(handoff.file);
  assert.equal(
    JSON.parse(fs.readFileSync(handoff.job.startedFile)).pid,
    process.pid,
  );
  await next.acknowledge(handoff.file);
  assert.equal(next.state.active.version, "0.13.0");
  assert.equal(
    JSON.parse(fs.readFileSync(handoff.job.ackFile)).id,
    handoff.job.id,
  );
  const tampered = JSON.parse(fs.readFileSync(handoff.file));
  tampered.ackFile = path.join(f.root, "outside.json");
  fs.writeFileSync(handoff.file, JSON.stringify(tampered));
  await assert.rejects(() => next.acknowledge(handoff.file), /does not match/);
  await assert.rejects(
    () => next.acknowledge(path.join(f.root, "job.json")),
    /Invalid/,
  );
});
test("Update-cache directory links and linked executable files are refused", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  const release = await f.updater.cached(f.updater.state.ready);
  const external = path.join(f.root, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "DauntlessInventoryLive.exe"), f.bytes);
  const folder = path.dirname(release.executable);
  fs.renameSync(folder, folder + "-old");
  fs.symlinkSync(external, folder, "junction");
  await assert.rejects(() => f.updater.cached(f.updater.state.ready), /links/);
});

test("An already active version can still confirm startup when a newer pending release failed", async (t) => {
  const f = fixture(t);
  await f.updater.check();
  const previous = { ...f.updater.state.ready };
  f.setFeed(
    f.sign({
      ...f.payload,
      version: "0.13.1",
      url: f.payload.url.replaceAll("0.13.0", "0.13.1"),
      sourceUrl: f.payload.sourceUrl.replace("0.13.0", "0.13.1"),
    }),
  );
  await f.updater.check();
  const pending = await f.updater.cached(f.updater.state.ready);
  fs.writeFileSync(
    path.join(path.dirname(pending.executable), "failed.json"),
    "{}",
  );
  f.updater.state.active = previous;
  f.updater.persist();
  const active = await f.updater.bootstrapTarget();
  assert.equal(active.version, "0.13.0");
  const handoff = await f.updater.createHandoff(previous);
  const next = new DesktopUpdates({
    ...f.options,
    currentVersion: "0.13.0",
    currentExecutable: active.executable,
  });
  await next.acknowledge(handoff.file);
  assert.equal(next.state.active.version, "0.13.0");
  assert.equal(next.state.ready.version, "0.13.1");
});
test("GitHub asset redirects are allowed only to known HTTPS release hosts", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.updater.fetcher = async () =>
    ++calls === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/asset?signature=public",
          },
        })
      : new Response(f.bytes);
  assert.equal(
    (await f.updater.response(f.payload.url, { redirects: true })).status,
    200,
  );
  for (const location of [
    "http://release-assets.githubusercontent.com/asset",
    "https://attacker.example/app.exe",
    "https://github.com:1234/asset",
  ]) {
    f.updater.fetcher = async () =>
      new Response(null, { status: 302, headers: { location } });
    await assert.rejects(() =>
      f.updater.response(f.payload.url, { redirects: true }),
    );
  }
  f.updater.fetcher = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://github.com/asset" },
    });
  await assert.rejects(
    () => f.updater.response("https://example.org/latest.json"),
    /feed redirects/,
  );
});
test("An actual HTTP stream is bounded by its signed length and handles a truncated connection", async (t) => {
  const f = fixture(t);
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end(f.bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/exe";
  f.updater.allowLoopback = true;
  f.updater.fetcher = (requested, options) =>
    String(requested).endsWith("latest.json")
      ? Promise.resolve(new Response(JSON.stringify(f.sign())))
      : fetch(url, options);
  await f.updater.check();
  assert.equal(f.updater.status().ready, true);
});
test("The desktop service pauses new writes before acknowledging an application restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-quiesce-"));
  const child = fork(path.join(__dirname, "../server.cjs"), [], {
    env: { ...process.env, MATERIALI_USER_DATA: root },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Service start timed out")),
      15000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(
        /Local service ready: (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const html = await (await fetch(url)).text(),
    token = html.match(/name="tool-token" content="([^"]+)"/)[1];
  const api = (route, body) =>
    fetch(url + "/api/" + route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tool-token": token },
      body: JSON.stringify({ version: "1.6.2", ...body }),
    });
  const ready = once(child, "message");
  child.send({ type: "prepare-app-update", id: "test-restart" });
  assert.deepEqual((await ready)[0], {
    type: "app-update-ready",
    id: "test-restart",
  });
  const paused = await api("settings", { dataRoot: "", gameDir: "" });
  assert.equal(paused.status, 400);
  assert.match((await paused.json()).error, /restarting/);
  assert.equal((await api("live-update-status", {})).status, 200);
  child.send({ type: "cancel-app-update" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await api("settings", { dataRoot: "", gameDir: "" })).status,
    200,
  );
});
