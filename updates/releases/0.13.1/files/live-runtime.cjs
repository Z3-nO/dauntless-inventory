// SPDX-License-Identifier: AGPL-3.0-only
// Runs inside the native backend. Writes use its current state and transaction boundary.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const saves = require("./saves.cjs");
const native = require("./live-native.cjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
const hash = (x) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const message =
  "Saved with a backup. Native Live refreshes inventory and imported builds in the current local session. Reopen Equipment if its screen is already open. Delivery and native application are reported separately.";

function create(adapter) {
  let activeCharacter = null;
  const startedAt = Date.now();
  function settleBuilds() {
    let changed = false;
    for (const receipt of adapter.receipts()) {
      if (
        receipt.slot !== null &&
        !receipt.nativeApplied &&
        native.buildApplied(adapter, receipt)
      ) {
        receipt.nativeApplied = true;
        receipt.nativeAppliedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) adapter.saveReceipts();
  }
  const key = fs
    .readFileSync(path.join(adapter.root, "data/materiali-live.key"), "utf8")
    .trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid live bridge key.");
  const identity = hash([
    path.resolve(adapter.root).toLowerCase(),
    adapter.version,
  ]);
  function snapshot() {
    settleBuilds();
    const rows = adapter.characters();
    const heartbeat = native.heartbeat(adapter);
    return {
      characters: rows.map(saves.summarize),
      revision: hash(rows),
      live: true,
      activeCharacter,
      gameCharacter:
        heartbeat.available && rows.some((row) => row.id === activeCharacter)
          ? activeCharacter
          : null,
      sessionId: hash([startedAt, heartbeat.sessionId]),
      nativeRefresh: heartbeat,
      delivery: adapter.receipts().map((receipt) => ({
        id: receipt.id,
        character: receipt.character,
        slot: receipt.slot,
        inventorySent: receipt.inventorySent,
        loadoutSent: receipt.loadoutSent,
        backup: receipt.backup,
        buildApplied: native.buildApplied(adapter, receipt),
      })),
      message,
    };
  }
  function apply(request) {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.id || ""))
      throw Error("Invalid live operation ID.");
    const old = adapter.receipts().find((x) => x.id === request.id);
    if (old) {
      if (old.requestHash !== hash(request))
        throw Error("Operation ID was reused with different data.");
      let refresh;
      try {
        refresh = native.signal(adapter, old.id, old.slot);
      } catch (e) {
        refresh = { queued: false, reason: e.message };
      }
      return {
        ...snapshot(),
        backup: old.backup,
        operationId: old.id,
        refresh,
        message,
      };
    }
    const prepared = saves.prepareRequest(request, adapter.version);
    settleBuilds();
    if (prepared.plan && !native.heartbeat(adapter).builds)
      throw Error(
        "Live build import is not supported without the current native Live extension and one connected local player.",
      );
    if (
      activeCharacter &&
      native.heartbeat(adapter).available &&
      request.character !== activeCharacter
    )
      throw Error(
        "Select the character currently connected to this local game.",
      );
    if (
      adapter
        .receipts()
        .some((p) => p.slot !== null && !native.buildApplied(adapter, p))
    )
      throw Error(
        "A build is still being applied. Wait for its native acknowledgement, or close the game before importing another build.",
      );
    if (prepared.reset || prepared.restore || prepared.addSlots)
      throw Error(
        "Reset, restore and adding slots require the game and server to be closed.",
      );
    if (snapshot().revision !== request.revision)
      throw Error(
        "The character changed in game. Refresh the current data and review your changes again.",
      );
    const target = adapter.characters().find((x) => x.id === request.character);
    if (!target) throw Error("Character does not belong to this server.");
    const result = saves.transform(target, prepared, adapter.version);
    const changed = (before, after, keyName) =>
      after.filter(
        (x) =>
          JSON.stringify(x) !==
          JSON.stringify(before.find((b) => b[keyName] === x[keyName])),
      );
    const receipt = {
      id: request.id,
      requestHash: hash(request),
      character: target.id,
      slot: prepared.plan ? prepared.slot : null,
      inventorySent: false,
      loadoutSent: !prepared.plan,
      stackIds: [
        ...new Set(
          [...target.inv.stackedItems, ...result.inv.stackedItems].map(
            (x) => x.catalogId,
          ),
        ),
      ].filter(
        (id) =>
          hash(target.inv.stackedItems.filter((x) => x.catalogId === id)) !==
          hash(result.inv.stackedItems.filter((x) => x.catalogId === id)),
      ),
      newIds: result.inv.instancedItems
        .filter(
          (x) =>
            !target.inv.instancedItems.some(
              (b) => b.instanceId === x.instanceId,
            ),
        )
        .map((x) => x.instanceId),
      updatedIds: changed(
        target.inv.instancedItems,
        result.inv.instancedItems,
        "instanceId",
      )
        .filter((x) =>
          target.inv.instancedItems.some((b) => b.instanceId === x.instanceId),
        )
        .map((x) => x.instanceId),
      removed: target.inv.instancedItems.filter(
        (x) =>
          !result.inv.instancedItems.some((a) => a.instanceId === x.instanceId),
      ),
      createdAt: new Date().toISOString(),
    };
    adapter.commit(target, result, receipt);
    let refresh;
    try {
      refresh = native.signal(adapter, receipt.id, receipt.slot);
    } catch (e) {
      refresh = { queued: false, reason: e.message };
    }
    return {
      ...snapshot(),
      backup: receipt.backup,
      operationId: receipt.id,
      refresh,
      message,
    };
  }
  function authorized(req) {
    const address = String(req.socket?.remoteAddress || "").replace(
      /^::ffff:/,
      "",
    );
    const offered = req.headers["x-materiali-live-key"];
    return (
      ["127.0.0.1", "::1"].includes(address) &&
      !req.headers.origin &&
      /^127\.0\.0\.1:\d+$/.test(req.headers.host || "") &&
      typeof offered === "string" &&
      /^[a-f0-9]{64}$/.test(offered) &&
      crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(key))
    );
  }
  function admin(req, body) {
    if (!authorized(req))
      return {
        status: 403,
        json: { error: "Local authenticated connection required." },
      };
    try {
      if (req.method !== "POST") throw Error("POST required.");
      if (body?.identity !== identity)
        throw Error("The running server belongs to another save folder.");
      if (body.action === "snapshot") return { status: 200, json: snapshot() };
      if (body.action === "build-export")
        return {
          status: 200,
          json: require("./build-export.cjs").exportPreset(
            adapter.characters(),
            body.request,
            adapter.version,
          ),
        };
      if (body.action === "apply")
        return { status: 200, json: apply(body.request) };
      throw Error("Unknown live operation.");
    } catch (e) {
      return { status: 409, json: { error: e.message } };
    }
  }
  // Native transaction responses contain absolute quantities and stable instance IDs.
  // Merge the imported changes into that established delivery mechanism.
  function decorate(character, method, pathname, json) {
    const full =
      method === "GET" && /^\/inventory\/[^/]+\/[^/]+\/?$/.test(pathname);
    if (full) activeCharacter = character;
    const pending = adapter.receipts().filter((x) => x.character === character);
    if (!pending.length || !json || typeof json !== "object") return json;
    const target = adapter.characters().find((x) => x.id === character);
    if (!target) return json;
    let changed = false;
    const transaction =
      method === "POST" &&
      /^\/inventory\/?$/.test(pathname) &&
      Array.isArray(json.updatedStackedItems);
    if (full || transaction) {
      for (const p of pending.filter((x) => !x.inventorySent)) {
        if (transaction) {
          const merge = (field, rows, keyName) => {
            const values = new Map(
              (json[field] || []).map((x) => [
                typeof x === "string" ? x : x[keyName],
                x,
              ]),
            );
            for (const x of rows) values.set(x[keyName], clone(x));
            json[field] = [...values.values()];
          };
          merge(
            "updatedStackedItems",
            p.stackIds.map(
              (id) =>
                target.inv.stackedItems.find((x) => x.catalogId === id) || {
                  catalogId: id,
                  quantity: 0,
                },
            ),
            "catalogId",
          );
          merge(
            "createdInstancedItems",
            target.inv.instancedItems.filter((x) =>
              p.newIds.includes(x.instanceId),
            ),
            "instanceId",
          );
          merge(
            "updatedInstancedItems",
            target.inv.instancedItems.filter((x) =>
              p.updatedIds.includes(x.instanceId),
            ),
            "instanceId",
          );
          merge("removedInstancedItems", p.removed, "instanceId");
        }
        p.inventorySent = true;
        p.inventoryResponseAt = new Date().toISOString();
        changed = true;
      }
    }
    if (
      /^\/loadout\/[^/]+\/[^/]+(?:\/all|\/active\/\d+)?\/?$/.test(pathname) &&
      json.payload?.loadouts
    ) {
      for (const p of pending.filter((x) => !x.loadoutSent)) {
        p.loadoutSent = true;
        p.loadoutResponseAt = new Date().toISOString();
        changed = true;
      }
      if (method === "GET" && /\/all\/?$/.test(pathname)) {
        for (const p of pending.filter(
          (x) =>
            x.slot !== null &&
            !x.nativeApplied &&
            Date.parse(x.createdAt) < startedAt,
        )) {
          p.nativeApplied = true;
          p.nativeAppliedVia = "next-sign-in";
          changed = true;
        }
      }
    }
    if (changed) adapter.saveReceipts();
    return json;
  }
  // Preserve an imported slot against a client saving its cached, older slot before refreshing.
  function protect(character, method, pathname, body) {
    if (!["POST", "PUT"].includes(method)) return body;
    const match = /^\/loadout\/[^/]+\/[^/]+\/(?:active\/)?(\d+)\/?$/.exec(
      pathname,
    );
    if (!match) return body;
    const target = adapter.characters().find((x) => x.id === character);
    const p = adapter
      .receipts()
      .findLast(
        (x) =>
          x.character === character &&
          x.slot === Number(match[1]) &&
          !native.buildApplied(adapter, x),
      );
    if (!p || !target) return body;
    // The native route still performs ownership checks and handles activation.
    return { ...body, data: clone(target.loadouts[p.slot]) };
  }
  return { admin, decorate, protect, snapshot };
}
module.exports = { create, message };
