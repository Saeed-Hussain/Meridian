/**
 * The two-tab test, driven by a real browser.
 *
 * This is the demo the whole project builds towards, run as a check rather
 * than watched by hand:
 *
 *   1. open the same document in two tabs
 *   2. type in one, and see it appear in the other
 *   3. type in both at once, and see them agree
 *   4. cut one tab off, edit both, reconnect, and see them agree again
 *
 * It needs the signalling server and the web app running:
 *
 *   npm run signal
 *   npm run web
 *   npm run two-tabs
 *
 * This is the only test that exercises the WebRTC transport, because
 * RTCPeerConnection does not exist in Node. Everything below the transport is
 * already covered by the ordinary test suite.
 */

import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const docId = `t${Date.now().toString(36)}`;
const url = `${BASE}/doc/${docId}`;

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
 * Wait until a tab's text box says what we expect, or give up.
 *
 * Polling rather than a fixed sleep: a fixed sleep is either slow or flaky,
 * and on a real WebRTC connection the delay is genuinely variable.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {(text: string) => boolean} done
 * @param {number} [ms]
 * @returns {Promise<string>}
 */
async function until(page, done, ms = 15000) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.$eval('.paper', (box) => box.value);
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

/**
 * @param {import('puppeteer-core').Page} page
 * @param {string} text
 */
async function type(page, text) {
  await page.focus('.paper');
  await page.keyboard.type(text, { delay: 12 });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

try {
  console.log(`document ${docId}\n`);

  // Ask for the page once before timing anything. In development Next compiles
  // a route the first time it is requested, and that delay landed inside the
  // concurrent-edit check -- which then failed for being slow rather than for
  // being wrong. Warming it up first makes the test measure the app.
  await fetch(url).catch(() => {});

  // Separate browser contexts, so the two tabs get separate storage. Two tabs
  // of one profile share an IndexedDB, which would make this a test of one
  // device talking to itself rather than of two devices syncing.
  const contextOne = await browser.createBrowserContext();
  const contextTwo = await browser.createBrowserContext();
  const one = await contextOne.newPage();
  const two = await contextTwo.newPage();
  for (const [name, page] of [['tab one', one], ['tab two', two]]) {
    page.on('pageerror', (error) => console.log(` ${name} error: ${error.message}`));
  }

  await one.goto(url, { waitUntil: 'networkidle2' });
  await two.goto(url, { waitUntil: 'networkidle2' });

  // Wait for the two tabs to find each other through the signalling server.
  const met = await until(
    one,
    () => true,
    500,
  ).then(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const peers = await one.$$eval('.chip', (chips) => chips.length);
      if (peers > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  });
  check('the two tabs find each other', met, true);

  // 1. Typing in one appears in the other.
  await type(one, 'hello from tab one');
  const seen = await until(two, (text) => text.includes('tab one'));
  check('typing in one reaches the other', seen, 'hello from tab one');

  // 2. Both typing at once, in the same place, without losing either.
  await Promise.all([type(one, ' AAA'), type(two, ' BBB')]);
  const settledOne = await until(one, (text) => text.includes('AAA') && text.includes('BBB'));
  const settledTwo = await until(two, (text) => text === settledOne);
  if (!(settledOne.includes('AAA') && settledOne.includes('BBB'))) {
    // Print both sides, so a failure here says whether the edits were lost or
    // simply had not arrived yet. Those need completely different fixes.
    console.log(`         tab one: ${JSON.stringify(settledOne)}`);
    console.log(`         tab two: ${JSON.stringify(settledTwo)}`);
  }
  check('both edits survive', settledOne.includes('AAA') && settledOne.includes('BBB'), true);
  check('and the two tabs agree', settledTwo, settledOne);

  // 3. Offline, edit apart, reconnect, agree again. This is the promise.
  //
  // Asked for through the page rather than through the testing tool's offline
  // switch: that switch blocks web requests and leaves an established peer
  // connection running, so the two tabs carried on syncing and the test was
  // quietly proving nothing.
  await two.evaluate(() => globalThis.__meridian.offline());
  await new Promise((resolve) => setTimeout(resolve, 500));

  await type(one, ' [while apart: one]');
  await type(two, ' [while apart: two]');
  const apartOne = await one.$eval('.paper', (box) => box.value);
  const apartTwo = await two.$eval('.paper', (box) => box.value);
  check('they really did diverge', apartOne !== apartTwo, true);
  check('the offline tab kept working', apartTwo.includes('apart: two'), true);

  await two.evaluate(() => globalThis.__meridian.online());
  const healedTwo = await until(
    two,
    (text) => text.includes('apart: one') && text.includes('apart: two'),
    25000,
  );
  const healedOne = await until(one, (text) => text === healedTwo, 25000);
  check('both edits survived the split', healedTwo.includes('apart: one') && healedTwo.includes('apart: two'), true);
  check('and the tabs agree again', healedOne, healedTwo);

  // 4. What was typed survives a reload, from this device's own storage.
  await one.reload({ waitUntil: 'networkidle2' });
  const reloaded = await until(one, (text) => text.length > 0);
  check('the text survives a reload', reloaded, healedOne);

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
} finally {
  await browser.close();
}

process.exit(failures === 0 ? 0 : 1);
