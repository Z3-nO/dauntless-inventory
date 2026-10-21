// Local HTTP bridge used inside the desktop window. No public network listener.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const images = require("./images.cjs");
const settings = require("./settings.cjs");
const directories = require("./directories.cjs");
const resets = require("./character-reset.cjs");
const saves = require("./saves.cjs");
const liveInstall = require("./live-install.cjs");
const liveClient = require("./live-client.cjs");
const { LiveUpdates } = require("./live-updates.cjs");
const updates = new LiveUpdates({
  directory: path.join(
    process.env.MATERIALI_USER_DATA ||
      path.join(
        process.env.LOCALAPPDATA || __dirname,
        "DauntlessMateriali/preferences",
      ),
    "live-updates",
  ),
  config: require("./update-channel.json"),
  toolVersion: require("./package.json").version,
});
const { catalogs } = require("./inventory.cjs");
const { planBuild } = require("./build-import.cjs");
const token = crypto.randomBytes(32).toString("hex");
const base = __dirname;
let connection = null;
let liveBinding = null;
let busy = false;
let preparingApplicationUpdate = false;

function standardImages(root, version) {
  const saved = settings.get(version);
  return images.standardPaths(
    root ||
      saved.dataRoot ||
      directories.findDirectories(version).dataRoot ||
      "",
    version,
    base,
    saved.gameDir,
  );
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function detectedFolders() {
  return ["DauntlessForever", "DauntlessOffline"]
    .map((name) => path.join(process.env.LOCALAPPDATA || "", name))
    .filter((folder) => fs.existsSync(folder));
}

async function readRequest(request) {
  const limit = request.url === "/api/image-import" ? 12001000 : 2000000;
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw Error("Request too large.");
  }
  return JSON.parse(body);
}

async function api(request, response, route) {
  if (request.headers["x-tool-token"] !== token)
    throw Error("Unauthorized request.");
  if (request.method === "GET" && route === "/api/catalog")
    return json(response, 200, {
      catalogs,
      detected: detectedFolders(),
      imageRoots: images.settings(),
      directories: Object.fromEntries(
        Object.keys(catalogs).map((v) => [v, settings.get(v)]),
      ),
      directoryExamples: directories.examples(),
      standardImages: Object.fromEntries(
        Object.keys(catalogs).map((v) => [v, standardImages("", v)]),
      ),
    });
  if (request.method !== "POST") throw Error("Unsupported method.");
  // This status is an in-memory read and can run while discovery or a download
  // is busy. It must not make the Settings panel falsely report a connection error.
  if (route === "/api/live-update-status") {
    const data = await readRequest(request);
    if (!Object.hasOwn(catalogs, data.version))
      throw Error("Unsupported version.");
    return json(response, 200, updates.status());
  }
  if (preparingApplicationUpdate)
    throw Error("Inventory is restarting to apply an application update.");
  if (busy) throw Error("An operation is already in progress.");
  busy = true;
  try {
    const data = await readRequest(request);
    if (!Object.hasOwn(catalogs, data.version))
      throw Error("Unsupported version.");
    if (route === "/api/live-update-status")
      return json(response, 200, updates.status());
    if (route === "/api/live-update-settings")
      return json(response, 200, updates.saveSettings(data));
    if (route === "/api/live-update-check")
      return json(response, 200, await updates.check());
    if (route === "/api/live-update-import")
      return json(response, 200, await updates.importFolder(data.folder));
    if (route === "/api/live-update-apply") {
      const target = saves.packageRoot(
        data.root || settings.get(data.version).dataRoot || "",
        data.version,
      );
      const result = await updates.apply(target);
      if (result.updated) connection = null;
      return json(response, 200, result);
    }
    if (route === "/api/directories-find")
      return json(response, 200, directories.findDirectories(data.version));
    if (route === "/api/settings") {
      const directories = settings.save(data.version, data);
      if (connection?.version === data.version) connection = null;
      if (liveBinding?.version === data.version) liveBinding = null;
      return json(response, 200, {
        directories,
        standardImages: standardImages("", data.version),
      });
    }
    if (
      [
        "/api/live-install",
        "/api/live-uninstall",
        "/api/live-install-status",
      ].includes(route)
    ) {
      const target = saves.packageRoot(
        data.root ||
          settings.get(data.version).dataRoot ||
          directories.findDirectories(data.version).dataRoot ||
          "",
        data.version,
      );
      target.nativeRefresh = true;
      const result =
        route === "/api/live-install"
          ? await updates.apply(target, { install: true })
          : route === "/api/live-uninstall"
            ? await liveInstall.uninstall(target)
            : liveInstall.status(target);
      return json(response, 200, result);
    }
    if (route === "/api/connect") {
      const candidate = saves.packageRoot(
        data.root ||
          settings.get(data.version).dataRoot ||
          directories.findDirectories(data.version).dataRoot ||
          "",
        data.version,
      );
      const running = await saves.backendUp(
        candidate.version === "1.6.2" ? 61000 : 63000,
      );
      const result =
        running && liveInstall.status(candidate).installed
          ? await liveClient.call(candidate, "snapshot")
          : saves.snapshot(candidate);
      connection = candidate;
      liveBinding = result.live ? candidate : null;
      return json(response, 200, {
        ...result,
        root: candidate.root,
        standardImages: standardImages(candidate.root, data.version),
      });
    }
    if (route === "/api/images")
      return json(
        response,
        200,
        await images.scan(data.root, data.version, catalogs[data.version]),
      );
    if (route === "/api/image-import") {
      if (!catalogs[data.version].some((item) => item.id === data.id))
        throw Error("Item not found.");
      images.importImage(data.version, data.id, data.base64);
      return json(response, 200, { ok: true });
    }
    if (route === "/api/build-preview")
      return json(response, 200, planBuild(data.code, data.version));
    if (route === "/api/live-discover") {
      const sessions = [];
      for (const version of Object.keys(catalogs)) {
        try {
          const root =
            settings.get(version).dataRoot ||
            directories.findDirectories(version).dataRoot;
          if (
            !root ||
            !(await saves.backendUp(version === "1.6.2" ? 61000 : 63000))
          )
            continue;
          const target = saves.packageRoot(root, version);
          if (!liveInstall.status(target).installed) continue;
          const result = await liveClient.call(target, "snapshot");
          if (
            !result.nativeRefresh?.available ||
            (!result.gameCharacter && !result.activeCharacter)
          )
            continue;
          if (result.nativeRefresh.connections !== 1) continue;
          sessions.push({ target, result });
        } catch {
          /* A non-Live or unrelated backend is not an active game session. */
        }
      }
      if (sessions.length > 1)
        throw Error(
          "More than one Live session is active. Choose a version and connect explicitly.",
        );
      if (!sessions.length) return json(response, 200, { live: false });
      connection = liveBinding = sessions[0].target;
      return json(response, 200, {
        ...sessions[0].result,
        version: connection.version,
      });
    }
    if (route === "/api/live-status") {
      const target =
        liveBinding?.version === data.version ? liveBinding : connection;
      if (!target || target.version !== data.version)
        throw Error("Connect a save for the selected version first.");
      const result = await liveClient.call(target, "snapshot");
      connection = liveBinding = target;
      return json(response, 200, result);
    }
    if (!connection || connection.version !== data.version)
      throw Error("Connect a save for the selected version first.");
    if (route === "/api/build-export") {
      const running = await saves.backendUp(
        connection.version === "1.6.2" ? 61000 : 63000,
      );
      const result = running
        ? await liveClient.call(connection, "build-export", data)
        : require("./build-export.cjs").fromSave(connection, data);
      return json(response, 200, result);
    }
    if (route === "/api/reset-backups") {
      const own = saves
        .snapshot(connection)
        .characters.some((ch) => ch.id === data.character);
      if (!own) throw Error("Character not found.");
      return json(
        response,
        200,
        resets.resetPoints(connection, data.character),
      );
    }
    if (route === "/api/reset-character" || route === "/api/restore-character")
      return json(
        response,
        200,
        await saves.saveChanges(connection, {
          ...data,
          operation: route.slice(5),
        }),
      );
    if (route === "/api/slots-add")
      return json(
        response,
        200,
        await saves.saveChanges(connection, {
          ...data,
          operation: "add-slots",
        }),
      );
    if (route === "/api/apply" || route === "/api/build-apply")
      return json(response, 200, await saves.saveChanges(connection, data));
    throw Error("Operation not found.");
  } finally {
    busy = false;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.headers.host !== "127.0.0.1:" + server.address().port)
      throw Error("Invalid local address.");
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/"))
      return await api(request, response, url.pathname);
    if (request.method !== "GET") throw Error("Unsupported method.");
    let file;
    if (url.pathname.startsWith("/assets/")) {
      const name = decodeURIComponent(url.pathname.slice(8));
      const id = name.slice(0, -4);
      const version = url.searchParams.get("version") || "1.6.2";
      if (
        !name.endsWith(".png") ||
        !catalogs[version]?.some((item) => item.id === id)
      )
        throw Error("Invalid image.");
      file = images.find(version, id, base);
    } else {
      const allowed = {
        "/": "index.html",
        "/app.js": "app.js",
        "/visibility.js": "visibility.js",
        "/build-ui.js": "build-ui.js",
        "/slots-ui.js": "slots-ui.js",
        "/settings-ui.js": "settings-ui.js",
        "/reset-ui.js": "reset-ui.js",
        "/live-ui.js": "live-ui.js",
        "/live-session.js": "live-session.js",
        "/updates-ui.js": "updates-ui.js",
        "/desktop-updates-ui.js": "desktop-updates-ui.js",
        "/style.css": "style.css",
        "/ui/helmet.webp": "ui/helmet.webp",
        ...Object.fromEntries(
          [0, 1, 2, 3, 4].map((i) => [
            "/ui/fonts/font-" + i + ".ttf",
            "ui/fonts/font-" + i + ".ttf",
          ]),
        ),
      };
      if (!Object.hasOwn(allowed, url.pathname)) throw Error("Page not found.");
      file = path.join(base, "public", allowed[url.pathname]);
    }
    if (!fs.existsSync(file)) {
      response.writeHead(404);
      return response.end();
    }
    let content = fs.readFileSync(file);
    if (file.endsWith(".html"))
      content = content.toString().replace("__TOKEN__", token);
    const extension = path.extname(file).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webp": "image/webp",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".ttf": "font/ttf",
    };
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

let updateTaskRunning = false;
let lastUpdateAttempt = 0;
async function automaticUpdates() {
  if (preparingApplicationUpdate || busy || updateTaskRunning) return;
  updateTaskRunning = true;
  try {
    const options = updates.status();
    if (
      options.automaticCheck &&
      options.configured &&
      Date.now() - lastUpdateAttempt > 30 * 60 * 1000
    ) {
      lastUpdateAttempt = Date.now();
      try {
        await updates.check();
      } catch {
        /* The status panel reports download errors. */
      }
    }
    if (!updates.status().automaticInstall || busy) return;
    busy = true;
    try {
      for (const version of Object.keys(catalogs)) {
        const root = settings.get(version).dataRoot;
        if (!root) continue;
        try {
          const target = saves.packageRoot(root, version);
          if (!liveInstall.status(target).installed) continue;
          const result = await updates.apply(target, { automatic: true });
          if (result.updated) connection = null;
        } catch (error) {
          updates.results[version] = { message: error.message };
        }
      }
    } finally {
      busy = false;
    }
  } finally {
    updateTaskRunning = false;
  }
}

if (require.main === module) {
  process.on("message", async (message) => {
    if (message?.type === "cancel-app-update") {
      preparingApplicationUpdate = false;
      return;
    }
    if (
      message?.type !== "prepare-app-update" ||
      typeof message.id !== "string"
    )
      return;
    preparingApplicationUpdate = true;
    const deadline = Date.now() + 40000;
    while (
      (busy || updateTaskRunning) &&
      preparingApplicationUpdate &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (preparingApplicationUpdate && !busy && !updateTaskRunning)
      process.send?.({ type: "app-update-ready", id: message.id });
    else preparingApplicationUpdate = false;
  });
  setTimeout(automaticUpdates, 5000).unref();
  setInterval(automaticUpdates, 60000).unref();
  images
    .restore(catalogs)
    .then(() =>
      server.listen(0, "127.0.0.1", () =>
        console.log(
          "Local service ready: http://127.0.0.1:" + server.address().port,
        ),
      ),
    );
}
module.exports = { ...saves, server, catalogs, automaticUpdates, updates };
