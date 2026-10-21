// Desktop shell: one application window, with the local save service as a child process.
"use strict";
const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DesktopUpdates } = require("./desktop-updates.cjs");
// The preview has its own preferences, browser storage and single-instance lock.
const previewData = path.resolve(
  process.env.MATERIALI_USER_DATA ||
    path.join(app.getPath("appData"), "DauntlessInventory-LivePreview"),
);
process.env.MATERIALI_USER_DATA = previewData;
const desktopData = path.join(previewData, "desktop");
fs.mkdirSync(desktopData, { recursive: true });
app.setPath("userData", desktopData);
let mainWindow;
let service;
let shuttingDown = false;
let serviceUrl;
let restartInProgress = false;
let applicationUpdates;
const toolRoot = app.isPackaged
  ? path.join(process.resourcesPath, "tool")
  : fs.existsSync(path.join(__dirname, "server.cjs"))
    ? __dirname
    : path.resolve(__dirname, "../../outputs/DauntlessMateriali");

function log(message) {
  const folder = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(folder, { recursive: true });
  fs.appendFileSync(
    path.join(folder, "desktop.log"),
    new Date().toISOString() + " " + message + "\n",
  );
}

function startService() {
  return new Promise((resolve, reject) => {
    service = spawn(
      path.join(toolRoot, "runtime/node.exe"),
      [path.join(toolRoot, "server.cjs")],
      {
        cwd: toolRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let output = "";
    let ready = false;
    const timer = setTimeout(
      () => reject(Error("The local service is not responding.")),
      60000,
    );
    service.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(
        /Local service ready: (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (match && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    service.stderr.on("data", (chunk) => log(chunk.toString()));
    service.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    service.on("exit", (code) => {
      clearTimeout(timer);
      if (!ready) reject(Error("Local service stopped: " + code));
      else if (!shuttingDown) {
        dialog.showErrorBox(
          "Dauntless Inventory",
          "The local service stopped. Restart the app.",
        );
        app.quit();
      }
    });
  });
}

function assertDesktopSender(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== serviceUrl
  )
    throw Error("Untrusted desktop request.");
}

async function prepareServiceForUpdate() {
  if (!service || service.exitCode !== null) return;
  const id = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          Error(
            "The editor is still finishing an operation. Retry the update shortly.",
          ),
        ),
      45000,
    );
    const receive = (message) => {
      if (message?.type === "app-update-ready" && message.id === id) finish();
    };
    const exited = () => finish();
    function finish(error) {
      clearTimeout(timer);
      service.off("message", receive);
      service.off("exit", exited);
      error ? reject(error) : resolve();
    }
    service.on("message", receive);
    service.once("exit", exited);
    service.send({ type: "prepare-app-update", id }, (error) => {
      if (error) finish(error);
    });
  });
}

ipcMain.handle("choose-folder", async (event) => {
  assertDesktopSender(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("application-update-status", (event) => {
  assertDesktopSender(event);
  return applicationUpdates.status();
});
ipcMain.handle("application-update-check", async (event) => {
  assertDesktopSender(event);
  return applicationUpdates.check();
});
ipcMain.handle("application-update-settings", (event, value) => {
  assertDesktopSender(event);
  return applicationUpdates.settings(value);
});
ipcMain.handle("application-update-restart", async (event) => {
  assertDesktopSender(event);
  if (restartInProgress) return;
  restartInProgress = true;
  try {
    const handoff = await applicationUpdates.createHandoff(
      undefined,
      service?.pid,
    );
    await prepareServiceForUpdate();
    await applicationUpdates.launchHandoff(handoff);
    app.quit();
  } catch (error) {
    service?.send({ type: "cancel-app-update" });
    throw error;
  } finally {
    restartInProgress = false;
  }
});

async function createWindow() {
  app.setAccessibilitySupportEnabled(true);
  const url = await startService();
  serviceUrl = url;
  mainWindow = new BrowserWindow({
    title: "Dauntless Inventory Live Preview",
    width: 1440,
    height: 1000,
    minWidth: 950,
    minHeight: 700,
    backgroundColor: "#0e1318",
    icon: path.join(toolRoot, "assets/helmet.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, destination) => {
    if (new URL(destination).origin !== url) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => {
    mainWindow.center();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  await mainWindow.loadURL(url);
  log("Desktop ready " + url);
  await applicationUpdates.acknowledge(process.env.DAUNTLESS_UPDATE_JOB);
  delete process.env.DAUNTLESS_UPDATE_JOB;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      applicationUpdates = new DesktopUpdates({
        directory: path.join(previewData, "application-updates"),
        config: require(path.join(toolRoot, "update-channel.json")),
        currentVersion: app.getVersion(),
        currentExecutable: app.isPackaged
          ? process.env.PORTABLE_EXECUTABLE_FILE
          : null,
        userData: previewData,
        helperSource: path.join(toolRoot, "scripts/restart-application.cjs"),
        changed: (state) => {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send("application-update-status", state);
        },
      });
      await applicationUpdates.announceStart(process.env.DAUNTLESS_UPDATE_JOB);
      const target = await applicationUpdates.bootstrapTarget();
      if (target) {
        const handoff = await applicationUpdates.createHandoff({
          version: target.version,
          digest: target.digest,
        });
        await applicationUpdates.launchHandoff(handoff);
        app.quit();
        return;
      }
      await createWindow();
      const check = () => {
        if (!applicationUpdates.state.automaticDownload || restartInProgress)
          return;
        applicationUpdates
          .check()
          .catch((error) => log("Application update: " + error.message));
      };
      setTimeout(check, 10000).unref();
      setInterval(check, 30 * 60 * 1000).unref();
    })
    .catch((error) => {
      log(error.stack);
      dialog.showErrorBox("Startup failed", error.message);
      app.quit();
    });
  app.on("before-quit", () => {
    shuttingDown = true;
    if (service && !service.killed) service.kill();
  });
  app.on("window-all-closed", () => app.quit());
}
