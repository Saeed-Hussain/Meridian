/**
 * How fast is it, and where does it stop being fast?
 *
 * Numbers rather than adjectives. Every claim about performance in the README
 * comes from this file, including the unflattering ones.
 *
 *   npm run bench
 *   SIZE=200000 npm run bench
 *
 * The measurement that matters is **the cost of one keystroke on a document
 * that is already large** — not the time to build that document, which nobody
 * waits for. A person typing wants the next character on screen before they
 * notice; the budget for that is one screen refresh, about 16ms.
 */

import { Doc } from '@meridian/core';
import { applyText } from '@meridian/core';

const SIZE = Number(process.env.SIZE ?? 100_000);
const SAMPLES = Number(process.env.SAMPLES ?? 200);

/**
 * @param {string} what
 * @param {() => void} work
 * @returns {number} Milliseconds.
 */
function time(what, work) {
  const started = performance.now();
  work();
  const took = performance.now() - started;
  console.log(`  ${what.padEnd(42)} ${took.toFixed(1).padStart(9)} ms`);
  return took;
}

/**
 * The middle and the worst of many samples.
 *
 * An average hides the case that matters. A keystroke that is usually fast and
 * occasionally takes half a second is not a fast editor, and only the worst
 * figure shows that.
 *
 * @param {string} what
 * @param {(step: number) => void} work
 * @param {number} [samples]
 */
function each(what, work, samples = SAMPLES) {
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    work(i);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const worst = times.at(-1) ?? 0;
  const budget = median < 16 ? '' : '   over one frame';
  console.log(
    `  ${what.padEnd(42)} ${median.toFixed(3).padStart(9)} ms median` +
      `   ${worst.toFixed(1)} ms worst${budget}`,
  );
}

console.log(`\nMeridian, ${SIZE.toLocaleString()} characters\n`);

// ------------------------------------------------------------------ building

const doc = new Doc('bench');
const built = time('build the document, one character at a time', () => {
  for (let i = 0; i < SIZE; i += 1) doc.insert(doc.text.length, 'x');
});
console.log(
  `  ${'  → per character'.padEnd(42)} ${((built / SIZE) * 1000).toFixed(1).padStart(9)} µs`,
);

console.log('');

// ------------------------------------------------------------------- reading

time('read the whole document as text', () => doc.toString());
time('read it again, unchanged', () => doc.toString());

console.log('');

// ------------------------------------------------- the cost of one keystroke

const end = doc.text.length;
each('type one character at the end', () => {
  doc.insert(doc.text.length, 'a');
});

each('type one character in the middle', () => {
  doc.insert(Math.floor(doc.text.length / 2), 'b');
});

each('delete one character in the middle', () => {
  doc.delete(Math.floor(doc.text.length / 2), 1);
});

// The whole round trip the editor makes on every keystroke: hand over the new
// text, work out the difference, apply it, and render the result back out.
//
// The render is part of the measurement on purpose. Leaving it out would move
// the cost to the next keystroke rather than remove it, and flatter the number
// without making anybody's typing faster.
let text = doc.toString();
each(
  'a keystroke, all the way through',
  () => {
    const at = Math.floor(text.length / 2);
    text = text.slice(0, at) + 'c' + text.slice(at);
    applyText(doc, text);
    text = doc.toString();
  },
  Math.min(SAMPLES, 60),
);

console.log('');

// -------------------------------------------------------------- the cursor

each('work out where the cursor is', (i) => {
  doc.text.anchorAt(i % doc.text.length);
});

each('turn a cursor back into a position', () => {
  doc.text.indexAfter(doc.text.anchorAt(Math.floor(doc.text.length / 2)));
});

console.log('');

// ------------------------------------------------------- saving and loading

const saved = time('save the whole document', () => JSON.stringify(doc.toJSON()));
const json = JSON.stringify(doc.toJSON());
time('load it back', () => Doc.fromJSON(JSON.parse(json)));

console.log('');

// ----------------------------------------------------------------- the size

const characters = doc.text.length;
const bytes = json.length;
console.log(`  ${'characters in the document'.padEnd(42)} ${characters.toLocaleString().padStart(9)}`);
console.log(`  ${'changes recorded'.padEnd(42)} ${doc.log.size.toLocaleString().padStart(9)}`);
console.log(`  ${'saved size'.padEnd(42)} ${(bytes / 1_048_576).toFixed(1).padStart(9)} MB`);
console.log(
  `  ${'  → per character'.padEnd(42)} ${(bytes / characters).toFixed(0).padStart(9)} bytes`,
);

const used = process.memoryUsage().heapUsed / 1_048_576;
console.log(`  ${'memory in use'.padEnd(42)} ${used.toFixed(0).padStart(9)} MB`);

// What compacting is worth. The change log holds one record per letter ever
// typed; the state holds one per letter still known about.
const { state } = doc.compact();
const compacted = JSON.stringify(state).length;
console.log(
  `  ${'saved size after compacting'.padEnd(42)} ${(compacted / 1_048_576).toFixed(1).padStart(9)} MB` +
    `   (${Math.round((1 - compacted / bytes) * 100)}% smaller)`,
);
console.log('');
