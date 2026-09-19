/**
 * Does the thing people would actually install work?
 *
 * Everything else tests the source. This tests the built application: the real
 * binary, with its own sealed archive of files, driven through a debugging
 * port the way a browser is.
 *
 * It exists because of a bug it would have caught. The storage adapter was a
 * workspace dependency — a symlink to a folder outside the application — so it
 * did not make it into the archive. The installer produced an app that started
 * perfectly and failed the moment anybody opened a document. Every test passed
 * the whole time, because every test ran against the source.
 *
 *   npm run desktop:dist
 *   npm run packaged-check
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const EXE =
  process.env.MERIDIAN_EXE ??
  path.join('apps', 'desktop', 'dist', 'win-unpacked', 'Meridian.exe');
const PORT = Number(process.env.DEBUG_PORT ?? 9333);
const TEXT = 'typed into the installed application';

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
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}`);
    console.log(`         got      ${JSON.stringify(actual)}`);
  }
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An editor built on Electron sets this in every terminal it opens, and it
// makes the binary behave as a plain Node interpreter. Removing it is the
// same thing the application's own launcher does.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });

/** @type {import('puppeteer-core').Browser | null} */
let browser = null;

try {
  // Wait for the debugging port rather than sleeping for a guessed interval.
  for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
    await wait(500);
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: null,
      });
    } catch {
      // Not up yet.
    }
  }
  check('the application starts and can be reached', Boolean(browser), true);
  if (!browser) throw new Error('the application never opened its debugging port');

  const pages = await browser.pages();
  const page = pages[0];
  check('it opened a window', Boolean(page), true);

  // Go to a document. This is the step the missing adapter broke.
  const id = `packaged-${Date.now().toString(36)}`;
  const home = page.url().replace(/\/index\.html.*$/, '');
  await page.goto(`${home}/doc/index.html?id=${id}`, { waitUntil: 'networkidle2' });

  let editor = null;
  for (let attempt = 0; attempt < 40 && !editor; attempt += 1) {
    await wait(250);
    editor = await page.$('[data-editor]');
  }
  check('the editor opens', Boolean(editor), true);

  // Anything the page complained about on the way, which is where a missing
  // module would show up.
  const failed = await page.evaluate(
    () => document.body.textContent?.includes('failed to open') ?? false,
  );
  check('nothing failed to open', failed, false);

  await page.focus('[data-editor]');
  await page.keyboard.type(TEXT, { delay: 8 });
  await wait(1500);
  check(
    'typing works',
    await page.$eval('[data-editor]', (box) => box.value),
    TEXT,
  );

  // Reload, so the text has to come back out of the database rather than
  // out of memory.
  await page.reload({ waitUntil: 'networkidle2' });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    const value = await page.$eval('[data-editor]', (box) => box.value).catch(() => '');
    if (value === TEXT) break;
  }
  check(
    'and it is still there after a reload',
    await page.$eval('[data-editor]', (box) => box.value),
    TEXT,
  );

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
} finally {
  await browser?.disconnect();
  child.kill();
}

process.exit(failures === 0 ? 0 : 1);
