'use strict';
// Sandboxed preload (CommonJS). Exposes a minimal, explicit API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hakton', {
  getServerInfo: () => ipcRenderer.invoke('hakton:server-info'),
  getServerStatus: () => ipcRenderer.invoke('hakton:server-status'),
  startServer: (opts) => ipcRenderer.invoke('hakton:server-start', opts),
  stopServer: () => ipcRenderer.invoke('hakton:server-stop'),
});
