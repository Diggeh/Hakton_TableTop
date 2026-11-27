'use strict';
// Sandboxed preload (CommonJS). Exposes a minimal, explicit API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hakton', {
  quit: () => ipcRenderer.send('hakton:quit'),
  getServerInfo: () => ipcRenderer.invoke('hakton:server-info'),
  getServerStatus: () => ipcRenderer.invoke('hakton:server-status'),
  getRecoveryStatus: () => ipcRenderer.invoke('hakton:recovery-status'),
  startServer: (opts) => ipcRenderer.invoke('hakton:server-start', opts),
  stopServer: () => ipcRenderer.invoke('hakton:server-stop'),
  user: {
    hasAccount: () => ipcRenderer.invoke('hakton:user:has-account'),
    create: (credentials) => ipcRenderer.invoke('hakton:user:create', credentials),
    login: (credentials) => ipcRenderer.invoke('hakton:user:login', credentials),
    getCurrent: () => ipcRenderer.invoke('hakton:user:get-current'),
    logout: () => ipcRenderer.invoke('hakton:user:logout'),
  },
  campaigns: {
    list: () => ipcRenderer.invoke('hakton:campaigns:list'),
    create: (payload = {}) => ipcRenderer.invoke('hakton:campaigns:create', payload),
    update: (id, patch = {}) => ipcRenderer.invoke('hakton:campaigns:update', { id, ...patch }),
    delete: (id) => ipcRenderer.invoke('hakton:campaigns:delete', { id }),
  },
  notes: {
    list: (payload = {}) => ipcRenderer.invoke('hakton:notes:list', payload),
    createFolder: (payload = {}) => ipcRenderer.invoke('hakton:notes:create-folder', payload),
    renameFolder: (id, name, ownerId) => ipcRenderer.invoke('hakton:notes:rename-folder', { id, name, ownerId }),
    deleteFolder: (id, ownerId) => ipcRenderer.invoke('hakton:notes:delete-folder', { id, ownerId }),
    createNote: (payload = {}) => ipcRenderer.invoke('hakton:notes:create-note', payload),
    updateNote: (id, patch = {}) => ipcRenderer.invoke('hakton:notes:update-note', { id, ...patch }),
    deleteNote: (id, ownerId) => ipcRenderer.invoke('hakton:notes:delete-note', { id, ownerId }),
  },
  assets: {
    list: (filters = {}) => ipcRenderer.invoke('hakton:assets:list', filters),
    get: (id) => ipcRenderer.invoke('hakton:assets:get', { id }),
    selectFiles: (options = {}) => ipcRenderer.invoke('hakton:assets:select-files', options),
    pickAndUpload: (options = {}) => ipcRenderer.invoke('hakton:assets:pick-and-upload', options),
    uploadPaths: (payload = {}) => ipcRenderer.invoke('hakton:assets:upload-paths', payload),
    uploadFiles: (payload = {}) => ipcRenderer.invoke('hakton:assets:upload-buffer', payload),
    rename: (id, name) => ipcRenderer.invoke('hakton:assets:rename', { id, name }),
    setCategory: (id, category) => ipcRenderer.invoke('hakton:assets:set-category', { id, category }),
    updateMetadata: (id, metadata) => ipcRenderer.invoke('hakton:assets:update-metadata', { id, metadata }),
    delete: (id) => ipcRenderer.invoke('hakton:assets:delete', { id }),
  },
});
