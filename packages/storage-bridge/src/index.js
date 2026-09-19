/**
 * The store, as seen from inside the desktop window.
 *
 * The database itself lives in the application process, because the page is
 * not allowed near a disk — it talks to peers over the network, so it is
 * treated as untrusted. This is the other half of that arrangement: an object
 * that satisfies the ordinary store contract by passing each call across the
 * bridge the preload exposes.
 *
 * There is no cleverness here on purpose. It is deliberately a thin pass-through
 * so that "the desktop app saves correctly" reduces to "the SQLite store saves
 * correctly", which is already proven by the shared conformance kit — and this
 * adapter is run against that same kit rather than being trusted on the grounds
 * of looking simple.
 */

/** @typedef {import('@meridian/core/src/oplog.js').Op} Op */

/**
 * What the preload puts on the window.
 *
 * @typedef {object} Bridge
 * @property {(id: string) => Promise<string>} site
 * @property {(id: string) => Promise<{snapshot: object | null, ops: Op[]}>} read
 * @property {(id: string, ops: Op[]) => Promise<void>} append
 * @property {(id: string, snapshot: object) => Promise<void>} replace
 */

export class BridgeStore {
  /**
   * @param {string} id Which document, since one bridge serves them all.
   * @param {Bridge} bridge
   */
  constructor(id, bridge) {
    /** @type {string} */
    this.id = id;
    /** @type {Bridge} */
    this.bridge = bridge;
  }

  /**
   * Whether the page is running inside the desktop application.
   *
   * @returns {boolean}
   */
  static available() {
    return Boolean(/** @type {any} */ (globalThis).meridian?.store);
  }

  /**
   * The store for a document, or null in an ordinary browser.
   *
   * Returning null rather than throwing lets the caller fall back to the
   * browser's own storage without asking twice where it is running.
   *
   * @param {string} id
   * @returns {BridgeStore | null}
   */
  static open(id) {
    const bridge = /** @type {any} */ (globalThis).meridian?.store;
    return bridge ? new BridgeStore(id, bridge) : null;
  }

  /** @returns {Promise<string>} */
  site() {
    return this.bridge.site(this.id);
  }

  /** @returns {Promise<{snapshot: object | null, ops: Op[]}>} */
  read() {
    return this.bridge.read(this.id);
  }

  /**
   * @param {Op[]} ops
   * @returns {Promise<void>}
   */
  async append(ops) {
    if (ops.length === 0) return;
    // Everything crossing the bridge is copied by the structured clone
    // algorithm, which refuses anything it cannot copy. The changes are plain
    // data already; this keeps it that way if that ever stops being true.
    await this.bridge.append(this.id, JSON.parse(JSON.stringify(ops)));
  }

  /**
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async replace(snapshot) {
    await this.bridge.replace(this.id, JSON.parse(JSON.stringify(snapshot)));
  }
}
