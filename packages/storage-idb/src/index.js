/**
 * Saving a document to IndexedDB, for the browser.
 *
 * IndexedDB is the only browser store that holds a real amount of data, works
 * from a worker, and does not stringify everything into one blob that has to be
 * rewritten on every keystroke. `localStorage` fails all three.
 *
 * The API is old and callback-based, so the first half of this file is the
 * promise wrapper that makes the second half readable.
 */

/** @typedef {import('@meridian/core/src/oplog.js').Op} Op */

const DB_VERSION = 1;
const OPS = 'ops';
const META = 'meta';
const SNAPSHOT = 'snapshot';

/**
 * Turn one IndexedDB request into a promise.
 *
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Wait for a transaction to actually commit.
 *
 * Waiting on the individual requests is not enough: they can all report success
 * and the transaction can still fail to commit, for example when the disk is
 * full. Only `oncomplete` means the data is really stored.
 *
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function committed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export class IdbStore {
  /**
   * @param {IDBDatabase} db
   */
  constructor(db) {
    /** @type {IDBDatabase} */
    this.db = db;
  }

  /**
   * @param {string} [name] One database per document.
   * @param {IDBFactory} [factory] Overridable so tests can supply a stand-in.
   * @returns {Promise<IdbStore>}
   */
  static async open(name = 'meridian', factory = globalThis.indexedDB) {
    if (!factory) throw new Error('this browser has no IndexedDB');

    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Keyed by change id, so putting the same change twice overwrites rather
      // than duplicating.
      if (!db.objectStoreNames.contains(OPS)) db.createObjectStore(OPS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(SNAPSHOT)) db.createObjectStore(SNAPSHOT);
    };
    return new IdbStore(await promise(request));
  }

  /** @returns {Promise<string>} */
  async site() {
    const read = this.db.transaction(META, 'readonly');
    const existing = await promise(read.objectStore(META).get('site'));
    if (existing) return String(existing);

    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const site = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

    const write = this.db.transaction(META, 'readwrite');
    write.objectStore(META).put(site, 'site');
    await committed(write);
    return site;
  }

  /**
   * @param {Op[]} ops
   * @returns {Promise<void>}
   */
  async append(ops) {
    if (ops.length === 0) return;
    const tx = this.db.transaction(OPS, 'readwrite');
    const store = tx.objectStore(OPS);
    for (const op of ops) store.put(op, op.id);
    await committed(tx);
  }

  /** @returns {Promise<{snapshot: object | null, ops: Op[]}>} */
  async read() {
    const tx = this.db.transaction([OPS, SNAPSHOT], 'readonly');
    const [ops, snapshot] = await Promise.all([
      promise(tx.objectStore(OPS).getAll()),
      promise(tx.objectStore(SNAPSHOT).get('current')),
    ]);
    return { snapshot: snapshot ?? null, ops: ops ?? [] };
  }

  /**
   * Save the state and drop the stored changes in one transaction, so a crash
   * in between cannot lose the document.
   *
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async replace(snapshot) {
    const tx = this.db.transaction([OPS, SNAPSHOT], 'readwrite');
    tx.objectStore(SNAPSHOT).put(snapshot, 'current');
    tx.objectStore(OPS).clear();
    await committed(tx);
  }

  /** @returns {Promise<void>} */
  async close() {
    this.db.close();
  }
}
