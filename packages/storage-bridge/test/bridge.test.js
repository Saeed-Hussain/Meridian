/**
 * The desktop store, run against the same conformance kit as the others.
 *
 * The bridge is tested here rather than only inside Electron because the part
 * that can be wrong is ordinary: whether it passes calls through faithfully.
 * A stand-in for the preload, wired to a real SQLite store, exercises exactly
 * the path the application uses — everything except the inter-process hop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open } from '@meridian/core';
import { storeContract } from '@meridian/core/testing';
import { openSqlite } from '@meridian/storage-sql';
import { BridgeStore } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'meridian-bridge-'));
process.on('exit', () => {
  // Best effort. Windows refuses to unlink a database file that is still open,
  // and a leftover file in the temporary directory is not worth failing a
  // passing test run over.
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Nothing to do about it, and nothing depends on it.
  }
});

let counter = 0;

/**
 * A stand-in for the preload: the same four calls, answered by a real SQLite
 * store, with everything serialised on the way through exactly as the real
 * bridge copies it between processes.
 *
 * @param {string} path
 * @returns {import('../src/index.js').Bridge}
 */
function bridgeTo(path) {
  /** @type {any} */
  let store = null;
  const reach = async () => (store ??= await openSqlite(path));
  /** @param {any} value */
  const copied = (value) => JSON.parse(JSON.stringify(value));

  return {
    site: async () => (await reach()).site(),
    read: async () => copied(await (await reach()).read()),
    append: async (_id, ops) => (await reach()).append(copied(ops)),
    replace: async (_id, snapshot) => (await reach()).replace(copied(snapshot)),
  };
}

/** @returns {() => Promise<BridgeStore>} */
function place() {
  const path = join(scratch, `doc-${(counter += 1)}.db`);
  return async () => new BridgeStore('doc', bridgeTo(path));
}

storeContract('BridgeStore', place);

test('BridgeStore: reports whether it is running in the application', () => {
  assert.equal(BridgeStore.available(), false, 'plain Node is not the desktop app');
  assert.equal(BridgeStore.open('doc'), null, 'and there is nothing to open');

  // What the preload does.
  /** @type {any} */ (globalThis).meridian = { store: bridgeTo(':memory:') };
  try {
    assert.equal(BridgeStore.available(), true);
    assert.ok(BridgeStore.open('doc') instanceof BridgeStore);
  } finally {
    delete /** @type {any} */ (globalThis).meridian;
  }
});

test('BridgeStore: an empty batch never crosses the bridge', async () => {
  // Every call is an inter-process round trip, so the cheapest one is the one
  // not made. A document emits empty batches during a whole-state merge.
  let calls = 0;
  const store = new BridgeStore('doc', {
    site: async () => 'aaaa',
    read: async () => ({ snapshot: null, ops: [] }),
    append: async () => {
      calls += 1;
    },
    replace: async () => {},
  });

  await store.append([]);
  assert.equal(calls, 0);
  await store.append([{ type: 'insert', id: '1@aaaa' }]);
  assert.equal(calls, 1);
});

test('BridgeStore: a document opened through the bridge behaves normally', async () => {
  const reopen = place();
  const first = await open(await reopen());
  first.doc.insert(0, 'typed in the desktop app');
  await first.saved.close();

  const second = await open(await reopen());
  assert.equal(second.doc.toString(), 'typed in the desktop app');
  await second.saved.close();
});
