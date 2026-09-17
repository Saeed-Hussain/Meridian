/**
 * The list of changes, and the summary used to sync.
 *
 * Two peers that meet need to answer one question quickly: what do you have
 * that I do not? Sending the whole document every time would work and would be
 * unusable on a slow connection.
 *
 * The answer is a small summary called a version vector: for each device, the
 * highest counter whose changes we hold with no gaps. Comparing two summaries
 * costs nothing, and the reply contains only the missing changes.
 */

import { parseId } from './id.js';

/** @typedef {import('./id.js').Id} Id */
/** @typedef {{type: string, id: Id} & Record<string, any>} Op */
/** @typedef {Record<string, number>} Version */

export class OpLog {
  constructor() {
    /** @type {Op[]} */
    this.ops = [];
    /** @type {Set<Id>} */
    this.ids = new Set();
    /**
     * Per device: the highest gap-free counter, plus any counters received
     * ahead of it. The vector can only advance to a gap-free point, or a peer
     * would conclude we hold changes we are actually still missing.
     * @type {Map<string, {upto: number, ahead: Set<number>}>}
     */
    this.seen = new Map();
  }

  /**
   * Record a change.
   * @param {Op} op
   * @returns {boolean} False if it was already known, so callers can skip work.
   */
  add(op) {
    if (this.ids.has(op.id)) return false;
    this.ids.add(op.id);
    this.ops.push(op);

    const { site, counter } = parseId(op.id);
    let entry = this.seen.get(site);
    if (!entry) {
      entry = { upto: 0, ahead: new Set() };
      this.seen.set(site, entry);
    }
    if (counter === entry.upto + 1) {
      entry.upto = counter;
      while (entry.ahead.delete(entry.upto + 1)) entry.upto += 1;
    } else if (counter > entry.upto) {
      entry.ahead.add(counter);
    }
    return true;
  }

  /**
   * @param {Id} id
   * @returns {boolean}
   */
  has(id) {
    return this.ids.has(id);
  }

  /**
   * What this device holds, as a summary to hand a peer.
   * @returns {Version}
   */
  version() {
    /** @type {Version} */
    const out = {};
    for (const [site, entry] of this.seen) out[site] = entry.upto;
    return out;
  }

  /**
   * The changes a peer is missing, given their summary.
   *
   * A change already held by the peer may still be included when it sits past
   * a gap in their history. That is a small amount of extra traffic in exchange
   * for a summary that stays tiny, and applying a change twice does nothing.
   *
   * @param {Version} theirs
   * @returns {Op[]}
   */
  since(theirs) {
    return this.ops.filter((op) => {
      const { site, counter } = parseId(op.id);
      return counter > (theirs[site] ?? 0);
    });
  }

  /** @returns {number} */
  get size() {
    return this.ops.length;
  }

  /** @returns {object} */
  toJSON() {
    return { ops: this.ops };
  }

  /**
   * @param {any} json
   * @returns {OpLog}
   */
  static fromJSON(json) {
    const log = new OpLog();
    for (const op of json.ops ?? []) log.add(op);
    return log;
  }
}
