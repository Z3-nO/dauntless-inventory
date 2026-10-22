"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  loadApplicationDraft: () =>
    ipcRenderer.invoke("application-update-load-draft"),
  saveApplicationDraft: (value) =>
    ipcRenderer.invoke("application-update-save-draft", value),
  onApplicationRestart: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("application-update-preparing", listener);
    return () =>
      ipcRenderer.removeListener("application-update-preparing", listener);
  },
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
