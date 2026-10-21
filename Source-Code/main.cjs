// Desktop shell: one application window, with the local save service as a child process.
"use strict";
const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
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
        stdio: ["ignore", "pipe", "pipe"],
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

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

async function createWindow() {
  app.setAccessibilitySupportEnabled(true);
  const url = await startService();
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
    .then(() => {
      Menu.setApplicationMenu(null);
      return createWindow();
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
