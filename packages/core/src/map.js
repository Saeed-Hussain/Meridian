/**
 * Named fields that merge: the title, a colour, a setting.
 *
 * The rule is "last writer wins", where "last" means the higher id, not the
 * later clock time. Two devices that set the title while offline will both end
 * up showing the same one — the one whose id sorts higher — and the other value
 * is dropped.
 *
 * That loss is the correct trade for a single field. There is no sensible way
 * to merge two titles, so the only thing that matters is that everyone loses
 * the same one.
 */

import { compareIds } from './id.js';

/** @typedef {import('./id.js').Id} Id */
/** @typedef {import('./id.js').Clock} Clock */

/**
 * @typedef {object} SetFieldOp
 * @property {'field'} type
 * @property {Id} id
 * @property {string} key
 * @property {any} value
 */

export class FieldMap {
  /** @param {Clock} clock */
  constructor(clock) {
    /** @type {Clock} */
    this.clock = clock;
    /** @type {Map<string, {value: any, id: Id}>} */
    this.entries = new Map();
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {SetFieldOp[]}
   */
  set(key, value) {
    /** @type {SetFieldOp} */
    const op = { type: 'field', id: this.clock.next(), key, value };
    this.apply(op);
    return [op];
  }

  /**
   * @param {SetFieldOp} op
   */
  apply(op) {
    this.clock.observe(op.id);
    const current = this.entries.get(op.key);
    if (!current || compareIds(op.id, current.id) > 0) {
      this.entries.set(op.key, { value: op.value, id: op.id });
    }
  }

  /**
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    return this.entries.get(key)?.value;
  }

  /** @returns {Record<string, any>} */
  toObject() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, entry] of this.entries) out[key] = entry.value;
    return out;
  }

  /** @returns {object} */
  toJSON() {
    return { entries: [...this.entries].map(([k, e]) => [k, e.value, e.id]) };
  }

  /**
   * Take in another replica's whole state. Same rule as a single change: the
   * higher id wins, so merging is safe to repeat and order does not matter.
   *
   * @param {any} json State from `toJSON`.
   */
  mergeState(json) {
    for (const [key, value, id] of json.entries ?? []) {
      this.apply({ type: 'field', id, key, value });
    }
  }

  /**
   * @param {Clock} clock
   * @param {any} json
   * @returns {FieldMap}
   */
  static fromJSON(clock, json) {
    const map = new FieldMap(clock);
    for (const [key, value, id] of json.entries ?? []) {
      map.entries.set(key, { value, id });
    }
    return map;
  }
}
