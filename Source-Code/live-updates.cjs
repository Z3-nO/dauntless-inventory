// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const packages = require("./live-update-package.cjs");
const transactions = require("./live-update-install.cjs");
const builtin = require("./live-install.cjs");

class LiveUpdates {
  constructor({
    directory,
    config,
    toolVersion,
    sourceRoot = __dirname,
    fetcher = fetch,
    repairSettleMs = 60000,
    now = Date.now,
  }) {
    this.directory = path.resolve(directory);
    this.config = config;
    this.toolVersion = toolVersion;
    this.sourceRoot = sourceRoot;
    this.fetcher = fetcher;
    this.repairSettleMs = repairSettleMs;
    this.now = now;
    this.repairObservations = new Map();
    this.requiredToolVersion = null;
    this.busy = false;
    this.message = "";
    this.results = {};
    fs.mkdirSync(this.directory, { recursive: true });
    this.file = path.join(this.directory, "settings.json");
    this.state = {
      feedUrl: config.feedUrl || "",
      automaticCheck: true,
      automaticInstall: true,
    };
    if (fs.existsSync(this.file)) {
      try {
        Object.assign(
          this.state,
          JSON.parse(fs.readFileSync(this.file, "utf8")),
        );
      } catch {
        this.message =
          "Update preferences could not be read. Save the update settings again.";
      }
    }
  }

  saveSettings(value) {
    if (
      typeof value.feedUrl !== "string" ||
      value.feedUrl.length > 2048 ||
      typeof value.automaticCheck !== "boolean" ||
      typeof value.automaticInstall !== "boolean"
    )
      throw Error("Invalid update settings.");
    if (value.feedUrl) packages.updateUrl(value.feedUrl);
    Object.assign(this.state, {
      feedUrl: value.feedUrl,
      automaticCheck: value.automaticCheck,
      automaticInstall: value.automaticInstall,
    });
    this.persist();
    return this.status();
  }

  persist() {
    packages.writeJson(this.file, this.state);
  }

  status() {
    return {
      feedUrl: this.state.feedUrl,
      automaticCheck: this.state.automaticCheck,
      automaticInstall: this.state.automaticInstall,
      configured: !!this.state.feedUrl,
      bundledVersion: this.toolVersion,
      downloadedVersion: this.state.latest?.version || null,
      lastChecked: this.state.lastChecked || null,
      busy: this.busy,
      message:
        this.message ||
        (this.state.feedUrl
          ? "Ready to check for Live module updates."
          : "Update source is not configured."),
      versions: this.results,
      requiredToolVersion: this.requiredToolVersion,
    };
  }

  destination(release) {
    packages.compareVersions(release.version, "0.0.0");
    if (
      typeof release.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(release.digest)
    )
      throw Error("Invalid cached update identity.");
    return path.join(
      this.directory,
      "cache",
      release.version + "-" + release.digest,
    );
  }

  accept(release, folder) {
    if (packages.compareVersions(release.version, this.toolVersion) < 0)
      throw Error("An older Live module cannot replace the bundled release.");
    const previous = this.state.latest;
    if (
      previous &&
      (packages.compareVersions(release.version, previous.version) < 0 ||
        (release.version === previous.version &&
          previous.digest !== release.digest))
    )
      throw Error("Live update rollback or a changed release was refused.");
    this.state.latest = { version: release.version, digest: release.digest };
    this.persist();
    this.message =
      "Live module " +
      release.version +
      " downloaded and verified. Installation waits for the game and server to close.";
    return folder;
  }

  async check() {
    if (this.busy)
      throw Error("A Live update operation is already in progress.");
    if (!this.state.feedUrl) {
      this.message = "Update source is not configured.";
      return this.status();
    }
    this.busy = true;
    let stage;
    try {
      const feed = packages.updateUrl(this.state.feedUrl);
      const envelope = JSON.parse(
        (await packages.download(feed.href, 180000, this.fetcher)).toString(
          "utf8",
        ),
      );
      const release = packages.decodeRelease(
        envelope,
        this.config.publicKey,
        this.toolVersion,
      );
      const existing = this.destination(release);
      if (fs.existsSync(existing)) {
        packages.verifyDirectory(
          existing,
          this.config.publicKey,
          this.toolVersion,
        );
        this.accept(release, existing);
      } else {
        if (
          typeof release.assetPath !== "string" ||
          !/^releases\/[0-9.]+\/$/.test(release.assetPath)
        )
          throw Error("Invalid update asset location.");
        const base = new URL(release.assetPath, feed);
        if (base.origin !== feed.origin)
          throw Error("Update files must use the signed feed's origin.");
        stage = path.join(this.directory, "staging-" + crypto.randomUUID());
        fs.mkdirSync(path.join(stage, "files"), { recursive: true });
        packages.writeJson(path.join(stage, "release.json"), envelope);
        let cursor = 0;
        const workers = Array.from(
          { length: Math.min(3, release.files.length) },
          async () => {
            try {
              while (cursor < release.files.length) {
                const entry = release.files[cursor++];
                const url = new URL("files/" + entry.path, base);
                const bytes = await packages.download(
                  url.href,
                  entry.bytes,
                  this.fetcher,
                );
                if (
                  bytes.length !== entry.bytes ||
                  packages.hash(bytes) !== entry.sha256
                )
                  throw Error(
                    "Downloaded Live file failed verification: " + entry.path,
                  );
                const destination = packages.checkedPath(
                  path.join(stage, "files"),
                  entry.path,
                );
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, bytes, { flag: "wx" });
              }
            } catch (error) {
              cursor = release.files.length;
              throw error;
            }
          },
        );
        const completed = await Promise.allSettled(workers);
        const failure = completed.find(
          (result) => result.status === "rejected",
        );
        if (failure) throw failure.reason;
        packages.verifyDirectory(
          stage,
          this.config.publicKey,
          this.toolVersion,
        );
        fs.mkdirSync(path.dirname(existing), { recursive: true });
        fs.renameSync(stage, existing);
        stage = null;
        this.accept(release, existing);
      }
      this.state.lastChecked = new Date().toISOString();
      this.requiredToolVersion = null;
      this.persist();
    } catch (error) {
      if (error.code === "LIVE_APPLICATION_UPDATE_REQUIRED")
        this.requiredToolVersion = error.requiredToolVersion;
      this.message = error.message;
      throw error;
    } finally {
      // Staging is created by this invocation inside the updater's own folder.
      if (
        stage &&
        path.dirname(stage) === this.directory &&
        fs.existsSync(stage)
      )
        fs.rmSync(stage, { recursive: true });
      this.busy = false;
    }
    return this.status();
  }

  async importFolder(folder) {
    if (this.busy)
      throw Error("A Live update operation is already in progress.");
    this.busy = true;
    let stage;
    try {
      const release = packages.verifyDirectory(
        folder,
        this.config.publicKey,
        this.toolVersion,
      );
      const destination = this.destination(release);
      if (!fs.existsSync(destination)) {
        stage = path.join(this.directory, "staging-" + crypto.randomUUID());
        fs.mkdirSync(path.join(stage, "files"), { recursive: true });
        fs.copyFileSync(
          path.join(folder, "release.json"),
          path.join(stage, "release.json"),
        );
        for (const entry of release.files) {
          const target = packages.checkedPath(
            path.join(stage, "files"),
            entry.path,
          );
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(folder, "files", entry.path), target);
        }
        packages.verifyDirectory(
          stage,
          this.config.publicKey,
          this.toolVersion,
        );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(stage, destination);
        stage = null;
      }
      packages.verifyDirectory(
        destination,
        this.config.publicKey,
        this.toolVersion,
      );
      this.accept(release, destination);
      return this.status();
    } finally {
      if (
        stage &&
        path.dirname(stage) === this.directory &&
        fs.existsSync(stage)
      )
        fs.rmSync(stage, { recursive: true });
      this.busy = false;
    }
  }

  installer() {
    if (!this.state.latest) return builtin;
    const folder = this.destination(this.state.latest);
    const release = packages.verifyDirectory(
      folder,
      this.config.publicKey,
      this.toolVersion,
    );
    if (release.digest !== this.state.latest.digest)
      throw Error("Cached update identity changed.");
    if (packages.compareVersions(release.version, this.toolVersion) < 0)
      return builtin;
    // Only complete, publisher-signed and reverified code reaches the installer.
    const metadata = JSON.parse(
      fs.readFileSync(path.join(folder, "files/package.json"), "utf8"),
    );
    if (metadata.version !== release.version)
      throw Error("Update package version does not match its signed manifest.");
    const installer = require(path.join(folder, "files/live-install.cjs"));
    if (
      installer.version !== release.version ||
      typeof installer.fingerprint !== "function" ||
      typeof installer.install !== "function"
    )
      throw Error("Invalid signed Live installer interface.");
    return installer;
  }

  async apply(connection, { install = false, automatic = false } = {}) {
    if (this.busy)
      throw Error("A Live update operation is already in progress.");
    this.busy = true;
    const failureKey = packages.hash(
      Buffer.from(path.resolve(connection.root)),
    );
    let targetFingerprint;
    try {
      const replacement = this.installer();
      targetFingerprint = replacement.fingerprint();
      const failed = this.state.failures?.[failureKey];
      if (
        automatic &&
        failed?.fingerprint === targetFingerprint &&
        Date.now() - failed.time < 30 * 60 * 1000
      )
        return {
          updated: false,
          message:
            "The previous module was restored after a failed update. Automatic retry is deferred; use Update installed Live module to retry now.",
        };
      const status = builtin.status(connection);
      this.rememberInstallation(connection, status);
      const recorded = this.state.managed?.[failureKey];
      const recovering = !status.intact && (status.installed || recorded);
      if (
        automatic &&
        recovering &&
        !this.repairSettled(connection, failureKey)
      ) {
        const result = {
          ...status,
          updated: false,
          message:
            "Forever files changed. Waiting for its update to finish and the game/server to close before restoring Live.",
        };
        this.results[connection.version] = { message: result.message };
        return result;
      }
      if (!status.installed) {
        if (automatic && recorded) {
          const result = await transactions.replaceInstalled(
            connection,
            replacement,
            { recoveryManifest: recorded.manifest },
          );
          this.rememberInstallation(connection, builtin.status(connection));
          this.results[connection.version] = {
            version: result.version,
            message: result.message,
          };
          return result;
        }
        if (!install)
          return { updated: false, message: "Install Live connection first." };
        await transactions.assertClosed(connection);
        const result = await replacement.install({
          ...connection,
          nativeRefresh: true,
        });
        this.rememberInstallation(connection, builtin.status(connection));
        return result;
      }
      if (packages.compareVersions(status.version, replacement.version) > 0)
        return {
          ...status,
          updated: false,
          message:
            "A newer Live module is already installed; downgrade refused.",
        };
      if (automatic && !status.bridgeVerified) {
        const result = {
          ...status,
          updated: false,
          message:
            "One-time setup: use Update installed Live module to enable verified automatic updates for this older installation.",
        };
        this.results[connection.version] = { message: result.message };
        return result;
      }
      if (status.intact && status.moduleFingerprint === targetFingerprint)
        return {
          ...status,
          updated: false,
          message: "The installed Live module is up to date.",
        };
      const result = await transactions.replaceInstalled(
        connection,
        replacement,
      );
      this.rememberInstallation(connection, builtin.status(connection));
      if (this.state.failures?.[failureKey]) {
        delete this.state.failures[failureKey];
        this.persist();
      }
      this.results[connection.version] = {
        version: result.version,
        message: result.message,
      };
      return result;
    } catch (error) {
      if (
        automatic &&
        /previous module was restored|manual recovery/.test(error.message)
      ) {
        this.state.failures ||= {};
        this.state.failures[failureKey] = {
          fingerprint: targetFingerprint,
          time: Date.now(),
        };
        this.persist();
      }
      this.results[connection.version] = { message: error.message };
      throw error;
    } finally {
      this.busy = false;
    }
  }

  wasManaged(connection) {
    const key = packages.hash(Buffer.from(path.resolve(connection.root)));
    const entry = this.state.managed?.[key];
    return (
      !!entry &&
      entry.root === path.resolve(connection.root) &&
      entry.version === connection.version
    );
  }
  forgetInstallation(connection) {
    const key = packages.hash(Buffer.from(path.resolve(connection.root)));
    if (this.state.managed) delete this.state.managed[key];
    this.repairObservations.delete(key);
    this.persist();
  }

  rememberInstallation(connection, status) {
    if (!status.installed || !status.bridgeVerified) return;
    const file = path.join(
      connection.root,
      "backend/materiali-live/install.json",
    );
    if (!fs.existsSync(file)) return;
    const root = path.resolve(connection.root);
    const key = packages.hash(Buffer.from(root));
    const record = {
      root,
      version: connection.version,
      manifest: JSON.parse(fs.readFileSync(file, "utf8")),
    };
    if (JSON.stringify(this.state.managed?.[key]) === JSON.stringify(record))
      return;
    this.state.managed ||= {};
    this.state.managed[key] = record;
    this.persist();
  }

  repairSettled(connection, key) {
    const files = [
      ...transactions.targets(connection),
      path.join(connection.root, "config.json"),
      path.join(connection.root, "backend/materiali-live/install.json"),
    ];
    const fingerprint = packages.hash(
      Buffer.from(
        JSON.stringify(
          files.map((file) => [
            file,
            fs.existsSync(file) ? packages.hash(fs.readFileSync(file)) : null,
          ]),
        ),
      ),
    );
    const previous = this.repairObservations.get(key),
      now = this.now();
    if (!previous || previous.fingerprint !== fingerprint) {
      this.repairObservations.set(key, { fingerprint, time: now });
      return false;
    }
    return now - previous.time >= this.repairSettleMs;
  }
}

module.exports = { LiveUpdates };
