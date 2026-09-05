import type { HornbookDesktopBridge } from '../src/lib/desktop.ts';
import type { DesktopPreferencesView, DesktopUpdateState } from '../src/lib/api-types.ts';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const bridge: HornbookDesktopBridge = {
  progressDraft: (section, value) => ipcRenderer.sendSync('hornbook:progress-draft', section, value),
  state: () => ipcRenderer.invoke('hornbook:state'),
  chooseJournal: () => ipcRenderer.invoke('hornbook:choose-journal'),
  openJournal: () => ipcRenderer.invoke('hornbook:open-journal'),
  chooseToolPath: (kind) => ipcRenderer.invoke('hornbook:choose-tool', kind),
  setPreferences: (patch: Partial<DesktopPreferencesView>) => ipcRenderer.invoke('hornbook:set-preferences', patch),
  checkForUpdates: (force = true) => ipcRenderer.invoke('hornbook:check-updates', force),
  restartToUpdate: () => ipcRenderer.invoke('hornbook:restart-update'),
  onUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => listener(state);
    ipcRenderer.on('hornbook:update-state', handler);
    return () => ipcRenderer.removeListener('hornbook:update-state', handler);
  },
};

contextBridge.exposeInMainWorld('hornbookDesktop', bridge);
