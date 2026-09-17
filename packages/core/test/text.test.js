/**
 * Text editing on one device, and the specific merge cases that are easy to
 * get wrong. The wide random testing lives in convergence.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '../src/index.js';

test('typing and reading back', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'Hello');
  assert.equal(doc.toString(), 'Hello');
  doc.insert(5, ' world');
  assert.equal(doc.toString(), 'Hello world');
  doc.insert(5, ',');
  assert.equal(doc.toString(), 'Hello, world');
  doc.insert(0, '> ');
  assert.equal(doc.toString(), '> Hello, world');
});

test('deleting', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'Hello world');
  doc.delete(5, 6);
  assert.equal(doc.toString(), 'Hello');
  assert.equal(doc.text.length, 5);
});

test('typing after a deletion lands in the right place', () => {
  // The bug this guards against: counting hidden letters when working out
  // where a new letter goes. It looks correct until something is deleted.
  const doc = new Doc('aaaa');
  doc.insert(0, 'abcdef');
  doc.delete(1, 3); // hides bcd, leaving "aef"
  assert.equal(doc.toString(), 'aef');
  doc.insert(1, 'X');
  assert.equal(doc.toString(), 'aXef');
});

test('deleting twice does nothing the second time', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');
  const ops = doc.delete(1, 1);
  assert.equal(doc.toString(), 'ac');
  doc.receive(ops); // as if a peer resent it
  assert.equal(doc.toString(), 'ac');
});

test('empty edits are allowed and do nothing', () => {
  const doc = new Doc('aaaa');
  assert.deepEqual(doc.insert(0, ''), []);
  assert.deepEqual(doc.delete(0, 0), []);
  assert.equal(doc.toString(), '');
});

test('editing outside the document is refused', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'abc');
  assert.throws(() => doc.insert(4, 'x'), RangeError);
  assert.throws(() => doc.insert(-1, 'x'), RangeError);
  assert.throws(() => doc.delete(2, 5), RangeError);
});

test('two devices typing in the same place agree', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'ab');
  a.syncTo(b);
  assert.equal(b.toString(), 'ab');

  // Both insert at position 1 without seeing each other.
  a.insert(1, 'X');
  b.insert(1, 'Y');
  a.syncTo(b);
  b.syncTo(a);

  assert.equal(a.toString(), b.toString());
  assert.match(a.toString(), /^a(XY|YX)b$/);
});

test('a typed run is not broken up by someone else typing', () => {
  // The property that keeps results readable: whole words survive, so nobody
  // ever sees "hweolrllod".
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'ab');
  a.syncTo(b);

  a.insert(1, 'hello');
  b.insert(1, 'world');
  a.syncTo(b);
  b.syncTo(a);

  assert.equal(a.toString(), b.toString());
  assert.match(a.toString(), /^a(helloworld|worldhello)b$/);
});

test('changes that arrive before what they depend on are not lost', () => {
  // The network may deliver in any order. Feed the changes in backwards, which
  // is the worst case, and the result must still be right.
  const a = new Doc('aaaa');
  const ops = a.insert(0, 'abcdef');

  const b = new Doc('bbbb');
  b.receive([...ops].reverse());

  assert.equal(b.toString(), 'abcdef');
  assert.ok(b.text.settled(), 'nothing should still be held back');
});

test('a delete arriving before its letter is remembered', () => {
  const a = new Doc('aaaa');
  const inserts = a.insert(0, 'abc');
  const deletes = a.delete(1, 1);

  const b = new Doc('bbbb');
  b.receive(deletes); // arrives first
  assert.equal(b.toString(), '');
  b.receive(inserts);

  assert.equal(b.toString(), 'ac');
  assert.ok(b.text.settled());
});

test('receiving the same changes twice changes nothing', () => {
  const a = new Doc('aaaa');
  const ops = a.insert(0, 'hello');
  const b = new Doc('bbbb');
  b.receive(ops);
  b.receive(ops);
  b.receive([...ops].reverse());
  assert.equal(b.toString(), 'hello');
});

test('a long document does not overflow the stack', () => {
  // Reading order is a walk down a chain one level per letter, so a recursive
  // walk would die here. This test exists to keep it iterative.
  const doc = new Doc('aaaa');
  doc.insert(0, 'x'.repeat(20000));
  assert.equal(doc.text.length, 20000);
  assert.equal(doc.toString().length, 20000);
});

test('watchers are told about local and remote changes', () => {
  const doc = new Doc('aaaa');
  /** @type {number[]} */
  const counts = [];
  const stop = doc.onChange((ops) => counts.push(ops.length));

  doc.insert(0, 'abc');
  assert.deepEqual(counts, [3]);

  const other = new Doc('bbbb');
  other.insert(0, 'z');
  doc.receive(other.missing({}));
  assert.deepEqual(counts, [3, 1]);

  stop();
  doc.insert(0, 'q');
  assert.deepEqual(counts, [3, 1], 'stopped watching');
});
