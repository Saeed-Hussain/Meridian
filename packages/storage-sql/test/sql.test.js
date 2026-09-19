/**
 * The SQLite store, tested against a real database file on disk.
 *
 * Most of the work here is running the shared contract from the core package.
 * Writing a separate set of tests for each adapter would produce several
 * slightly different definitions of "correct", which is how one adapter ends up
 * quietly weaker than the others.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open } from '@meridian/core';
import { storeContract } from '@meridian/core/testing';
import { SqlStore, openSqlite } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'meridian-sql-'));
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
 * A fresh database file per test, reopenable within it.
 * @returns {() => Promise<SqlStore>}
 */
function place() {
  const path = join(scratch, `doc-${(counter += 1)}.db`);
  return () => openSqlite(path);
}

storeContract('SqlStore', place);

test('SqlStore: the file really is written to disk', async () => {
  const reopen = place();
  const first = await open(await reopen());
  first.doc.insert(0, 'on disk');
  await first.saved.close(); // closes the database handle too

  // A brand new connection to the same file, which is what a restart is.
  const second = await open(await reopen());
  assert.equal(second.doc.toString(), 'on disk');
  await second.saved.close();
});

test('SqlStore: a batch of changes is stored or not stored, never half', async () => {
  const store = await openSqlite(':memory:');
  const good = { type: 'insert', id: '1@aaaa', parent: null, value: 'a' };
  /** @type {any} */
  const bad = { type: 'insert', id: null, parent: null, value: 'b' };

  await assert.rejects(() => store.append([good, bad]), 'a null id must be refused');

  const { ops } = await store.read();
  assert.equal(ops.length, 0, 'the good change was rolled back with the bad one');

  await store.append([good]);
  assert.equal((await store.read()).ops.length, 1, 'and the table still works');
  await store.close();
});

test('SqlStore: a second snapshot replaces the first', async () => {
  // The table allows one row by constraint, not by convention, so this would
  // fail loudly rather than silently growing.
  const store = await openSqlite(':memory:');
  await store.replace({ version: 1, marker: 'first' });
  await store.replace({ version: 1, marker: 'second' });

  const { snapshot } = await store.read();
  assert.equal(/** @type {any} */ (snapshot).marker, 'second');
  await store.close();
});

test('SqlStore: many changes stay fast', async () => {
  // Not a benchmark, a guard. Committing per change instead of per batch makes
  // this roughly an order of magnitude slower, and typing would feel it.
  const store = await openSqlite(':memory:');
  const { doc, saved } = await open(store);

  const started = performance.now();
  for (let i = 0; i < 2000; i += 1) doc.insert(doc.text.length, 'x');
  await saved.flush();
  const elapsed = performance.now() - started;

  assert.equal(doc.text.length, 2000);
  assert.ok(elapsed < 10000, `2000 edits took ${Math.round(elapsed)}ms`);
  console.log(`   2000 edits saved in ${Math.round(elapsed)}ms`);
  await saved.close();
});
