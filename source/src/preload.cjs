'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const invoke = (name, value) => ipcRenderer.invoke(`tracker:${name}`, value);
contextBridge.exposeInMainWorld('tracker', Object.freeze({
  status: () => invoke('status'), displays: () => invoke('displays'), prepare: value => invoke('prepare', value), confirm: token => invoke('confirm', token), fail: value => invoke('fail', value), pause: () => invoke('pause'), stop: () => invoke('stop'), idleReview: value => invoke('idle-review', value), authorizeCapture: value => invoke('authorize-capture', value), finalizeCapture: value => ipcRenderer.sendSync('tracker:finalize-capture', value) === true, saveCapture: value => invoke('save-capture', value), captureFailed: value => invoke('capture-failed', value), gallery: () => invoke('gallery'), image: id => invoke('image', id), reveal: id => invoke('reveal', id), openFolder: () => invoke('open-folder'),
  syncLogin: value => invoke('sync-login', value), syncLogout: value => invoke('sync-logout', value), syncConsent: () => invoke('sync-consent'), syncNow: () => invoke('sync-now'),
  addManualEntry: value => invoke('sync-manual-entry', value), manualEntries: () => invoke('sync-manual-entries'),
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('tracker:state', listener); return () => ipcRenderer.removeListener('tracker:state', listener); },
  onCapture: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('tracker:capture', listener); return () => ipcRenderer.removeListener('tracker:capture', listener); }
}));
