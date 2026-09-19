/**
 * Turning text-box contents into changes, and keeping the cursor still.
 *
 * These two are what stand between a correct merge algorithm and an editor that
 * is actually usable. Both are pure logic, so they are tested here rather than
 * discovered by hand in a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, diff, applyText } from '../src/index.js';
import { random, seedFromEnv } from '../src/random.js';

// -------------------------------------------------------------------- diffing

test('typing one character', () => {
  assert.deepEqual(diff('abc', 'abxc'), { at: 2, removed: 0, added: 'x' });
});

test('deleting one character', () => {
  assert.deepEqual(diff('abc', 'ac'), { at: 1, removed: 1, added: '' });
});

test('replacing a selection', () => {
  assert.deepEqual(diff('the quick fox', 'the slow fox'), {
    at: 4,
    removed: 5,
    added: 'slow',
  });
});

test('no change at all', () => {
  assert.equal(diff('same', 'same'), null);
});

test('typing at the very start and the very end', () => {
  assert.deepEqual(diff('bc', 'abc'), { at: 0, removed: 0, added: 'a' });
  assert.deepEqual(diff('ab', 'abc'), { at: 2, removed: 0, added: 'c' });
});

test('repeated characters do not confuse the ends', () => {
  // The trap: "aa" -> "aaa" matches two characters at the start and two at the
  // end of a three-character string. Without a guard the ranges overlap and the
  // removed count goes negative.
  assert.deepEqual(diff('aa', 'aaa'), { at: 2, removed: 0, added: 'a' });
  assert.deepEqual(diff('aaa', 'aa'), { at: 2, removed: 1, added: '' });
  assert.deepEqual(diff('', 'a'), { at: 0, removed: 0, added: 'a' });
  assert.deepEqual(diff('a', ''), { at: 0, removed: 1, added: '' });
});

test('clearing and filling the whole box', () => {
  assert.deepEqual(diff('hello', ''), { at: 0, removed: 5, added: '' });
  assert.deepEqual(diff('', 'hello'), { at: 0, removed: 0, added: 'hello' });
});

test('a diff always rebuilds the new text', () => {
  // The property that matters, checked on random pairs rather than on the
  // handful of cases a person thinks of.
  const rng = random(seedFromEnv());
  const alphabet = 'abc ';
  for (let run = 0; run < 2000; run += 1) {
    let before = '';
    let after = '';
    for (let i = 0; i < rng.int(12); i += 1) before += rng.pick([...alphabet]);
    for (let i = 0; i < rng.int(12); i += 1) after += rng.pick([...alphabet]);

    const change = diff(before, after);
    const rebuilt = change
      ? before.slice(0, change.at) +
        change.added +
        before.slice(change.at + change.removed)
      : before;
    assert.equal(rebuilt, after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

// ----------------------------------------------------------- applying to a doc

test('applyText says where the edit happened', () => {
  // The editor needs this to place the cursor, because the text box cannot be
  // trusted for it straight after an edit.
  const doc = new Doc('aaaa');
  applyText(doc, 'hello');
  const { change } = applyText(doc, 'hello world');
  assert.deepEqual(change, { at: 5, removed: 0, added: ' world' });
  assert.equal(applyText(doc, 'hello world').change, null, 'no change, nothing to report');
});

test('applying text to a document', () => {
  const doc = new Doc('aaaa');
  applyText(doc, 'hello');
  assert.equal(doc.toString(), 'hello');
  applyText(doc, 'hello world');
  assert.equal(doc.toString(), 'hello world');
  applyText(doc, 'goodbye world');
  assert.equal(doc.toString(), 'goodbye world');
});

test('editing touches only what changed', () => {
  // The whole point of diffing. Replacing everything on each keystroke would
  // still read correctly on one machine while destroying anybody else's work
  // in the same paragraph.
  const doc = new Doc('aaaa');
  applyText(doc, 'the quick brown fox');
  const before = doc.log.size;

  applyText(doc, 'the quick brown foxes');
  assert.equal(doc.log.size - before, 2, 'two letters added, nothing else touched');
});

test('two people typing in the same line keep both edits', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  applyText(a, 'the fox');
  a.syncTo(b);

  // Each types a word without seeing the other, as a text box would report it.
  applyText(a, 'the quick fox');
  applyText(b, 'the brown fox');
  a.syncTo(b);
  b.syncTo(a);

  assert.equal(a.toString(), b.toString());
  assert.ok(a.toString().includes('quick'), 'a kept its word');
  assert.ok(a.toString().includes('brown'), 'b kept its word');
});

// -------------------------------------------------------------------- cursors

test('a cursor stays put when someone types before it', () => {
  // The most irritating bug in collaborative editors: your cursor jumps
  // because somebody edited further up the document.
  const doc = new Doc('aaaa');
  doc.insert(0, 'hello world');

  const anchor = doc.text.anchorAt(11); // at the very end
  assert.equal(doc.text.indexAfter(anchor), 11);

  const other = new Doc('bbbb');
  doc.syncTo(other);
  other.insert(0, 'oh, ');
  other.syncTo(doc);

  assert.equal(doc.toString(), 'oh, hello world');
  assert.equal(doc.text.indexAfter(anchor), 15, 'the cursor moved with the text');
});

test('a cursor survives the letter it sits after being deleted', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abcdef');
  const anchor = doc.text.anchorAt(3); // after "c"

  const other = new Doc('bbbb');
  doc.syncTo(other);
  other.delete(2, 1); // somebody else removes "c"
  other.syncTo(doc);

  assert.equal(doc.toString(), 'abdef');
  assert.equal(
    doc.text.indexAfter(anchor),
    2,
    'the cursor sits where the letter used to be',
  );
});

test('the start of the document is a valid anchor', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');
  assert.equal(doc.text.anchorAt(0), null);
  assert.equal(doc.text.indexAfter(null), 0);
});

test('an anchor round-trips at every position', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'hello world');
  doc.delete(5, 1); // a tombstone in the middle, to catch off-by-one errors

  for (let index = 0; index <= doc.text.length; index += 1) {
    const anchor = doc.text.anchorAt(index);
    assert.equal(doc.text.indexAfter(anchor), index, `position ${index}`);
  }
});

test('an unknown anchor lands at the end rather than the start', () => {
  // A cursor from a peer whose letters have not arrived yet. Jumping to the end
  // is wrong but harmless; jumping to the start would look like the document
  // had scrolled itself.
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');
  assert.equal(doc.text.indexAfter('99@zzzz'), 3);
});
