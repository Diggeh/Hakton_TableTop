'use strict';
// Sandboxed preload (CommonJS). Exposes a minimal, explicit API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hakton', {
  getServerInfo: () => ipcRenderer.invoke('hakton:server-info'),
});
