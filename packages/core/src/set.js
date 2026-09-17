/**
 * A set of tags that merges, where adding beats removing.
 *
 * Each add carries its own id, called a tag. An element is in the set when it
 * has at least one tag that has not been removed.
 *
 * A remove can only remove the tags the remover could actually see. So if you
 * remove "urgent" while, at the same moment, someone else adds "urgent", their
 * add survives: their tag is new, and your remove never mentioned it.
 *
 * Add-wins is the safer default for a shared document. Losing a tag someone
 * just added is confusing; seeing one you thought you removed is merely
 * annoying, and one more click fixes it.
 */

/** @typedef {import('./id.js').Id} Id */
/** @typedef {import('./id.js').Clock} Clock */

/**
 * @typedef {object} AddOp
 * @property {'add'} type
 * @property {Id} id Doubles as the tag.
 * @property {string} value
 *
 * @typedef {object} RemoveOp
 * @property {'remove'} type
 * @property {Id} id
 * @property {string} value
 * @property {Id[]} tags The tags that were visible when the remove was made.
 *
 * @typedef {AddOp | RemoveOp} SetOp
 */

export class TagSet {
  /** @param {Clock} clock */
  constructor(clock) {
    /** @type {Clock} */
    this.clock = clock;
    /** @type {Map<string, {added: Set<Id>, removed: Set<Id>}>} */
    this.elements = new Map();
  }

  /**
   * @param {string} value
   * @returns {AddOp[]}
   */
  add(value) {
    /** @type {AddOp} */
    const op = { type: 'add', id: this.clock.next(), value };
    this.apply(op);
    return [op];
  }

  /**
   * @param {string} value
   * @returns {RemoveOp[]}
   */
  remove(value) {
    const entry = this.elements.get(value);
    if (!entry || entry.added.size === 0) return [];
    /** @type {RemoveOp} */
    const op = {
      type: 'remove',
      id: this.clock.next(),
      value,
      tags: [...entry.added],
    };
    this.apply(op);
    return [op];
  }

  /**
   * @param {SetOp} op
   */
  apply(op) {
    this.clock.observe(op.id);
    const entry = this.entry(op.value);
    if (op.type === 'add') {
      entry.added.add(op.id);
    } else {
      // Recording removed tags even if their adds have not arrived yet keeps
      // this correct under out-of-order delivery: when the add turns up, its
      // tag is already known to be removed.
      for (const tag of op.tags) entry.removed.add(tag);
    }
  }

  /**
   * @param {string} value
   * @returns {{added: Set<Id>, removed: Set<Id>}}
   * @private
   */
  entry(value) {
    let found = this.elements.get(value);
    if (!found) {
      found = { added: new Set(), removed: new Set() };
      this.elements.set(value, found);
    }
    return found;
  }

  /**
   * @param {string} value
   * @returns {boolean}
   */
  has(value) {
    const entry = this.elements.get(value);
    if (!entry) return false;
    for (const tag of entry.added) if (!entry.removed.has(tag)) return true;
    return false;
  }

  /** @returns {string[]} Present tags, sorted so every device lists them alike. */
  values() {
    return [...this.elements.keys()].filter((value) => this.has(value)).sort();
  }

  /** @returns {object} */
  toJSON() {
    return {
      elements: [...this.elements].map(([value, entry]) => [
        value,
        [...entry.added],
        [...entry.removed],
      ]),
    };
  }

  /**
   * Take in another replica's whole state.
   *
   * Both halves only ever grow, so merging is the union of each: every tag ever
   * added, and every tag ever removed. An element is still present when it has
   * an added tag that nobody removed.
   *
   * @param {any} json State from `toJSON`.
   */
  mergeState(json) {
    for (const [value, added, removed] of json.elements ?? []) {
      const entry = this.entry(value);
      for (const tag of added) entry.added.add(tag);
      for (const tag of removed) entry.removed.add(tag);
    }
  }

  /**
   * @param {Clock} clock
   * @param {any} json
   * @returns {TagSet}
   */
  static fromJSON(clock, json) {
    const set = new TagSet(clock);
    for (const [value, added, removed] of json.elements ?? []) {
      set.elements.set(value, { added: new Set(added), removed: new Set(removed) });
    }
    return set;
  }
}
