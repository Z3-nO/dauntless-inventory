"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
});
