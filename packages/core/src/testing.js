/**
 * The conformance kit for store adapters.
 *
 * This lives in `src`, not in a test file, because other packages import it.
 * Every adapter runs the same suite, so "correct" means one thing rather than
 * one thing per adapter -- which is how an adapter ends up quietly weaker than
 * the others.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from './storage.js';

export { random, shuffled, seedFromEnv } from './random.js';

/**
 * Every store adapter must pass this. It is exported so the SQLite and
 * IndexedDB packages can run it against themselves rather than writing their
 * own, slightly different, and therefore less useful version.
 *
 * @param {string} label
 * @param {() => () => Promise<import('./storage.js').Store>} makePlace
 *   Called once per test, and must hand back a fresh, empty place to store
 *   things — a new file, a new database name. The function it returns opens
 *   *that same* place again, which is how "close it and reopen it" is tested.
 *
 *   Two levels rather than one because both properties are needed: tests must
 *   not see each other's data, and a reopen inside one test must.
 */
export function storeContract(label, makePlace) {
  test(`${label}: saves and reloads a document`, async () => {
    const reopen = makePlace();
    const first = await open(await reopen());
    first.doc.insert(0, 'hello');
    first.doc.setField('title', 't');
    first.doc.addTag('x');
    await first.saved.close();

    const second = await open(await reopen());
    assert.equal(second.doc.toString(), 'hello');
    assert.equal(second.doc.fields.get('title'), 't');
    assert.deepEqual(second.doc.tags.values(), ['x']);
    assert.equal(second.doc.site, first.doc.site);
    await second.saved.close();
  });

  test(`${label}: storing the same change twice is harmless`, async () => {
    const store = await makePlace()();
    const { doc, saved } = await open(store);
    const ops = doc.insert(0, 'abc');
    await saved.flush();
    await store.append(ops);
    await store.append(ops);

    const { ops: stored } = await store.read();
    assert.equal(stored.length, 3, 'no duplicate rows');
    await saved.close();
  });

  test(`${label}: compacting keeps the document`, async () => {
    const reopen = makePlace();
    const first = await open(await reopen());
    first.doc.insert(0, 'hello world');
    first.doc.delete(5, 6);
    await first.saved.compact();
    await first.saved.close();

    const second = await open(await reopen());
    assert.equal(second.doc.toString(), 'hello');
    const { ops } = await second.saved.store.read();
    assert.equal(ops.length, 0, 'the changes were replaced by state');
    await second.saved.close();
  });

  test(`${label}: survives many edits`, async () => {
    const reopen = makePlace();
    const { doc, saved } = await open(await reopen());
    for (let i = 0; i < 500; i += 1) doc.insert(doc.text.length, 'x');
    await saved.flush();
    await saved.close();

    const reopened = await open(await reopen());
    assert.equal(reopened.doc.text.length, 500);
    await reopened.saved.close();
  });
}

