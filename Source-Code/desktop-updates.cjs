// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const manifest = require("./desktop-update-manifest.cjs");

const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
class DesktopUpdates {
  constructor({
    directory,
    config,
    currentVersion,
    currentExecutable,
    userData,
    helperSource,
    runtimeSource = path.resolve(
      path.dirname(helperSource),
      "../runtime/node.exe",
    ),
    fetcher = fetch,
    changed = () => {},
    allowLoopback = false,
  }) {
    this.directory = manifest.safeDirectory(directory);
    this.config = config;
    this.currentVersion = currentVersion;
    this.currentExecutable = currentExecutable;
    this.userData = userData;
    this.helperSource = helperSource;
    this.runtimeSource = runtimeSource;
    this.fetcher = fetcher;
    this.changed = changed;
    this.allowLoopback = allowLoopback;
    this.file = path.join(this.directory, "settings.json");
    this.state = {
      automaticDownload: true,
      applyOnNextStart: true,
      restartForLiveUpdates: true,
    };
    this.busy = false;
    this.progress = null;
    this.message = "Ready to check for application updates.";
    try {
      if (fs.existsSync(this.file))
        this.loadSettings(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      this.message =
        "Update settings could not be read. Save the settings again.";
    }
  }
  loadSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid application update settings.");
    for (const key of [
      "automaticDownload",
      "applyOnNextStart",
      "restartForLiveUpdates",
    ])
      if (typeof value[key] === "boolean") this.state[key] = value[key];
    for (const key of ["highest", "active", "ready"]) {
      if (!value[key]) continue;
      manifest.compareVersions(value[key].version, "0.0.0");
      if (!/^[a-f0-9]{64}$/.test(value[key].digest || ""))
        throw Error("Invalid cached application metadata.");
      this.state[key] = {
        version: value[key].version,
        digest: value[key].digest,
      };
    }
    if (typeof value.lastChecked === "string")
      this.state.lastChecked = value.lastChecked;
    if (
      value.requiredLiveVersion &&
      manifest.compareVersions(value.requiredLiveVersion, this.currentVersion) >
        0
    )
      this.state.requiredLiveVersion = value.requiredLiveVersion;
  }
  status() {
    return {
      currentVersion: this.currentVersion,
      availableVersion: this.state.ready?.version || null,
      automaticDownload: this.state.automaticDownload,
      applyOnNextStart: this.state.applyOnNextStart,
      restartForLiveUpdates: this.state.restartForLiveUpdates,
      requiredLiveVersion: this.state.requiredLiveVersion || null,
      ready:
        !!this.state.ready &&
        manifest.compareVersions(
          this.state.ready.version,
          this.currentVersion,
        ) > 0,
      busy: this.busy,
      progress: this.progress,
      message: this.message,
      lastChecked: this.state.lastChecked || null,
    };
  }
  emit() {
    this.changed(this.status());
  }
  persist() {
    manifest.writeJson(this.file, this.state);
  }
  settings(value) {
    if (
      !value ||
      typeof value.automaticDownload !== "boolean" ||
      typeof value.applyOnNextStart !== "boolean" ||
      (value.restartForLiveUpdates !== undefined &&
        typeof value.restartForLiveUpdates !== "boolean")
    )
      throw Error("Invalid application update preferences.");
    Object.assign(this.state, {
      automaticDownload: value.automaticDownload,
      applyOnNextStart: value.applyOnNextStart,
    });
    if (value.restartForLiveUpdates !== undefined)
      this.state.restartForLiveUpdates = value.restartForLiveUpdates;
    this.persist();
    this.emit();
    return this.status();
  }
  requireForLive(version) {
    if (manifest.compareVersions(version, this.currentVersion) <= 0) return;
    if (
      this.state.requiredLiveVersion &&
      manifest.compareVersions(version, this.state.requiredLiveVersion) <= 0
    )
      return;
    if (
      !this.state.requiredLiveVersion ||
      manifest.compareVersions(version, this.state.requiredLiveVersion) > 0
    )
      this.state.requiredLiveVersion = version;
    this.persist();
    this.emit();
  }
  canRestartForLive() {
    return !!(
      this.state.restartForLiveUpdates &&
      this.state.requiredLiveVersion &&
      this.state.ready &&
      !this.busy &&
      manifest.compareVersions(this.state.ready.version, this.currentVersion) >
        0 &&
      manifest.compareVersions(
        this.state.ready.version,
        this.state.requiredLiveVersion,
      ) >= 0 &&
      !this.failed(this.state.ready)
    );
  }
  decode(envelope) {
    return manifest.decodeManifest(
      envelope,
      this.config.publicKey,
      this.config.applicationRepository,
    );
  }
  folder(release) {
    return path.join(
      this.directory,
      "versions",
      release.version + "-" + release.digest,
    );
  }
  async cached(record) {
    if (
      !record ||
      typeof record.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.digest || "")
    )
      throw Error("Invalid cached application update.");
    manifest.compareVersions(record.version, "0.0.0");
    const folder = manifest.safeDirectory(this.folder(record));
    const file = path.join(folder, "release.json");
    if (!fs.lstatSync(file).isFile())
      throw Error("Unsafe application manifest.");
    const release = this.decode(JSON.parse(fs.readFileSync(file, "utf8")));
    if (release.version !== record.version || release.digest !== record.digest)
      throw Error("Cached application manifest changed.");
    const executable = path.join(folder, "DauntlessInventoryLive.exe");
    await manifest.verifyExecutable(executable, release);
    return { ...release, executable };
  }
  async response(url, { redirects = false, signal } = {}) {
    let current = manifest.checkedUrl(url, { loopback: this.allowLoopback });
    for (let count = 0; count < 6; count++) {
      const response = await this.fetcher(current.href, {
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!redirects)
          throw Error("Application update feed redirects are refused.");
        const next = manifest.checkedUrl(
          new URL(response.headers.get("location"), current).href,
          { loopback: this.allowLoopback },
        );
        if (
          !(this.allowLoopback && next.origin === current.origin) &&
          (!REDIRECT_HOSTS.has(next.hostname) || next.port)
        )
          throw Error("Untrusted application download redirect.");
        current = next;
        continue;
      }
      if (!response.ok)
        throw Error(
          "Application update download failed (HTTP " + response.status + ").",
        );
      return response;
    }
    throw Error("Too many application download redirects.");
  }
  async check() {
    if (!this.currentExecutable)
      throw Error("Open the portable EXE to manage application updates.");
    if (this.busy) return this.status();
    this.busy = true;
    this.progress = null;
    this.message = "Checking for application updates…";
    this.emit();
    let temporary;
    try {
      const response = await this.response(this.config.applicationFeedUrl, {
        signal: AbortSignal.timeout(15000),
      });
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 24000)
          throw Error("Application update manifest is too large.");
        chunks.push(chunk);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const release = this.decode(envelope);
      if (
        this.state.highest &&
        manifest.compareVersions(release.version, this.state.highest.version) <
          0
      )
        throw Error(
          "An older application release cannot replace the verified update.",
        );
      if (
        this.state.highest?.version === release.version &&
        this.state.highest.digest !== release.digest
      )
        throw Error(
          "A published application version cannot change its contents.",
        );
      this.state.highest = { version: release.version, digest: release.digest };
      this.state.lastChecked = new Date().toISOString();
      if (manifest.compareVersions(release.version, this.currentVersion) <= 0) {
        this.message = "The application is up to date.";
        this.persist();
        return this.status();
      }
      const folder = manifest.safeDirectory(this.folder(release));
      const executable = path.join(folder, "DauntlessInventoryLive.exe");
      let complete = false;
      if (fs.existsSync(executable)) {
        try {
          await manifest.verifyExecutable(executable, release);
          complete = true;
        } catch {
          if (!fs.lstatSync(executable).isFile())
            throw Error("Unsafe cached application file.");
          fs.renameSync(
            executable,
            path.join(
              folder,
              "quarantined-" + crypto.randomUUID() + ".disabled",
            ),
          );
        }
      }
      if (!complete) {
        this.message = "Downloading application " + release.version + "…";
        this.emit();
        temporary = path.join(folder, crypto.randomUUID() + ".part");
        const download = await this.response(release.url, {
          redirects: true,
          signal: AbortSignal.timeout(300000),
        });
        const handle = fs.openSync(temporary, "wx");
        let received = 0,
          lastProgress = -1;
        try {
          for await (const chunk of download.body) {
            received += chunk.length;
            if (received > release.bytes)
              throw Error("Application download exceeds its signed size.");
            fs.writeSync(handle, chunk);
            const progress = Math.floor((received * 100) / release.bytes);
            if (progress !== lastProgress) {
              this.progress = lastProgress = progress;
              this.emit();
            }
          }
        } finally {
          fs.closeSync(handle);
        }
        await manifest.verifyExecutable(temporary, release);
        fs.renameSync(temporary, executable);
        temporary = null;
      }
      manifest.writeJson(path.join(folder, "release.json"), envelope);
      this.state.ready = { version: release.version, digest: release.digest };
      this.persist();
      this.message =
        "Application " + release.version + " is ready. Restart to update.";
    } catch (error) {
      this.message = error.message;
      throw error;
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      this.busy = false;
      this.progress = null;
      this.emit();
    }
    return this.status();
  }
  async bootstrapTarget() {
    const candidates = [this.state.active];
    if (this.state.applyOnNextStart && this.state.ready)
      candidates.push(this.state.ready);
    candidates.sort((a, b) =>
      manifest.compareVersions(b?.version || "0.0.0", a?.version || "0.0.0"),
    );
    for (const record of candidates) {
      if (
        !record ||
        manifest.compareVersions(record.version, this.currentVersion) <= 0
      )
        continue;
      try {
        const release = await this.cached(record);
        if (this.failed(release)) {
          this.message =
            "The last update could not start. The previous version is available; use Restart and update to retry.";
          continue;
        }
        return release;
      } catch (error) {
        this.message = error.message;
        if (this.state.ready?.digest === record.digest) delete this.state.ready;
        if (this.state.active?.digest === record.digest)
          delete this.state.active;
        this.persist();
      }
    }
    return null;
  }
  failed(release) {
    return fs.existsSync(path.join(this.folder(release), "failed.json"));
  }
  async createHandoff(record = this.state.ready, servicePid = null) {
    if (this.busy)
      throw Error(
        "Wait for the application download to finish before restarting.",
      );
    if (!this.currentExecutable || !path.isAbsolute(this.currentExecutable))
      throw Error("Open the portable EXE to install application updates.");
    const release = await this.cached(record);
    if (manifest.compareVersions(release.version, this.currentVersion) <= 0)
      throw Error("No newer application update is ready.");
    const folder = manifest.safeDirectory(
      path.join(this.directory, "handoffs", crypto.randomUUID()),
    );
    const failed = path.join(this.folder(release), "failed.json");
    if (fs.existsSync(failed)) fs.unlinkSync(failed);
    const helper = path.join(folder, "restart.cjs");
    fs.copyFileSync(this.helperSource, helper, fs.constants.COPYFILE_EXCL);
    const job = {
      id: crypto.randomUUID(),
      parentPid: process.pid,
      servicePid,
      targetVersion: release.version,
      digest: release.digest,
      executable: release.executable,
      sha256: release.sha256,
      userData: this.userData,
      previousExecutable: this.currentExecutable,
      failedFile: path.join(this.folder(release), "failed.json"),
      reportFile: path.join(folder, "result.json"),
      ackFile: path.join(folder, "ack.json"),
      startedFile: path.join(folder, "started.json"),
      preparedFile: path.join(folder, "prepared.json"),
    };
    const file = path.join(folder, "job.json");
    manifest.writeJson(file, job);
    return { file, helper, job, release };
  }
  async launchHandoff(handoff) {
    const digest = await manifest.hashFile(this.runtimeSource);
    const runtimeFolder = manifest.safeDirectory(
      path.join(this.directory, "helper-runtimes", digest),
    );
    const runtime = path.join(runtimeFolder, "node.exe");
    if (!fs.existsSync(runtime))
      fs.copyFileSync(this.runtimeSource, runtime, fs.constants.COPYFILE_EXCL);
    if (
      !fs.lstatSync(runtime).isFile() ||
      fs.lstatSync(runtime).isSymbolicLink() ||
      (await manifest.hashFile(runtime)) !== digest
    )
      throw Error(
        "The application restart runtime changed. No update started.",
      );
    const logFile = path.join(path.dirname(handoff.file), "helper.log");
    const log = fs.openSync(logFile, "a");
    let child;
    try {
      child = spawn(runtime, [handoff.helper, handoff.file], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      fs.closeSync(log);
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timeout);
        child.unref();
        if (error) {
          child.kill();
          try {
            const detail = fs.readFileSync(logFile, "utf8").slice(-2000).trim();
            if (detail) error.message += " Helper details: " + detail;
          } catch {
            /* The error already explains the failed handoff. */
          }
          reject(error);
        } else resolve(child.pid);
      };
      const poll = setInterval(() => {
        try {
          const ready = JSON.parse(
            fs
              .readFileSync(handoff.job.preparedFile, "utf8")
              .replace(/^\uFEFF/, ""),
          );
          if (ready.id === handoff.job.id) finish();
        } catch {
          /* The helper may still be loading. */
        }
      }, 50);
      const timeout = setTimeout(
        () =>
          finish(
            Error(
              "The update helper did not become ready. The application remains open.",
            ),
          ),
        30000,
      );
      child.once("error", finish);
      child.once("exit", (code) =>
        finish(
          Error(
            `The update helper closed before becoming ready (${code}). The application remains open.`,
          ),
        ),
      );
    });
  }
  handoffJob(file) {
    if (!file || !path.isAbsolute(file)) return null;
    const folder = path.dirname(file),
      parent = path.join(this.directory, "handoffs");
    if (
      path.dirname(folder) !== parent ||
      !/^[a-f0-9-]{36}$/.test(path.basename(folder)) ||
      path.basename(file) !== "job.json"
    )
      throw Error("Invalid application restart request.");
    manifest.safeDirectory(folder);
    if (!fs.lstatSync(file).isFile())
      throw Error("Unsafe application restart request.");
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      job.targetVersion !== this.currentVersion ||
      !/^[a-f0-9-]{36}$/.test(job.id || "") ||
      !/^[a-f0-9]{64}$/.test(job.digest || "") ||
      job.userData !== this.userData ||
      job.executable !== this.currentExecutable ||
      job.executable !==
        path.join(
          this.folder({ version: job.targetVersion, digest: job.digest }),
          "DauntlessInventoryLive.exe",
        ) ||
      job.failedFile !==
        path.join(path.dirname(job.executable), "failed.json") ||
      job.ackFile !== path.join(folder, "ack.json") ||
      job.startedFile !== path.join(folder, "started.json")
    )
      throw Error("Application restart does not match this version.");
    return job;
  }
  async announceStart(file) {
    const job = this.handoffJob(file);
    if (job)
      manifest.writeJson(job.startedFile, {
        id: job.id,
        pid: process.pid,
        executable: process.execPath,
      });
  }
  async acknowledge(file) {
    const job = this.handoffJob(file);
    if (!job) return;
    const release = await this.cached({
      version: job.targetVersion,
      digest: job.digest,
    });
    if (
      release.version !== job.targetVersion ||
      release.executable !== this.currentExecutable ||
      release.sha256 !== job.sha256
    )
      throw Error(
        "Application update changed before its startup confirmation.",
      );
    this.state.active = { version: release.version, digest: release.digest };
    if (fs.existsSync(job.failedFile)) fs.unlinkSync(job.failedFile);
    this.persist();
    manifest.writeJson(job.ackFile, {
      id: job.id,
      version: this.currentVersion,
      pid: process.pid,
    });
  }
}
module.exports = { DesktopUpdates, REDIRECT_HOSTS };
