/**
 * Does the application actually work?
 *
 * Starts it with no window shown, waits for the page, types into the document
 * through the real interface, then reopens it and checks the text came back
 * from the SQLite file. A running process proves nothing on its own.
 *
 *   npm run desktop:check
 */

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { ORIGIN } = require('./main.cjs');

const DOC = 'probe-document';
const TEXT = 'written by the probe';

/**
 * @param {BrowserWindow} window
 * @param {string} script
 * @returns {Promise<any>}
 */
const run = (window, script) => window.webContents.executeJavaScript(script, true);

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

/**
 * @param {string} what
 * @param {unknown} actual
 * @param {unknown} expected
 */
function check(what, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`);
  if (!ok) console.log(`         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`);
}

/**
 * Wait for something to appear on the page.
 *
 * The interface opens a database and a connection before it renders anything,
 * so the editor is not there the instant the page loads.
 *
 * @param {BrowserWindow} window
 * @param {string} selector
 * @returns {Promise<boolean>}
 */
async function waitFor(window, selector) {
  for (let i = 0; i < 60; i += 1) {
    const there = await run(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (there) return true;
    await wait(250);
  }
  return false;
}

app.whenReady().then(async () => {
  const [window] = BrowserWindow.getAllWindows();
  window.hide();

  // Anything the page complains about is worth seeing; otherwise a failure
  // here is just "the script threw" with no clue where.
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2 && !message.includes('Security Warning')) {
      console.log(`   page: ${message}  (${source}:${line})`);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) =>
    console.log(`   page died: ${details.reason}`),
  );

  // Through the app's own scheme, exactly as the application loads it. Opening
  // the file directly would not be the same test: the page would have a
  // different origin and its assets would not resolve.
  const page = `${ORIGIN}/doc/index.html?id=${DOC}`;

  // 1. The interface loads, and finds the bridge the preload put there.
  // Report anything the page throws, with a stack, before it takes the
  // renderer down with it.
  await window.webContents.executeJavaScript(
    `window.addEventListener('error', (e) => console.error('threw: ' + (e.error && e.error.stack || e.message)));
     window.addEventListener('unhandledrejection', (e) => console.error('rejected: ' + ((e.reason && e.reason.stack) || e.reason)));`,
    true,
  ).catch(() => {});

  await window.loadURL(page);
  await wait(1500);
  check('the page reaches the application', await run(window, 'Boolean(window.meridian?.desktop)'), true);
  check('the editor appears', await waitFor(window, '[data-editor]'), true);

  // 2. Typing goes into the document.
  await run(
    window,
    `(() => {
      const box = document.querySelector('[data-editor]');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(box, ${JSON.stringify(TEXT)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  await wait(2000);
  check('the text is in the editor', await run(window, "document.querySelector('[data-editor]').value"), TEXT);

  // 3. It came back from SQLite, not from memory.
  await window.loadURL('about:blank');
  await wait(500);
  await window.loadURL(page);
  await waitFor(window, '[data-editor]');
  await wait(1500);
  check(
    'and it is still there after reopening',
    await run(window, "document.querySelector('[data-editor]').value"),
    TEXT,
  );

  const database = path.join(app.getPath('userData'), `doc-${DOC}.db`);
  check('a database file was written', require('node:fs').existsSync(database), true);

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  app.exit(failures === 0 ? 0 : 1);
});
