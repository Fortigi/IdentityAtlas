'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('identityAtlas', {
  quit: () => ipcRenderer.send('quit'),
});
