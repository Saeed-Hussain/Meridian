/**
 * The desktop application.
 *
 * Two jobs: show the interface, and give it a real database.
 *
 * ## Why the interface is served, not opened
 *
 * The obvious thing is `loadFile` on the exported page, and it does not work.
 * The exported HTML asks for `/_next/...`, and from a `file://` page a leading
 * slash means the root of the drive, so nothing loads and the window sits
 * blank with one misleading error in it.
 *
 * So the files are served from a private `app://` scheme instead. Absolute
 * paths resolve, and — just as important — the page gets a real, stable origin,
 * which is what browser storage is keyed on. A `file://` page has an opaque
 * origin, so its local storage can vanish between runs.
 *
 * ## Why the window is locked down
 *
 * The page it loads is the same one that runs on the web, and a peer on the
 * other side of a WebRTC connection can send it anything. In a browser that
 * page is sandboxed; in Electron the sandbox is something you have to ask for,
 * and the defaults used to hand a web page the whole of Node.
 *
 * So: no Node in the renderer, context isolation on, sandbox on, a policy that
 * refuses to load anything from elsewhere, and a preload that exposes four
 * functions rather than a module system.
 *
 * ## Why SQLite rather than the browser's own storage
 *
 * The web build keeps changes in IndexedDB, which works here too. SQLite is
 * used instead because this is a desktop application: the file is visible, can
 * be copied or backed up, and survives someone clearing browser data.
 */

const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Electron only takes the product name from the build configuration once the
// app is packaged. Unpackaged, it calls itself "Electron" and puts its data in
// a directory of that name -- shared with every other Electron app in
// development. Setting it here means the database lives in the same place
// whether the app was installed or started from source.
app.setName('Meridian');

/** The exported interface that lives next to this file. */
const PAGES = path.join(__dirname, '..', 'web');

/** Where the interface is served from. Invented, and private to this app. */
const ORIGIN = 'app://meridian';

/**
 * What the page is allowed to do.
 *
 * Scripts and styles from the bundle only. `connect-src` has to allow the
 * signalling server and the WebRTC machinery, which is the entire point of the
 * application, but nothing may be *loaded* from anywhere else.
 */
const POLICY = [
  "default-src 'self' app:",
  "script-src 'self' app: 'unsafe-inline'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "connect-src 'self' app: ws: wss: https: stun: turn:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/** One open database per document, closed with the application. */
const stores = new Map();

const TYPES = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain'],
]);

// Has to happen before the app is ready: the scheme needs the same privileges
// as https, or the page is treated as untrusted and Web Crypto -- which the
// encryption depends on -- is not available to it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/**
 * Serve the exported interface.
 */
function serveInterface() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const wanted = decodeURIComponent(url.pathname);

    // Resolve, then check the result is still inside the folder. Without this
    // a path with `..` in it would read anything on the disk.
    const target = path.join(PAGES, wanted === '/' ? 'index.html' : wanted);
    const inside = path.resolve(target);
    if (!inside.startsWith(path.resolve(PAGES))) {
      return new Response('no', { status: 403 });
    }

    const file = inside.endsWith(path.sep) ? path.join(inside, 'index.html') : inside;
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!response.ok) return new Response('not found', { status: 404 });

    return new Response(response.body, {
      headers: {
        'content-type': TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
        'content-security-policy': POLICY,
      },
    });
  });
}

/**
 * The SQLite store for a document, opened on first use.
 *
 * `@meridian/storage-sql` is an ES module and this file is CommonJS, so it is
 * loaded with a dynamic import rather than `require`.
 *
 * @param {string} id
 * @returns {Promise<any>}
 */
async function storeFor(id) {
  const existing = stores.get(id);
  if (existing) return existing;

  const { openSqlite } = await import('@meridian/storage-sql');
  // Under the per-user application data directory, which is where an
  // application may write without asking.
  const file = path.join(app.getPath('userData'), `doc-${safe(id)}.db`);
  const store = await openSqlite(file, { durable: true });
  stores.set(id, store);
  return store;
}

/**
 * A document id comes from whoever made the link, so it cannot be trusted as
 * part of a filename.
 *
 * @param {string} id
 * @returns {string}
 */
function safe(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'untitled';
}

/**
 * The store contract, one channel per method.
 *
 * Deliberately not a general "run this" channel. A single channel taking a
 * method name and arguments would be an open door from a page that talks to
 * strangers over the network into the process that can touch the disk.
 */
function serveStore() {
  ipcMain.handle('store:site', async (_event, id) => (await storeFor(id)).site());
  ipcMain.handle('store:read', async (_event, id) => (await storeFor(id)).read());
  ipcMain.handle('store:append', async (_event, id, ops) => (await storeFor(id)).append(ops));
  ipcMain.handle('store:replace', async (_event, id, snapshot) =>
    (await storeFor(id)).replace(snapshot),
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#0b0b0c',
    title: 'Meridian',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Links elsewhere open in the real browser rather than inside the app, where
  // they would carry the application's privileges.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault();
  });

  window.loadURL(`${ORIGIN}/index.html`);
  return window;
}

app.whenReady().then(() => {
  serveInterface();
  serveStore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  for (const store of stores.values()) await store.close?.();
  stores.clear();
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { ORIGIN, PAGES };
