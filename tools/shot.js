/**
 * A picture of two people editing the same document.
 *
 * Produces `docs/two-tabs.png`, the image the README opens with. A systems
 * project that nobody can see is a systems project nobody reads.
 */

import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const url = `${BASE}/doc?id=s${Date.now().toString(36)}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
});

/**
 * @param {import('puppeteer-core').Page} page
 * @param {string} text
 */
const type = (page, text) => page.keyboard.type(text, { delay: 8 });

try {
  // Separate contexts, so these really are two people rather than one browser
  // profile talking to itself through a shared database.
  const one = await (await browser.createBrowserContext()).newPage();
  const two = await (await browser.createBrowserContext()).newPage();

  // Pick the theme rather than inheriting whatever the machine prefers, so the
  // picture in the README is the same every time it is regenerated.
  const theme = process.env.THEME ?? 'dark';
  for (const page of [one, two]) {
    await page.evaluateOnNewDocument((value) => {
      try {
        localStorage.setItem('meridian-theme', value);
      } catch {
        // No storage, no remembered theme. The page still works.
      }
    }, theme);
  }
  await one.setViewport({ width: 900, height: 620 });
  await two.setViewport({ width: 900, height: 620 });

  await one.goto(url, { waitUntil: 'networkidle2' });

  // The key is in the fragment, so the second window has to open the link the
  // first one produced rather than the bare address.
  let link = url;
  for (let i = 0; i < 100; i += 1) {
    link = await one.evaluate(() => globalThis.location.href);
    if (link.includes('#')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await two.goto(link, { waitUntil: 'networkidle2' });

  await one.$eval('.name', (box) => {
    const input = /** @type {HTMLInputElement} */ (box);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, 'Saeed');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await two.$eval('.name', (box) => {
    const input = /** @type {HTMLInputElement} */ (box);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, 'Ali');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await one.focus('[data-editor]');
  await type(one, 'Meeting notes\n\nBoth of us are typing into this document at the same time.\n');
  await new Promise((resolve) => setTimeout(resolve, 900));

  await two.focus('[data-editor]');
  await type(two, '\nThis line was written in the other window. It arrived here without\ntouching a server: the change went straight from one browser to the other.\n');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await one.screenshot({ path: 'docs/two-tabs.png' });
  console.log('wrote docs/two-tabs.png');
} finally {
  await browser.close();
}
