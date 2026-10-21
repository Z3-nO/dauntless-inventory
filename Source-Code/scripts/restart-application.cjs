// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
// This helper runs outside the portable extraction directory. Its own copied
// runtime keeps it independent of Electron's process and console lifetime.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const file = process.argv[2];
const job = JSON.parse(fs.readFileSync(file, "utf8"));
const write = (target, value) =>
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
const report = (state, message) =>
  write(job.reportFile, { state, message, version: job.targetVersion });
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function waitForPrevious() {
  const deadline = Date.now() + 90000;
  while (alive(job.parentPid) || alive(job.servicePid)) {
    if (Date.now() >= deadline)
      throw Error("The previous editor did not close. No update started.");
    await delay(100);
  }
}
function start(executable, updating) {
  const env = { ...process.env, MATERIALI_USER_DATA: job.userData };
  delete env.DAUNTLESS_UPDATE_JOB;
  if (updating) env.DAUNTLESS_UPDATE_JOB = file;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child);
    });
  });
}
async function hashFile(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}
async function main() {
  let next;
  let nextExited = false;
  try {
    write(job.preparedFile, { id: job.id, pid: process.pid });
    await waitForPrevious();
    if ((await hashFile(job.executable)) !== job.sha256)
      throw Error("The downloaded application changed. No update started.");
    next = await start(job.executable, true);
    next.once("exit", () => {
      nextExited = true;
    });
    report("starting", "Waiting for the updated application.");
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        const ack = JSON.parse(fs.readFileSync(job.ackFile, "utf8"));
        if (ack.id === job.id && ack.version === job.targetVersion) {
          report("complete", "The updated application started successfully.");
          return;
        }
      } catch {
        /* Startup may not have written the acknowledgement yet. */
      }
      if (nextExited)
        throw Error(
          "The downloaded application closed before confirming startup.",
        );
      await delay(250);
    }
    throw Error(
      "Startup confirmation timed out. The previous version remains available.",
    );
  } catch (error) {
    write(job.failedFile, {
      message: error.message,
      time: new Date().toISOString(),
    });
    report("failed", error.message);
    // Do not kill an unusually slow application or an unrelated game session.
    if (!next || nextExited) await start(job.previousExecutable, false);
    process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
