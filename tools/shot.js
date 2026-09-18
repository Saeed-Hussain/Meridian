/**
 * A picture of two people editing the same document.
 *
 * Produces `docs/two-tabs.png`, the image the README opens with. A systems
 * project that nobody can see is a systems project nobody reads.
 */

import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const CHROME =
  process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const url = `${BASE}/doc/s${Date.now().toString(36)}`;

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
  await one.setViewport({ width: 900, height: 620 });
  await two.setViewport({ width: 900, height: 620 });

  await one.goto(url, { waitUntil: 'networkidle2' });
  await two.goto(url, { waitUntil: 'networkidle2' });

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

  await one.focus('.paper');
  await type(one, 'Meeting notes\n\nBoth of us are typing into this document at the same time.\n');
  await new Promise((resolve) => setTimeout(resolve, 900));

  await two.focus('.paper');
  await type(two, '\nThis line was written in the other window. It arrived here without\ntouching a server: the change went straight from one browser to the other.\n');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await one.screenshot({ path: 'docs/two-tabs.png' });
  console.log('wrote docs/two-tabs.png');
} finally {
  await browser.close();
}
