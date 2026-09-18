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
    /**
     * Changes we hold the *result* of but can no longer produce one by one,
     * because a snapshot replaced them or they arrived as whole state.
     *
     * This is not bookkeeping for its own sake. Without it, a peer that is
     * behind the trim point would ask for changes that no longer exist, get
     * nothing back, and quietly stay wrong forever. `tooFarBehind` exists to
     * catch that case and send whole state instead.
     * @type {Version}
     */
    this.trimmed = {};
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

    // Counting gaps has to start from the trim point, not from zero. After
    // compacting, this device's next change is numbered just above what was
    // trimmed, so measuring from zero would see a hole that is not there and
    // the summary would never move past it.
    entry.upto = Math.max(entry.upto, this.trimmed[site] ?? 0);

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
    const out = { ...this.trimmed };
    for (const [site, entry] of this.seen) {
      out[site] = Math.max(out[site] ?? 0, entry.upto);
    }
    return out;
  }

  /**
   * True when a peer is so far behind that the changes it needs have been
   * trimmed away. The only correct answer then is to send whole state.
   *
   * @param {Version} theirs
   * @returns {boolean}
   */
  tooFarBehind(theirs) {
    for (const [site, upto] of Object.entries(this.trimmed)) {
      if ((theirs[site] ?? 0) < upto) return true;
    }
    return false;
  }

  /**
   * Drop the stored changes, keeping only the record that we hold their result.
   * The caller must have saved a snapshot of the state first, or the document
   * is lost.
   *
   * @returns {number} How many changes were dropped.
   */
  trim() {
    const dropped = this.ops.length;
    this.trimmed = this.version();
    this.ops = [];
    this.ids.clear();
    this.seen.clear();
    return dropped;
  }

  /**
   * Record that we now hold everything in another replica's state, without
   * holding its individual changes.
   *
   * @param {Version} theirs
   */
  absorb(theirs) {
    for (const [site, upto] of Object.entries(theirs)) {
      if (upto > (this.trimmed[site] ?? 0)) this.trimmed[site] = upto;

      // Changes held ahead of a gap may now be contiguous with the new trim
      // point, so let the summary move up over them.
      const entry = this.seen.get(site);
      if (!entry) continue;
      entry.upto = Math.max(entry.upto, this.trimmed[site]);
      while (entry.ahead.delete(entry.upto + 1)) entry.upto += 1;
    }
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
    return { ops: this.ops, trimmed: this.trimmed };
  }

  /**
   * @param {any} json
   * @returns {OpLog}
   */
  static fromJSON(json) {
    const log = new OpLog();
    log.trimmed = { ...(json.trimmed ?? {}) };
    for (const op of json.ops ?? []) log.add(op);
    return log;
  }
}
