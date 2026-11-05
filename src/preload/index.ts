import { contextBridge, ipcRenderer } from "electron";
import { IPC, type TimeCenterApi } from "../shared/ipc";

/**
 * The only bridge between the sandboxed renderer and the main process: a fixed list of calls, each
 * forwarded over IPC. The renderer gets no direct access to Node or Electron.
 */
const api: TimeCenterApi = {
  getDay: (at) => ipcRenderer.invoke(IPC.getDay, at),
  getRules: () => ipcRenderer.invoke(IPC.getRules),
  saveRules: (rules) => ipcRenderer.invoke(IPC.saveRules, rules),
  getIgnoredApps: () => ipcRenderer.invoke(IPC.getIgnoredApps),
  saveIgnoredApps: (apps) => ipcRenderer.invoke(IPC.saveIgnoredApps, apps),
  getPermissions: () => ipcRenderer.invoke(IPC.getPermissions),
  requestPermission: (kind) => ipcRenderer.invoke(IPC.requestPermission, kind),
  openPermissionSettings: (kind) => ipcRenderer.invoke(IPC.openPermissionSettings, kind),
  getBackupStatus: () => ipcRenderer.invoke(IPC.getBackupStatus),
  saveBackupSettings: (input) => ipcRenderer.invoke(IPC.saveBackupSettings, input),
  runBackupNow: () => ipcRenderer.invoke(IPC.runBackupNow),
  restoreLatestBackup: () => ipcRenderer.invoke(IPC.restoreLatestBackup),
};

contextBridge.exposeInMainWorld("timeCenter", api);
