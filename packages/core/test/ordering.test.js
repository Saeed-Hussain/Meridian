/**
 * Getting an edit in before someone else's arrives.
 *
 * A text box holds a typed character for a moment before the code that owns
 * the document hears about it. A change from a peer arriving inside that
 * moment lands on a document that does not yet contain what was just typed,
 * and the character then gets attached to the wrong neighbour.
 *
 * The hook tested here is the fix: a last chance to hand over what is still
 * being held, so the two edits are applied in the order they really happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, applyText } from '../src/index.js';

test('the hook runs before anything from elsewhere is applied', () => {
  const doc = new Doc('aaaa');
  /** @type {string[]} */
  const order = [];

  doc.onBeforeChange(() => order.push('flushed'));
  doc.onChange(() => order.push('applied'));

  const other = new Doc('bbbb');
  other.insert(0, 'x');
  doc.receive(other.missing({}));

  assert.deepEqual(order, ['flushed', 'applied']);
});

test('a local edit does not trigger it', () => {
  // Only changes from elsewhere can arrive at an awkward moment. Firing on a
  // local edit would mean asking the editor to flush the edit it is making.
  const doc = new Doc('aaaa');
  let flushes = 0;
  doc.onBeforeChange(() => {
    flushes += 1;
  });

  doc.insert(0, 'typed here');
  assert.equal(flushes, 0);
});

test('nothing to receive, nothing to flush', () => {
  const doc = new Doc('aaaa');
  let flushes = 0;
  doc.onBeforeChange(() => {
    flushes += 1;
  });

  doc.receive([]);
  assert.equal(flushes, 0);
});

test('whole state coming in flushes too', () => {
  const doc = new Doc('aaaa');
  let flushes = 0;
  doc.onBeforeChange(() => {
    flushes += 1;
  });

  const other = new Doc('bbbb');
  other.insert(0, 'from a snapshot');
  doc.mergeState(other.snapshot());

  assert.equal(flushes, 1);
});

test('a keystroke held back is not destroyed by an arriving change', () => {
  // The bug, reproduced. The editor is holding "AB" while the document still
  // says "A", and a peer's change arrives.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'A');
  a.syncTo(b);

  // Somebody else types, out of sight.
  b.insert(1, 'Z');
  const theirs = b.missing(a.version());

  // The box holds a character the document has not been told about.
  let box = 'AB';
  a.onBeforeChange(() => {
    applyText(a, box);
  });

  a.receive(theirs);
  box = a.toString();

  assert.ok(box.includes('B'), 'the held keystroke survived');
  assert.ok(box.includes('Z'), 'and so did theirs');

  // And both sides still agree once they have swapped everything.
  a.syncTo(b);
  b.syncTo(a);
  assert.equal(a.toString(), b.toString());
});

test('without the flush, the held keystroke is attached to the wrong letter', () => {
  // The same situation with no hook registered, kept as the counter-example.
  // Nothing is lost here either -- the document is never corrupted -- but the
  // character ends up next to whatever arrived rather than where it was typed,
  // which is what shredded words in the browser.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'A');
  a.syncTo(b);

  b.insert(1, 'Z');
  a.receive(b.missing(a.version()));

  // Only now does the editor get round to reporting what was typed, and the
  // document it is diffing against has moved on.
  applyText(a, 'ABZ');

  a.syncTo(b);
  b.syncTo(a);
  assert.equal(a.toString(), b.toString(), 'still converges either way');
});

test('unhooking stops the flushing', () => {
  const doc = new Doc('aaaa');
  let flushes = 0;
  const stop = doc.onBeforeChange(() => {
    flushes += 1;
  });

  const other = new Doc('bbbb');
  other.insert(0, 'one');
  doc.receive(other.missing({}));
  assert.equal(flushes, 1);

  stop();
  other.insert(0, 'two');
  doc.receive(other.missing(doc.version()));
  assert.equal(flushes, 1, 'no longer listening');
});
