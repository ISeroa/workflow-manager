import { contextBridge, ipcRenderer } from 'electron';
import type { RunEventMessage, VerifyEventMessage, WfApi } from '../shared/types.js';

const api: WfApi = {
  openRepo: (p) => ipcRenderer.invoke('wf:openRepo', p),
  snapshot: () => ipcRenderer.invoke('wf:snapshot'),
  startPackage: (wp) => ipcRenderer.invoke('wf:startPackage', wp),
  commitPlan: (wp) => ipcRenderer.invoke('wf:commitPlan', wp),
  start: (wp, ct) => ipcRenderer.invoke('wf:start', wp, ct),
  revise: (wp, ct, req) => ipcRenderer.invoke('wf:revise', wp, ct, req),
  cancel: () => ipcRenderer.invoke('wf:cancel'),
  changes: (wp, ct) => ipcRenderer.invoke('wf:changes', wp, ct),
  verify: (wp, scope) => ipcRenderer.invoke('wf:verify', wp, scope),
  cancelVerify: () => ipcRenderer.invoke('wf:cancelVerify'),
  commit: (wp, ct, req) => ipcRenderer.invoke('wf:commit', wp, ct, req),
  fetch: () => ipcRenderer.invoke('wf:fetch'),
  push: (wp) => ipcRenderer.invoke('wf:push', wp),
  prView: (wp) => ipcRenderer.invoke('wf:prView', wp),
  createPr: (wp, req) => ipcRenderer.invoke('wf:createPr', wp, req),
  openExternal: (url) => ipcRenderer.invoke('wf:openExternal', url),
  doctor: () => ipcRenderer.invoke('wf:doctor'),
  fix: (action) => ipcRenderer.invoke('wf:fix', action),
  onRunEvent: (cb) => {
    const h = (_e: unknown, msg: RunEventMessage) => cb(msg);
    ipcRenderer.on('wf:run-event', h);
    return () => ipcRenderer.removeListener('wf:run-event', h);
  },
  onVerifyEvent: (cb) => {
    const h = (_e: unknown, msg: VerifyEventMessage) => cb(msg);
    ipcRenderer.on('wf:verify-event', h);
    return () => ipcRenderer.removeListener('wf:verify-event', h);
  },
};

contextBridge.exposeInMainWorld('wf', api);
