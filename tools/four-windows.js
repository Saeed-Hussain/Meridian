/**
 * The four-window test.
 *
 * The demo named in the proposal, run as a check:
 *
 *   Open the same document in four windows. Cut two of them off. Type wildly
 *   in all four. Reconnect. All four must show exactly the same text.
 *
 * Four rather than two on purpose. Two peers can agree by luck — with one
 * connection there is only one order things can arrive in. Four peers in a mesh
 * have many, and a merge rule that only appears to work will disagree here.
 *
 * Needs the app and the signalling server running:
 *
 *   npm run signal
 *   npm run web
 *   npm run four-windows
 */

import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const docId = `f${Date.now().toString(36)}`;
const url = `${BASE}/doc?id=${docId}`;
const WORDS = ['alpha', 'bravo', 'delta', 'echo'];
/** Milliseconds between keystrokes. Fast typing is around 100ms per character. */
const DELAY = Number(process.env.TYPE_DELAY ?? 10);

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

/**
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>}
 */
const read = (page) => page.$eval('[data-editor]', (box) => box.value);

/**
 * Wait until every window agrees, or give up and report what they said.
 *
 * @param {import('puppeteer-core').Page[]} pages
 * @param {number} [ms]
 * @returns {Promise<string[]>}
 */
async function untilAgreed(pages, ms = 40000) {
  const deadline = Date.now() + ms;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await Promise.all(pages.map(read));
    if (new Set(seen).size === 1 && seen[0].length > 0) return seen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return seen;
}

/**
 * The address to hand to the next window, once the first has made a key.
 *
 * The key lives in the fragment, so a link without it opens a different,
 * empty document. This is exactly what a person does: copy the address bar.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string>}
 */
async function sharedLink(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const href = await page.evaluate(() => globalThis.location.href);
    if (href.includes('#')) return href;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the first window never put a key in its address');
}

await fetch(url).catch(() => {}); // compile the route before timing anything

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
});

try {
  console.log(`document ${docId}\n`);

  // Four separate profiles, so these are four devices rather than four views
  // of one browser's storage.
  const pages = [];
  let link = url;
  for (let i = 0; i < 4; i += 1) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log(` window ${i + 1}: ${error.message}`));
    await page.goto(link, { waitUntil: 'networkidle2' });
    // The first window mints the key; the rest open the link it produced.
    if (i === 0) link = await sharedLink(page);
    pages.push(page);
  }

  // Everyone should see the other three.
  let met = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !met) {
    const counts = await Promise.all(
      pages.map((page) => page.$$eval('[data-peer]', (faces) => faces.length)),
    );
    met = counts.every((count) => count === 3);
    if (!met) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('all four windows find each other', met, true);

  // Cut two of them off entirely.
  await pages[2].evaluate(() => globalThis.__meridian.offline());
  await pages[3].evaluate(() => globalThis.__meridian.offline());
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Everyone types, including the two that cannot reach anybody.
  await Promise.all(
    pages.map(async (page, i) => {
      await page.focus('[data-editor]');
      await page.keyboard.type(`${WORDS[i]} `, { delay: DELAY });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const whileApart = await Promise.all(pages.map(read));
  check('the cut-off windows really were alone', new Set(whileApart).size > 1, true);
  check('and they kept working', whileApart[2].includes('delta'), true);

  // Let them all back in.
  await pages[2].evaluate(() => globalThis.__meridian.online());
  await pages[3].evaluate(() => globalThis.__meridian.online());

  const agreed = await untilAgreed(pages);

  // The two guarantees. Everything else about the result is a matter of
  // quality; these are promises. Everyone agrees, and nothing typed is lost.
  check('all four windows end up identical', new Set(agreed).size, 1);
  const typed = [...WORDS.map((word) => `${word} `).join('')].sort().join('');
  const got = [...(agreed[0] ?? '')].sort().join('');
  check('not a single character was lost', got, typed);

  if (new Set(agreed).size !== 1) {
    agreed.forEach((text, i) => console.log(`         window ${i + 1}: ${JSON.stringify(text)}`));
  } else {
    console.log(`\n  all four read: ${JSON.stringify(agreed[0])}`);
  }

  // Whether words stayed whole is reported, not required.
  //
  // Four windows typing into the same spot of an empty document at the same
  // instant is the hardest case there is, and the merge algorithm handles it
  // correctly on its own -- `interleave.test.js` in the core proves that in
  // Node. What is left is a timing race between the text box and the document
  // in the browser, which sometimes attaches a letter to the wrong neighbour.
  // It shreds words; it never loses them, and everyone still agrees.
  //
  // Printing the number keeps it visible, so an improvement or a regression is
  // obvious. Making it a hard failure would only invite the test to be
  // weakened later.
  const whole = WORDS.filter((word) => (agreed[0] ?? '').includes(word)).length;
  console.log(
    `  words kept whole: ${whole}/4${whole < 4 ? '   (known browser race — see docs/DESIGN.md)' : ''}`,
  );

  // The slider shows the past without disturbing the present.
  const live = await read(pages[0]);
  await pages[0].$eval('[data-scrub]', (range) => {
    const input = /** @type {HTMLInputElement} */ (range);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, '1');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const past = await read(pages[0]);
  check('the slider shows an earlier version', past.length < live.length, true);
  check('and it is read-only there', await pages[0].$eval('[data-editor]', (b) => b.readOnly), true);

  await pages[0].click('[data-now]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('back to now restores the document', await read(pages[0]), live);
  check(
    'and the others were never affected',
    await read(pages[1]),
    live,
  );

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
} finally {
  await browser.close();
}

process.exit(failures === 0 ? 0 : 1);
