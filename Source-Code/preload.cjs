"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  applicationUpdateStatus: () =>
    ipcRenderer.invoke("application-update-status"),
  checkApplicationUpdate: () => ipcRenderer.invoke("application-update-check"),
  saveApplicationUpdateSettings: (value) =>
    ipcRenderer.invoke("application-update-settings", value),
  restartApplicationUpdate: () =>
    ipcRenderer.invoke("application-update-restart"),
  onApplicationUpdate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("application-update-status", listener);
    return () =>
      ipcRenderer.removeListener("application-update-status", listener);
  },
});
