import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import type { CommitRequest, IpcResult, PrRequest, ReviseRequest, RunEventMessage, VerifyEventMessage } from '../shared/types.js';
import { runDoctor } from '../core/doctor.js';
import { UserError, WorkflowService } from '../core/service.js';
import { LocalStore } from '../core/store.js';
import { runSmoke } from './smoke.js';

let win: BrowserWindow | undefined;
let service: WorkflowService;

async function wrap<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const err = e as Error;
    if (!(err instanceof UserError)) console.error(err);
    return { ok: false, error: err.message };
  }
}

function registerIpc() {
  ipcMain.handle('wf:openRepo', (_e, p?: string) =>
    wrap(async () => {
      let dir = p;
      if (!dir) {
        const r = await dialog.showOpenDialog(win!, { title: 'Git 저장소 선택', properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return null;
        dir = r.filePaths[0];
      }
      return service.openRepo(dir);
    }),
  );
  ipcMain.handle('wf:snapshot', () =>
    wrap(async () => {
      if (!service.repoRoot) {
        const last = service.store.lastRepo;
        if (!last) return null;
        try {
          return await service.openRepo(last);
        } catch {
          return null;
        }
      }
      return service.snapshot();
    }),
  );
  ipcMain.handle('wf:startPackage', (_e, wp: string) => wrap(() => service.startPackage(wp)));
  ipcMain.handle('wf:commitPlan', (_e, wp: string) => wrap(() => service.commitPlan(wp)));
  ipcMain.handle('wf:start', (_e, wp: string, ct: string) => wrap(async () => (await service.start(wp, ct), null)));
  ipcMain.handle('wf:revise', (_e, wp: string, ct: string, req: ReviseRequest) => wrap(async () => (await service.revise(wp, ct, req), null)));
  ipcMain.handle('wf:cancel', () => wrap(() => (service.cancel(), null)));
  ipcMain.handle('wf:changes', (_e, wp: string, ct: string) => wrap(() => service.changes(wp, ct)));
  ipcMain.handle('wf:verify', (_e, wp: string, scope: string) => wrap(async () => (await service.verify(wp, scope), null)));
  ipcMain.handle('wf:cancelVerify', () => wrap(() => (service.cancelVerify(), null)));
  ipcMain.handle('wf:commit', (_e, wp: string, ct: string, req: CommitRequest) => wrap(() => service.commit(wp, ct, req)));
  ipcMain.handle('wf:fetch', () => wrap(async () => (await service.fetch(), null)));
  ipcMain.handle('wf:push', (_e, wp: string) => wrap(() => service.push(wp)));
  ipcMain.handle('wf:prView', (_e, wp: string) => wrap(() => service.prView(wp)));
  ipcMain.handle('wf:createPr', (_e, wp: string, req: PrRequest) => wrap(() => service.createPr(wp, req)));
  ipcMain.handle('wf:doctor', () => wrap(() => runDoctor(service.repoRoot)));
  ipcMain.handle('wf:openExternal', (_e, url: string) =>
    wrap(async () => {
      if (!/^https:\/\//i.test(url)) throw new UserError('https 링크만 열 수 있어요.');
      await shell.openExternal(url);
      return null;
    }),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'Workflow Manager',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '../../../renderer/index.html'));
  win.on('closed', () => (win = undefined));
}

app.whenReady().then(() => {
  const storeDir = process.env.WF_STORE_DIR ?? app.getPath('userData');
  service = new WorkflowService(new LocalStore(storeDir));
  service.on('run-event', (msg: RunEventMessage) => win?.webContents.send('wf:run-event', msg));
  service.on('verify-event', (msg: VerifyEventMessage) => win?.webContents.send('wf:verify-event', msg));
  registerIpc();
  createWindow();
  if (process.argv.includes('--smoke')) runSmoke(win!, service);
});

app.on('window-all-closed', () => app.quit());
