/**
 * Saving to disk.
 *
 * The rule this layer exists to keep: **a change is written to this device
 * before it is sent anywhere.** If the app dies a millisecond after you press a
 * key, that key must still be there when it reopens. A device that loses local
 * work is worse than one that cannot sync, because the user can see it.
 *
 * This file holds the contract and an in-memory version for tests. The real
 * adapters live in their own packages, so that the core never imports anything
 * from a browser or from Node.
 */

import { Doc } from './doc.js';

/** @typedef {import('./oplog.js').Op} Op */
/** @typedef {import('./oplog.js').Version} Version */

/**
 * What a place to save things has to provide.
 *
 * Every method may be slow, so all of them return promises. Writes must land
 * in the order they are given, which is what `Persistence` below guarantees so
 * that adapters do not each have to solve it.
 *
 * @typedef {object} Store
 * @property {() => Promise<string>} site
 *   This device's id, created and saved on first use. It must stay the same
 *   across restarts: a device that renames itself on every launch looks like a
 *   crowd of strangers to its peers, and its version vector grows forever.
 * @property {(ops: Op[]) => Promise<void>} append
 *   Add changes. Must ignore ones already stored, because a retry after a
 *   half-finished write is normal.
 * @property {() => Promise<{snapshot: object | null, ops: Op[]}>} read
 *   Everything needed to rebuild the document.
 * @property {(snapshot: object) => Promise<void>} replace
 *   Save the state and delete the stored changes, as one step. If this is not
 *   atomic, a crash in the middle loses the document.
 * @property {() => Promise<void>} [close]
 */

/**
 * Open a document from a store, and keep it saved from then on.
 *
 * @param {Store} store
 * @param {object} [options]
 * @param {string} [options.site]
 *   Use this device id instead of the store's own.
 *
 *   Needed because two browser tabs share one IndexedDB. Letting both adopt
 *   the stored id made them the same device: their change ids collided, each
 *   silently discarded the other's edits as a duplicate, and the two tabs
 *   quietly disagreed forever. Two tabs are two replicas, so they need two
 *   ids, even though they share a store.
 *
 * @returns {Promise<{doc: Doc, saved: Persistence}>}
 */
export async function open(store, options = {}) {
  const [stored, { snapshot, ops }] = await Promise.all([store.site(), store.read()]);
  const site = options.site ?? stored;

  // Built by merging rather than by loading. Loading a snapshot would adopt
  // whichever device wrote it -- which is right for a single device and wrong
  // for the second tab, whose own id must survive. Merging keeps our identity
  // and still recovers the clock, because the merge takes account of every id
  // of ours in the state.
  const doc = new Doc(site);
  if (snapshot) doc.mergeState(snapshot);
  if (ops.length > 0) doc.receive(ops);

  return { doc, saved: new Persistence(doc, store) };
}

/**
 * Writes every change to the store, in order, one at a time.
 *
 * Changes arrive from a plain function call that cannot wait, but writing to
 * disk can. So writes are queued. Without the queue, two edits in the same
 * millisecond would race, and on some stores the second would be lost.
 */
export class Persistence {
  /**
   * @param {Doc} doc
   * @param {Store} store
   */
  constructor(doc, store) {
    /** @type {Doc} */
    this.doc = doc;
    /** @type {Store} */
    this.store = store;
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
    /**
     * The first write error, kept rather than thrown into nowhere. A failing
     * disk must not be swallowed: the app needs to be able to tell the user
     * their work is not being saved.
     * @type {Error | null}
     */
    this.error = null;
    /** @type {number} */
    this.written = 0;

    this.stop = doc.onChange((ops) => {
      if (ops.length === 0) return; // whole-state merge, saved by compacting
      this.enqueue(async () => {
        await store.append(ops);
        this.written += ops.length;
      });
    });
  }

  /**
   * @param {() => Promise<void>} work
   * @private
   */
  enqueue(work) {
    this.queue = this.queue.then(work).catch((err) => {
      this.error = this.error ?? /** @type {Error} */ (err);
    });
  }

  /**
   * Wait for every queued write to finish, and raise the first failure.
   *
   * Tests await this; the app awaits it before telling the user their work is
   * safe, and before closing a window.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this.queue;
    if (this.error) throw this.error;
  }

  /**
   * Replace the stored changes with the current state.
   *
   * Worth being clear about the cost: afterwards this device can no longer
   * hand out the individual changes it dropped, so a peer that is behind the
   * trim point has to be sent whole state instead. `Doc.syncTo` detects that
   * and does so.
   *
   * @returns {Promise<number>} How many changes were dropped.
   */
  async compact() {
    await this.flush();
    const { state, dropped } = this.doc.compact();
    await this.store.replace(state);
    return dropped;
  }

  /** @returns {Promise<void>} */
  async close() {
    await this.flush();
    this.stop();
    await this.store.close?.();
  }
}

/**
 * A store that keeps everything in memory.
 *
 * Used by the tests, and by the "what if this were a fresh device" cases. It is
 * also the reference for what an adapter has to do: if a new adapter passes the
 * same tests as this one, it is correct.
 *
 * @implements {Store}
 */
export class MemoryStore {
  /** @param {string} [site] */
  constructor(site) {
    /** @type {string | undefined} */
    this.siteId = site;
    /** @type {Map<string, Op>} */
    this.ops = new Map();
    /** @type {object | null} */
    this.snapshot = null;
  }

  /** @returns {Promise<string>} */
  async site() {
    this.siteId ??= new Doc().site;
    return this.siteId;
  }

  /**
   * @param {Op[]} ops
   * @returns {Promise<void>}
   */
  async append(ops) {
    for (const op of ops) if (!this.ops.has(op.id)) this.ops.set(op.id, op);
  }

  /** @returns {Promise<{snapshot: object | null, ops: Op[]}>} */
  async read() {
    return { snapshot: this.snapshot, ops: [...this.ops.values()] };
  }

  /**
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async replace(snapshot) {
    this.snapshot = snapshot;
    this.ops.clear();
  }
}
