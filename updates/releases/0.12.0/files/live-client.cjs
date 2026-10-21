// SPDX-License-Identifier: AGPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
async function call(connection, action, request) {
  const keyFile = path.join(connection.root, "data/materiali-live.key");
  if (!fs.existsSync(keyFile))
    throw Error(
      "Install Live connection in Settings, then restart Forever once.",
    );
  const key = fs.readFileSync(keyFile, "utf8").trim();
  const identity = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        path.resolve(connection.root).toLowerCase(),
        connection.version,
      ]),
    )
    .digest("hex");
  const port = connection.version === "1.6.2" ? 61000 : 63000;
  let response;
  try {
    response = await fetch("http://127.0.0.1:" + port + "/_materiali/live/v1", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        "X-Materiali-Live-Key": key,
      },
      body: JSON.stringify({ identity, action, request }),
    });
  } catch (e) {
    throw Error(
      "Live server unavailable. Start Forever with the Live connection installed. Reconnect before retrying.",
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error(
      "The running Forever server does not support Live connection. Restart it after installation.",
    );
  }
  if (!response.ok)
    throw Error(result.error || "Live server rejected the request.");
  return result;
}
module.exports = { call };
