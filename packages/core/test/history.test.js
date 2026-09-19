/**
 * Looking at the document as it was.
 *
 * History is replayed, never undone. Undoing needs an inverse for every kind
 * of change, and one wrong inverse corrupts the real document. Replaying
 * builds a separate copy and cannot touch the original at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '../src/index.js';
import { MemoryStore, open } from '../src/storage.js';
import { random, seedFromEnv } from '../src/random.js';

test('stepping back through what was typed', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');

  assert.equal(doc.at(0).toString(), '');
  assert.equal(doc.at(1).toString(), 'a');
  assert.equal(doc.at(2).toString(), 'ab');
  assert.equal(doc.at(3).toString(), 'abc');
});

test('the end of history is the document itself', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'hello world');
  doc.delete(5, 6);
  doc.setField('title', 'greeting');
  doc.addTag('draft');

  const now = doc.at(doc.historyLength);
  assert.equal(now.toString(), doc.toString());
  assert.equal(now.fields.get('title'), doc.fields.get('title'));
  assert.deepEqual(now.tags.values(), doc.tags.values());
});

test('deleted text is visible again earlier in history', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'keep this');
  const beforeDeleting = doc.historyLength;
  doc.delete(4, 5);

  assert.equal(doc.toString(), 'keep');
  assert.equal(doc.at(beforeDeleting).toString(), 'keep this');
});

test('asking beyond either end is safe', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');
  assert.equal(doc.at(-5).toString(), '');
  assert.equal(doc.at(999).toString(), 'abc');
});

test('looking at the past does not disturb the present', () => {
  // The whole reason for replaying rather than undoing.
  const doc = new Doc('aaaa');
  doc.insert(0, 'live document');
  const before = { text: doc.toString(), version: doc.version(), log: doc.log.size };

  for (let step = 0; step <= doc.historyLength; step += 1) doc.at(step);

  assert.equal(doc.toString(), before.text);
  assert.deepEqual(doc.version(), before.version);
  assert.equal(doc.log.size, before.log);
});

test('history from two people is in a sensible order', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'one ');
  a.syncTo(b);
  b.insert(4, 'two ');
  b.syncTo(a);
  a.insert(8, 'three');
  a.syncTo(b);

  // Both sides must agree about the past, not only about the present.
  const stepsA = a.historyOrder().map((op) => op.id);
  const stepsB = b.historyOrder().map((op) => op.id);
  assert.deepEqual(stepsA, stepsB, 'the same order on both devices');

  for (let step = 0; step <= a.historyLength; step += 1) {
    assert.equal(a.at(step).toString(), b.at(step).toString(), `step ${step}`);
  }
});

test('every point in history is a document that makes sense', () => {
  // The property that matters for the slider: a half-applied history must
  // never leave a letter stranded with no parent. Stamps guarantee it, since
  // a change always sorts after everything its writer had seen.
  const rng = random(seedFromEnv());
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');

  for (let round = 0; round < 12; round += 1) {
    for (const doc of [a, b]) {
      const length = doc.text.length;
      if (length === 0 || rng.float() < 0.7) {
        doc.insert(length === 0 ? 0 : rng.int(length + 1), rng.pick([...'abcde ']));
      } else {
        doc.delete(rng.int(length), 1);
      }
    }
    if (rng.float() < 0.5) {
      a.syncTo(b);
      b.syncTo(a);
    }
  }
  a.syncTo(b);
  b.syncTo(a);

  for (let step = 0; step <= a.historyLength; step += 1) {
    const past = a.at(step);
    assert.ok(past.text.settled(), `step ${step} left a letter with no parent`);
    assert.equal(past.toString(), b.at(step).toString(), `step ${step} disagrees`);
  }
});

test('history grows as the document is edited', () => {
  const doc = new Doc('aaaa');
  assert.equal(doc.historyLength, 0);
  doc.insert(0, 'ab');
  assert.equal(doc.historyLength, 2);
  doc.delete(0, 1);
  assert.equal(doc.historyLength, 3);
});

test('compacting ends history at the trim point, honestly', async () => {
  // Worth a test of its own because it is a real limitation, not a bug: the
  // changes are gone, so there is nothing left to replay. What matters is that
  // the document is still correct and says how far back it can go.
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);
  doc.insert(0, 'old work');
  await saved.compact();

  assert.equal(doc.historyLength, 0, 'nothing left to step through');
  assert.equal(doc.toString(), 'old work', 'the document itself is intact');
  assert.equal(
    doc.at(0).toString(),
    'old work',
    'and the earliest view is the trim point, not an empty document',
  );

  doc.insert(8, ' and new');
  assert.equal(doc.historyLength, 8, 'history restarts from the trim point');
  assert.equal(doc.at(0).toString(), 'old work');
  assert.equal(doc.at(8).toString(), 'old work and new');

  // The floor survives a reload, because the saved state is the floor.
  await saved.flush();
  const reopened = await open(store);
  assert.equal(reopened.doc.at(0).toString(), 'old work');
  assert.equal(reopened.doc.toString(), 'old work and new');
});
