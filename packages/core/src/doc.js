/**
 * A document: text, named fields and tags, with one clock and one change log.
 *
 * This is the only class the rest of the app needs. It is deliberately the only
 * place where making a change and recording it happen together, so there is no
 * way to edit the document without the change being logged and therefore
 * syncable.
 */

import { Clock } from './id.js';
import { Text } from './text.js';
import { FieldMap } from './map.js';
import { TagSet } from './set.js';
import { OpLog } from './oplog.js';

/** @typedef {import('./oplog.js').Op} Op */
/** @typedef {import('./oplog.js').Version} Version */

export class Doc {
  /**
   * @param {string} [site] This device's id. Generated if not given.
   */
  constructor(site) {
    /** @type {Clock} */
    this.clock = new Clock(site);
    /** @type {Text} */
    this.text = new Text(this.clock);
    /** @type {FieldMap} */
    this.fields = new FieldMap(this.clock);
    /** @type {TagSet} */
    this.tags = new TagSet(this.clock);
    /** @type {OpLog} */
    this.log = new OpLog();
    /** @type {Set<(ops: Op[]) => void>} */
    this.listeners = new Set();
  }

  /** @returns {string} */
  get site() {
    return this.clock.site;
  }

  // ------------------------------------------------------------------ editing

  /**
   * @param {number} index
   * @param {string} value
   * @returns {Op[]} The changes made, already logged. Send these to peers.
   */
  insert(index, value) {
    return this.record(this.text.insert(index, value));
  }

  /**
   * @param {number} index
   * @param {number} [count]
   * @returns {Op[]}
   */
  delete(index, count = 1) {
    return this.record(this.text.delete(index, count));
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {Op[]}
   */
  setField(key, value) {
    return this.record(this.fields.set(key, value));
  }

  /**
   * @param {string} value
   * @returns {Op[]}
   */
  addTag(value) {
    return this.record(this.tags.add(value));
  }

  /**
   * @param {string} value
   * @returns {Op[]}
   */
  removeTag(value) {
    return this.record(this.tags.remove(value));
  }

  /**
   * @param {Op[]} ops
   * @returns {Op[]}
   * @private
   */
  record(ops) {
    for (const op of ops) this.log.add(op);
    if (ops.length > 0) this.emit(ops);
    return ops;
  }

  // -------------------------------------------------------------------- syncing

  /**
   * Take changes from somewhere else.
   *
   * Changes already known are skipped, so a peer may resend freely. Changes
   * that arrive before the ones they depend on are held inside `Text` until
   * they can be applied, so delivery order does not matter.
   *
   * @param {Op[]} ops
   * @returns {Op[]} The ones that were new.
   */
  receive(ops) {
    /** @type {Op[]} */
    const fresh = [];
    for (const op of ops) {
      if (!this.log.add(op)) continue;
      this.applyToState(op);
      fresh.push(op);
    }
    if (fresh.length > 0) this.emit(fresh);
    return fresh;
  }

  /**
   * @param {Op} op
   * @private
   */
  applyToState(op) {
    switch (op.type) {
      case 'insert':
      case 'delete':
        this.text.apply(/** @type {any} */ (op));
        break;
      case 'field':
        this.fields.apply(/** @type {any} */ (op));
        break;
      case 'add':
      case 'remove':
        this.tags.apply(/** @type {any} */ (op));
        break;
      default:
        // An unknown change is kept in the log and skipped here, so an older
        // build stays usable against documents written by a newer one instead
        // of refusing to open them.
        break;
    }
  }

  /**
   * What this device holds, to hand to a peer.
   * @returns {Version}
   */
  version() {
    return this.log.version();
  }

  /**
   * The changes a peer is missing.
   * @param {Version} theirs
   * @returns {Op[]}
   */
  missing(theirs) {
    return this.log.since(theirs);
  }

  /**
   * Push everything the other document is missing into it. Used in tests and
   * for two peers on one machine; real peers exchange the same two messages
   * over the network.
   *
   * If the other side is behind changes this one has trimmed away, whole state
   * is sent instead. Sending nothing would leave them silently wrong, which is
   * the worst outcome available.
   *
   * @param {Doc} other
   * @returns {number} Changes sent, or -1 when whole state was sent instead.
   */
  syncTo(other) {
    const theirs = other.version();
    if (this.log.tooFarBehind(theirs)) {
      other.mergeState(this.snapshot());
      return -1;
    }
    return other.receive(this.missing(theirs)).length;
  }

  /**
   * Take in another replica's whole state.
   *
   * Used when changes cannot be replayed one by one — after the other side has
   * compacted, or when a new device joins a long-lived document and replaying
   * its whole history would be wasteful.
   *
   * This is safe to apply repeatedly and in any order, for the same reason the
   * individual changes are: each part of the state only ever grows, and the
   * merge rules pick the same winner everywhere.
   *
   * @param {any} state From `snapshot()`.
   */
  mergeState(state) {
    this.text.mergeState(state.text);
    this.fields.mergeState(state.fields);
    this.tags.mergeState(state.tags);
    // Keep our own counter ahead of every id in their state, or we would hand
    // out an id that already exists.
    for (const [site, upto] of Object.entries(state.covers ?? {})) {
      this.clock.observe(`${upto}@${site}`);
    }
    this.log.absorb(state.covers ?? {});
    this.emit([]);
  }

  // ------------------------------------------------------------------- watching

  /**
   * @param {(ops: Op[]) => void} listener
   * @returns {() => void} Call to stop listening.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param {Op[]} ops
   * @private
   */
  emit(ops) {
    for (const listener of this.listeners) listener(ops);
  }

  // ------------------------------------------------------------------ snapshots

  /**
   * The whole document as plain data.
   *
   * The change log is included, which keeps history and sync working after a
   * reload. Trimming it is the job of a later snapshot step, and doing so
   * safely needs proof that every device has moved past the trimmed changes.
   *
   * @returns {object}
   */
  toJSON() {
    return { ...this.snapshot(), log: this.log.toJSON() };
  }

  /**
   * The document's state, without the list of changes that produced it.
   *
   * This is what gets saved when the change log is compacted, and what gets
   * sent to a peer that is too far behind for individual changes.
   *
   * @returns {object}
   */
  snapshot() {
    return {
      version: 1,
      clock: this.clock.toJSON(),
      text: this.text.toJSON(),
      fields: this.fields.toJSON(),
      tags: this.tags.toJSON(),
      covers: this.version(),
    };
  }

  /**
   * Rebuild from state alone. The document can be read, edited and synced, but
   * cannot hand out the individual changes that built it.
   *
   * @param {any} state From `snapshot()`.
   * @returns {Doc}
   */
  static fromSnapshot(state) {
    const doc = new Doc(state.clock.site);
    doc.clock = Clock.fromJSON(state.clock);
    doc.text = Text.fromJSON(doc.clock, state.text);
    doc.fields = FieldMap.fromJSON(doc.clock, state.fields);
    doc.tags = TagSet.fromJSON(doc.clock, state.tags);
    doc.log = new OpLog();
    doc.log.trimmed = { ...(state.covers ?? {}) };
    return doc;
  }

  /**
   * Throw away the individual changes, keeping the state.
   *
   * The caller is responsible for having saved the snapshot first. Returns it
   * so that saving and trimming cannot drift apart.
   *
   * @returns {{state: object, dropped: number}}
   */
  compact() {
    const state = this.snapshot();
    return { state, dropped: this.log.trim() };
  }

  /**
   * @param {any} json
   * @returns {Doc}
   */
  static fromJSON(json) {
    const doc = new Doc(json.clock.site);
    doc.clock = Clock.fromJSON(json.clock);
    doc.text = Text.fromJSON(doc.clock, json.text);
    doc.fields = FieldMap.fromJSON(doc.clock, json.fields);
    doc.tags = TagSet.fromJSON(doc.clock, json.tags);
    doc.log = OpLog.fromJSON(json.log);
    return doc;
  }

  /** @returns {string} */
  toString() {
    return this.text.toString();
  }
}
