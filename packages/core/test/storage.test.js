/**
 * Saving, reloading, crashing, and compacting.
 *
 * The promise being tested is simple to state: nothing the user typed is ever
 * lost. It is worth testing hard, because it is the failure a user can see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '../src/index.js';
import { MemoryStore, open } from '../src/storage.js';
import { storeContract } from '../src/testing.js';

test('a document survives being closed and reopened', async () => {
  const store = new MemoryStore('aaaa');

  const first = await open(store);
  first.doc.insert(0, 'hello world');
  first.doc.setField('title', 'greeting');
  first.doc.addTag('draft');
  await first.saved.close();

  const second = await open(store);
  assert.equal(second.doc.toString(), 'hello world');
  assert.equal(second.doc.fields.get('title'), 'greeting');
  assert.deepEqual(second.doc.tags.values(), ['draft']);
});

test('the device keeps the same id across restarts', async () => {
  // A device that renames itself every launch looks like a crowd of strangers
  // to its peers, and its version vector grows without limit.
  const store = new MemoryStore();
  const first = await open(store);
  const site = first.doc.site;
  await first.saved.close();

  const second = await open(store);
  assert.equal(second.doc.site, site);
});

test('reopening does not reuse a change id', async () => {
  const store = new MemoryStore('aaaa');
  const first = await open(store);
  first.doc.insert(0, 'abc');
  await first.saved.flush();

  const second = await open(store);
  const ops = second.doc.insert(3, 'd');

  const before = new Set((await store.read()).ops.map((op) => op.id));
  assert.equal(before.has(ops[0].id), false, 'the new id must be fresh');
});

test('a crash loses nothing that was written', async () => {
  // The crash is modelled by throwing the document away without closing it,
  // exactly as a killed process does, and then reopening the same store.
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);

  doc.insert(0, 'work in progress');
  await saved.flush(); // the write reached the store; now the process "dies"

  const recovered = await open(store);
  assert.equal(recovered.doc.toString(), 'work in progress');
});

test('a crash mid-write loses only what had not been written', async () => {
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);

  doc.insert(0, 'saved');
  await saved.flush();
  doc.insert(5, ' not yet'); // queued, never flushed

  // Reading the store directly is what a restart would see.
  const { ops } = await store.read();
  const cold = new Doc('bbbb');
  cold.receive(ops);
  assert.ok(cold.toString().startsWith('saved'));
  assert.ok(
    cold.toString().length < doc.toString().length,
    'unflushed work is not in the store, which is expected',
  );
});

test('writes are stored in order, not raced', async () => {
  // A slow store with random delays. Without the queue in Persistence, these
  // writes would interleave and the last one could be lost.
  /** @type {string[]} */
  const order = [];
  const inner = new MemoryStore('aaaa');
  /** @type {any} */
  const slow = {
    site: () => inner.site(),
    read: () => inner.read(),
    replace: (/** @type {object} */ s) => inner.replace(s),
    append: async (/** @type {any[]} */ ops) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      order.push(ops[0].id);
      return inner.append(ops);
    },
  };

  const { doc, saved } = await open(slow);
  /** @type {string[]} */
  const expected = [];
  for (let i = 0; i < 12; i += 1) {
    expected.push(doc.insert(i, 'x')[0].id);
  }
  await saved.flush();

  assert.deepEqual(order, expected, 'writes landed in the order they were made');
  assert.equal(saved.written, 12);
});

test('a write failure is reported, not swallowed', async () => {
  const inner = new MemoryStore('aaaa');
  /** @type {any} */
  const broken = {
    site: () => inner.site(),
    read: () => inner.read(),
    replace: () => Promise.reject(new Error('disk full')),
    append: () => Promise.reject(new Error('disk full')),
  };

  const { doc, saved } = await open(broken);
  doc.insert(0, 'x');
  await assert.rejects(() => saved.flush(), /disk full/);
});

// ----------------------------------------------------------------- compacting

test('compacting keeps the document and drops the changes', async () => {
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);
  doc.insert(0, 'hello world');
  doc.delete(5, 6);

  const dropped = await saved.compact();
  assert.ok(dropped > 0);

  const stored = await store.read();
  assert.equal(stored.ops.length, 0, 'changes are gone');
  assert.ok(stored.snapshot, 'state is saved');

  const reopened = await open(store);
  assert.equal(reopened.doc.toString(), 'hello');
});

test('a compacted document still reports everything it holds', async () => {
  // If compacting reset the summary, peers would resend the whole history.
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);
  doc.insert(0, 'abcdef');
  const before = doc.version();

  await saved.compact();
  assert.deepEqual(doc.version(), before);

  const reopened = await open(store);
  assert.deepEqual(reopened.doc.version(), before);
});

test('a compacted document can still be edited and synced', async () => {
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);
  doc.insert(0, 'abc');
  await saved.compact();

  const peer = new Doc('bbbb');
  doc.syncTo(peer); // whole state, since the changes are gone
  assert.equal(peer.toString(), 'abc');

  doc.insert(3, 'd'); // a normal change after compacting
  doc.syncTo(peer);
  assert.equal(peer.toString(), 'abcd');

  peer.insert(0, 'Z');
  peer.syncTo(doc);
  assert.equal(doc.toString(), peer.toString());
});

test('a peer behind the trim point is sent whole state, not silence', async () => {
  // The bug this guards against is the worst kind: sync reports success,
  // sends nothing, and the peer stays quietly wrong forever.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');

  a.insert(0, 'first');
  a.syncTo(b);
  a.insert(5, ' second');
  a.compact(); // b never saw " second", and now it cannot be replayed

  assert.ok(a.log.tooFarBehind(b.version()), 'a knows b is too far behind');
  assert.equal(a.syncTo(b), -1, 'whole state was sent');
  assert.equal(b.toString(), 'first second');
  assert.equal(a.toString(), b.toString());
});

test('merging whole state does not lose local work', async () => {
  // The dangerous shortcut here would be to overwrite the local document with
  // the incoming state. That is why this is a merge and not a load.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'shared');
  a.syncTo(b);

  b.insert(6, ' local'); // b's own work, which a has never seen
  a.insert(0, 'A');
  a.compact();

  a.syncTo(b);
  assert.ok(b.toString().includes('local'), 'local work survived the merge');
  assert.ok(b.toString().includes('A'), 'incoming work arrived');

  b.syncTo(a);
  assert.equal(a.toString(), b.toString(), 'both sides agree in the end');
});

test('merging the same state twice changes nothing', async () => {
  const a = new Doc('aaaa');
  a.insert(0, 'hello');
  a.delete(0, 1);
  const state = a.snapshot();

  const b = new Doc('bbbb');
  b.mergeState(state);
  const once = b.toString();
  b.mergeState(state);
  b.mergeState(state);
  assert.equal(b.toString(), once);
  assert.equal(once, 'ello');
});

test('a deletion is never undone by older state', async () => {
  // Deleting only goes one way. A state that predates the deletion must not
  // bring the letter back.
  const a = new Doc('aaaa');
  a.insert(0, 'abc');
  const early = a.snapshot(); // taken before the deletion

  const b = new Doc('bbbb');
  b.mergeState(a.snapshot());
  b.delete(1, 1);
  assert.equal(b.toString(), 'ac');

  b.mergeState(early); // the older state arrives late
  assert.equal(b.toString(), 'ac', 'the letter stays deleted');
});

test('compacting is safe to repeat', async () => {
  const store = new MemoryStore('aaaa');
  const { doc, saved } = await open(store);
  doc.insert(0, 'abc');

  assert.ok((await saved.compact()) > 0);
  assert.equal(await saved.compact(), 0, 'nothing left to drop');
  assert.equal(doc.toString(), 'abc');

  const reopened = await open(store);
  assert.equal(reopened.doc.toString(), 'abc');
});

test('a fresh device can be built from another device\'s state alone', async () => {
  const a = new Doc('aaaa');
  a.insert(0, 'a long document');
  a.compact();

  const joiner = Doc.fromSnapshot(a.snapshot());
  assert.equal(joiner.toString(), 'a long document');

  joiner.insert(0, '> ');
  joiner.syncTo(a);
  assert.equal(a.toString(), '> a long document');
});

// The in-memory store is the reference implementation: if a new adapter passes
// the same kit, it is correct.
storeContract('MemoryStore', () => {
  const store = new MemoryStore('aaaa');
  return async () => store;
});
