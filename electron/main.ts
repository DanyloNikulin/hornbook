import { retryableShutdown } from '../scripts/lib/shutdown.ts';
import { randomBytes } from 'node:crypto';
import { UpdateController } from './update-controller.ts';
import { desktopProgressDraft } from './progress-drafts.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import electronUpdater from 'electron-updater';
import type { DesktopState, DesktopUpdateState, JobView } from '../src/lib/api-types.ts';
import type { DesktopToolPath } from '../src/lib/desktop.ts';
import { startServer } from '../server/main.ts';
import { defaultJournalDir } from '../server/cli.ts';
import { compareVersions, ReleaseChecker, UPDATE_INTERVAL_MS } from '../server/releases.ts';
import { packageRoot } from '../scripts/lib/runtime.ts';
import { countLessons, seedJournal } from '../server/launch.ts';
import { DEMO_JOURNAL } from '../scripts/lib/demo-journal.ts';
import { loadPreferences, savePreferences, type DesktopPreferences } from './preferences.ts';

const APP_ID = 'io.github.danylonikulin.hornbook';
const UPDATE_POLL_MS = 60 * 60 * 1000;
const appRoot = packageRoot(import.meta.url);
const { autoUpdater } = electronUpdater;

app.enableSandbox();
app.setAppUserModelId(APP_ID);
if (process.env['HORNBOOK_ELECTRON_PROFILE']?.trim()) {
  app.setPath('userData', resolve(process.env['HORNBOOK_ELECTRON_PROFILE']));
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ReturnType<typeof startServer> | null = null;
let baseUrl = '';
let quitting = false;
let shutdownComplete = false;
const stopServer = retryableShutdown(async () => {
  await server?.shutdown();
  shutdownComplete = true;
});
let activeJobs = 0;
let journal = '';
let preferencesPath = '';
let preferences: DesktopPreferences = { automaticUpdates: true, startWithSystem: false };
let updateState: DesktopUpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  installable: isInstallable(),
};
let checker: ReleaseChecker;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let updater: UpdateController;

function argValue(name: string, argv: readonly string[] = process.argv): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isInstallable(): boolean {
  return app.isPackaged && process.env['HORNBOOK_SKIP_AUTO_UPDATER'] !== '1';
}

function isAppOrigin(url: string): boolean {
  try {
    return !!baseUrl && new URL(url).origin === baseUrl;
  } catch {
    return false;
  }
}

function publicState(): DesktopState {
  return {
    journal,
    platform: process.platform,
    preferences: {
      automaticUpdates: preferences.automaticUpdates,
      startWithSystem: preferences.startWithSystem,
    },
    update: updateState,
  };
}

function persist(): void {
  savePreferences(preferencesPath, preferences);
}

function assertRenderer(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isAppOrigin(senderUrl)) throw new Error('Untrusted Hornbook IPC sender');
}

function openDialog(options: OpenDialogOptions): ReturnType<typeof dialog.showOpenDialog> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function messageBox(options: MessageBoxOptions): ReturnType<typeof dialog.showMessageBox> {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

function showWindow(route = '/'): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(route);
    return;
  }
  if (route !== '/' && baseUrl) void mainWindow.loadURL(new URL(route, baseUrl).href);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(route = '/'): BrowserWindow {
  const size = preferences.window ?? { width: 1240, height: 820 };
  const icon = process.platform === 'win32'
    ? app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(appRoot, 'build', 'icon.ico')
    : join(appRoot, 'build', 'icon.png');
  const window = new BrowserWindow({
    title: 'Hornbook',
    width: size.width,
    height: size.height,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: '#f4ecdf',
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#00000000', symbolColor: '#f4ecdf', height: 36 } } : {}),
    icon,
    webPreferences: {
      preload: join(appRoot, 'dist', 'node', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:hornbook',
    },
  });
  mainWindow = window;
  // Windows Shell needs a real icon file, outside the application archive.
  if (process.platform === 'win32') window.setAppDetails({ appId: APP_ID, appIconPath: icon });
  if (process.platform !== 'darwin') window.setMenu(null);

  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    rememberWindowSize();
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rememberWindowSize, 250);
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(github\.com|www\.electronjs\.org)\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void window.loadURL(new URL(route, baseUrl).href);
  return window;
}

function rememberWindowSize(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
  const [width, height] = mainWindow.getSize();
  preferences.window = { width, height };
  persist();
}

function trayImage(withDot: boolean): Electron.NativeImage {
  const size = 18;
  const bitmap = Buffer.alloc(size * size * 4);
  const pixel = (x: number, y: number, red: number, green: number, blue: number, alpha = 255): void => {
    const at = (y * size + x) * 4;
    bitmap[at] = blue;
    bitmap[at + 1] = green;
    bitmap[at + 2] = red;
    bitmap[at + 3] = alpha;
  };
  for (let y = 2; y < 16; y++) {
    for (let x = 3; x < 15; x++) pixel(x, y, 31, 78, 95);
  }
  for (let y = 4; y < 14; y++) pixel(8, y, 244, 236, 223);
  if (withDot) {
    for (let y = 11; y < 18; y++) {
      for (let x = 11; x < 18; x++) if ((x - 14) ** 2 + (y - 14) ** 2 <= 10) pixel(x, y, 192, 101, 63);
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
}

function rebuildTray(): void {
  if (!tray) return;
  const updateWaiting = updateState.phase === 'available' || updateState.phase === 'downloading' || updateState.phase === 'ready';
  tray.setImage(trayImage(updateWaiting));
  tray.setToolTip(updateWaiting ? 'Hornbook · update available' : 'Hornbook');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow('/') },
      { label: `Jobs (${activeJobs} running)`, click: () => showWindow('/jobs') },
      { type: 'separator' },
      { label: 'Check for updates', click: () => void checkForUpdates(true) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function publishUpdate(state: DesktopUpdateState): DesktopUpdateState {
  updateState = state;
  rebuildTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hornbook:update-state', state);
  return state;
}

async function checkForUpdates(force: boolean): Promise<DesktopUpdateState> {
  if (!force && !preferences.automaticUpdates) return updateState;
  return updater.check(force);
}

function configureUpdater(): void {
  updater = new UpdateController({
    currentVersion: app.getVersion(),
    installable: isInstallable(),
    discover: async (force) => {
      const recent = preferences.lastUpdateCheck && Date.now() - Date.parse(preferences.lastUpdateCheck) < UPDATE_INTERVAL_MS;
      if (!force && recent) return {
        currentVersion: app.getVersion(), checkedAt: preferences.lastUpdateCheck!,
        available: !!preferences.lastRelease && compareVersions(preferences.lastRelease.version, app.getVersion()) > 0,
        release: preferences.lastRelease,
      };
      const result = await checker.check(force);
      preferences.lastUpdateCheck = result.checkedAt;
      if (!result.error) preferences.lastRelease = result.release;
      persist();
      return result;
    },
    prepare: async () => {
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    },
    publish: publishUpdate,
    ready: () => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title: 'Hornbook update ready', body: 'Restart Hornbook when you are ready to install it.' });
      notice.on('click', () => showWindow('/'));
      notice.show();
    },
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('update-available', (info) => updater.available(info.version));
  autoUpdater.on('update-not-available', () => updater.unavailable());
  autoUpdater.on('download-progress', (progress) => updater.progress(progress.percent));
  autoUpdater.on('update-downloaded', (info) => updater.downloaded(info.version));
  autoUpdater.on('error', (error) => updater.failed(error.message));
}

function notifyJob(job: JobView): void {
  if (!Notification.isSupported() || mainWindow?.isFocused()) return;
  const body = job.status === 'done' ? `${job.label} is ready.` : `${job.label} could not be completed.`;
  const notice = new Notification({ title: 'Hornbook job finished', body });
  notice.on('click', () => showWindow('/jobs'));
  notice.show();
}

function registerIpc(): void {
  ipcMain.handle('hornbook:state', (event) => {
    assertRenderer(event);
    return publicState();
  });
  ipcMain.handle('hornbook:choose-journal', async (event) => {
    assertRenderer(event);
    const selection = await openDialog({
      title: 'Choose a Hornbook journal folder',
      defaultPath: journal,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) return false;
    const entries = readdirSync(selected);
    if (entries.length > 0 && !existsSync(join(selected, 'journal.config.json'))) {
      await messageBox({
        type: 'warning',
        message: 'That folder is not a Hornbook journal.',
        detail: 'Choose an empty folder or one containing journal.config.json.',
      });
      return false;
    }
    if (activeJobs > 0) {
      const answer = await messageBox({
        type: 'question',
        buttons: ['Cancel', 'Change journal'],
        defaultId: 0,
        cancelId: 0,
        message: 'Change journal while work is running?',
        detail: `${activeJobs} active job${activeJobs === 1 ? '' : 's'} will be stopped.`,
      });
      if (answer.response === 0) return false;
    }
    preferences.journal = resolve(selected);
    persist();
    quitting = true;
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('hornbook:open-journal', async (event) => {
    assertRenderer(event);
    const error = await shell.openPath(journal);
    if (error) throw new Error(error);
  });
  ipcMain.on('hornbook:progress-draft', (event, section: string, value: unknown) => {
    try {
      assertRenderer(event);
      event.returnValue = desktopProgressDraft(join(app.getPath('userData'), 'progress-drafts'), journal, section, value);
    } catch (error) { event.returnValue = { value: null, error: (error as Error).message }; }
  });
  ipcMain.handle('hornbook:choose-tool', async (event, kind: DesktopToolPath) => {
    assertRenderer(event);
    if (!['FFMPEG_BIN', 'WHISPER_BIN', 'WHISPER_MODEL'].includes(kind)) throw new Error('Unknown tool path');
    const model = kind === 'WHISPER_MODEL';
    const result = await openDialog({
      title: model ? 'Choose a whisper.cpp model' : 'Choose a tool',
      properties: ['openFile'],
      filters: model
        ? [{ name: 'whisper.cpp model', extensions: ['bin'] }, { name: 'All files', extensions: ['*'] }]
        : process.platform === 'win32'
          ? [{ name: 'Programs', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
          : [{ name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('hornbook:set-preferences', (event, patch: unknown) => {
    assertRenderer(event);
    if (!patch || typeof patch !== 'object') throw new Error('Invalid preferences');
    const input = patch as Record<string, unknown>;
    if (typeof input['automaticUpdates'] === 'boolean') preferences.automaticUpdates = input['automaticUpdates'];
    if (typeof input['startWithSystem'] === 'boolean') {
      preferences.startWithSystem = input['startWithSystem'];
      if (process.platform === 'win32' || process.platform === 'darwin') {
        app.setLoginItemSettings({ openAtLogin: preferences.startWithSystem, path: process.execPath });
      }
    }
    persist();
    if (preferences.automaticUpdates && updateState.phase === 'idle') void checkForUpdates(false);
    return publicState();
  });
  ipcMain.handle('hornbook:check-updates', (event, force: boolean) => {
    assertRenderer(event);
    return checkForUpdates(force === true);
  });
  ipcMain.handle('hornbook:restart-update', async (event) => {
    assertRenderer(event);
    if (updateState.phase !== 'ready') return false;
    await stopServer();
    quitting = true;
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
}

async function start(): Promise<void> {
  preferencesPath = join(app.getPath('userData'), 'preferences.json');
  preferences = loadPreferences(preferencesPath);
  journal = resolve(argValue('--journal') ?? preferences.journal ?? defaultJournalDir());
  if (seedJournal(DEMO_JOURNAL, journal)) {
    console.log(`Created journal at ${journal} with ${countLessons(journal)} demo lesson(s).`);
  }

  const token = randomBytes(32).toString('hex');
  checker = new ReleaseChecker({
    currentVersion: app.getVersion(),
    url: process.env['HORNBOOK_RELEASES_URL']?.trim() || undefined,
  });
  configureUpdater();
  server = startServer({
    port: 0,
    host: '127.0.0.1',
    journal,
    dist: join(appRoot, 'dist', 'hornbook', 'browser'),
    serveStatic: true,
    password: undefined,
    token,
    shell: 'electron',
    version: app.getVersion(),
    updates: checker,
    scriptDir: join(appRoot, 'dist', 'node', 'scripts'),
    childEnv: { ELECTRON_RUN_AS_NODE: '1' },
    childCwd: app.getPath('userData'),
    workDir: join(app.getPath('userData'), 'work'),
    onJobFinish: notifyJob,
    onJobsChanged: (count) => {
      activeJobs = count;
      rebuildTray();
    },
  });
  await new Promise<void>((resolveReady, reject) => {
    server?.once('listening', resolveReady);
    server?.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const desktopSession = session.fromPartition('persist:hornbook');
  desktopSession.webRequest.onBeforeSendHeaders({ urls: [`${baseUrl}/*`] }, (details, callback) => {
    details.requestHeaders['X-Hornbook-Token'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  desktopSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'notifications' && isAppOrigin(webContents.getURL()));
  });

  registerIpc();
  tray = new Tray(trayImage(false));
  tray.on('click', () => showWindow('/'));
  rebuildTray();
  createWindow();
  if (preferences.startWithSystem && (process.platform === 'win32' || process.platform === 'darwin')) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }
  setTimeout(() => void checkForUpdates(false), 2500).unref();
  setInterval(() => void checkForUpdates(false), UPDATE_POLL_MS).unref();
}

if (ownsInstance) {
  app.on('second-instance', (_event, commandLine) => {
    showWindow('/');
    const requested = argValue('--journal', commandLine);
    if (requested && journal && resolve(requested) !== journal) {
      void messageBox({
        type: 'info',
        message: 'Hornbook is already open with another journal.',
        detail: 'Quit Hornbook first, or change the journal from Application settings.',
      });
    }
  });
  app.on('activate', () => showWindow('/'));
  app.on('before-quit', (event) => {
    quitting = true;
    rememberWindowSize();
    if (shutdownComplete) return;
    event.preventDefault();
    void stopServer().then(() => app.quit(), (error: Error) => {
      quitting = false;
      dialog.showErrorBox('Hornbook could not stop background work', error.message);
    });
  });
  app.whenReady().then(start).catch((error: unknown) => {
    dialog.showErrorBox('Hornbook could not start', (error as Error).stack ?? (error as Error).message);
    app.quit();
  });
}
