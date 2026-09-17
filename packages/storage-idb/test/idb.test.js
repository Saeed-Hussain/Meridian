/**
 * The IndexedDB store, run against an in-process implementation of the browser
 * API (`fake-indexeddb`).
 *
 * This is not as good as running in a real browser, and it is much better than
 * not testing it at all: it exercises the real transaction and event flow,
 * which is where the mistakes in IndexedDB code actually live. A browser check
 * belongs with the web app in week 9.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { open } from '@meridian/core';
import { storeContract } from '@meridian/core/testing';
import { IdbStore } from '../src/index.js';

let counter = 0;

/**
 * A fresh database per test, reopenable within it.
 *
 * One factory per place, so the databases are genuinely separate rather than
 * sharing a namespace and quietly leaking into each other.
 *
 * @returns {() => Promise<IdbStore>}
 */
function place() {
  const factory = new IDBFactory();
  const name = `doc-${(counter += 1)}`;
  return () => IdbStore.open(name, factory);
}

storeContract('IdbStore', place);

test('IdbStore: refuses to run where IndexedDB does not exist', async () => {
  await assert.rejects(
    () => IdbStore.open('x', /** @type {any} */ (undefined)),
    /no IndexedDB/,
  );
});

test('IdbStore: reopening the same database keeps the data', async () => {
  const reopen = place();
  const first = await open(await reopen());
  first.doc.insert(0, 'kept');
  await first.saved.close();

  const second = await open(await reopen());
  assert.equal(second.doc.toString(), 'kept');
  await second.saved.close();
});
