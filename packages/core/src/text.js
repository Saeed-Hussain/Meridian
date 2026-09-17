/**
 * The text merge algorithm.
 *
 * This is the part of Meridian that has to be correct. Everything else is
 * ordinary software.
 *
 * ## The idea
 *
 * The document is not stored as a string. It is stored as a tree of single
 * letters. Every letter has:
 *
 *   - its own permanent id, and
 *   - the id of the letter it was typed after (its parent).
 *
 * The text you read is the tree walked depth-first: a letter, then everything
 * typed after that letter, then the next sibling.
 *
 * Two rules make every device agree:
 *
 *   1. The tree is built only from ids and parents, which never change.
 *   2. When several letters share a parent — which is what a conflict is — they
 *      are sorted by id, newest first.
 *
 * Neither rule looks at arrival order, at wall clocks, or at who connected
 * first. So a device that receives changes in a strange order still ends up
 * with the same tree, and therefore the same text, as everyone else. Nothing
 * needs a server to decide.
 *
 * ## Why runs of typing stay together
 *
 * When you type "hello", each letter's parent is the letter before it, so the
 * word is a chain, not five siblings. If someone else types "world" in the same
 * spot, their chain hangs off the same parent as your `h`. The sort puts one
 * whole chain before the other, so the result is "helloworld" or "worldhello",
 * never "hweolrllod".
 *
 * This is the main reason the tree is built this way. It is not perfect — see
 * the note on interleaving at the bottom of this file — but it removes the ugly
 * case that users would actually notice.
 *
 * ## Deleting
 *
 * A deleted letter is marked hidden and kept. It cannot be removed, because
 * another device may still send a change that refers to it. A hidden letter is
 * called a tombstone. Dropping tombstones safely is a separate job, done later
 * by snapshots, once every device is known to have moved past them.
 */

import { compareIds } from './id.js';

/** @typedef {import('./id.js').Id} Id */
/** @typedef {import('./id.js').Clock} Clock */

/**
 * A single letter in the tree.
 * @typedef {object} Letter
 * @property {Id} id
 * @property {Id | null} parent Id of the letter this was typed after, or null for the start.
 * @property {string} value One character.
 * @property {boolean} deleted
 */

/**
 * A change to the text.
 * @typedef {object} InsertOp
 * @property {'insert'} type
 * @property {Id} id Doubles as the new letter's id.
 * @property {Id | null} parent
 * @property {string} value
 *
 * @typedef {object} DeleteOp
 * @property {'delete'} type
 * @property {Id} id This change's own id, needed so sync can track it.
 * @property {Id} target The letter being hidden.
 *
 * @typedef {InsertOp | DeleteOp} TextOp
 */

/** Key used for letters typed at the very start of the document. */
const ROOT = '';

export class Text {
  /**
   * @param {Clock} clock Shared with the rest of the document.
   */
  constructor(clock) {
    /** @type {Clock} */
    this.clock = clock;

    /** @type {Map<Id, Letter>} */
    this.letters = new Map();

    /**
     * Parent id (or ROOT) to the ids of letters typed directly after it, kept
     * sorted newest first.
     * @type {Map<string, Id[]>}
     */
    this.children = new Map();

    /**
     * Inserts that arrived before their parent did. Keyed by the parent we are
     * still waiting for, so they can be applied the moment it turns up.
     *
     * Without this, an out-of-order delivery would silently lose a letter, and
     * the network is allowed to deliver in any order it likes.
     * @type {Map<Id, InsertOp[]>}
     */
    this.waiting = new Map();

    /**
     * Deletes for letters we have not seen yet. A delete may legitimately
     * arrive before the insert it refers to.
     * @type {Set<Id>}
     */
    this.waitingDeletes = new Set();

    /**
     * Cached reading order, thrown away on any change. Rebuilt on demand so a
     * burst of edits costs one walk, not one per letter.
     * @type {Letter[] | null}
     */
    this.cache = null;
  }

  // ---------------------------------------------------------------- local edits

  /**
   * Type text at a position, as this device.
   *
   * Each letter's parent is the letter before it, which is what keeps a typed
   * run together when someone else is typing in the same place.
   *
   * @param {number} index Position in the visible text.
   * @param {string} value
   * @returns {InsertOp[]} Changes to save and send.
   */
  insert(index, value) {
    if (value === '') return [];
    const visible = this.visible();
    if (index < 0 || index > visible.length) {
      throw new RangeError(`insert out of range: ${index} of ${visible.length}`);
    }

    /** @type {Id | null} */
    let parent = index === 0 ? null : visible[index - 1].id;
    /** @type {InsertOp[]} */
    const ops = [];

    for (const character of value) {
      /** @type {InsertOp} */
      const op = {
        type: 'insert',
        id: this.clock.next(),
        parent,
        value: character,
      };
      this.applyInsert(op);
      ops.push(op);
      parent = op.id;
    }
    return ops;
  }

  /**
   * Hide text at a position, as this device.
   *
   * @param {number} index
   * @param {number} [count]
   * @returns {DeleteOp[]}
   */
  delete(index, count = 1) {
    if (count <= 0) return [];
    const visible = this.visible();
    if (index < 0 || index + count > visible.length) {
      throw new RangeError(
        `delete out of range: ${index}+${count} of ${visible.length}`,
      );
    }

    /** @type {DeleteOp[]} */
    const ops = [];
    for (const letter of visible.slice(index, index + count)) {
      /** @type {DeleteOp} */
      const op = { type: 'delete', id: this.clock.next(), target: letter.id };
      this.applyDelete(op);
      ops.push(op);
    }
    return ops;
  }

  // --------------------------------------------------------------- remote edits

  /**
   * Apply a change from anywhere, including from this device.
   *
   * Applying the same change twice must do nothing, because a peer is allowed
   * to send it twice.
   *
   * @param {TextOp} op
   */
  apply(op) {
    if (op.type === 'insert') this.applyInsert(op);
    else this.applyDelete(op);
  }

  /**
   * @param {InsertOp} op
   * @private
   */
  applyInsert(op) {
    if (this.letters.has(op.id)) return; // already have it

    // Hold on to it if its parent has not arrived yet.
    if (op.parent !== null && !this.letters.has(op.parent)) {
      const queue = this.waiting.get(op.parent);
      if (queue) {
        if (!queue.some((held) => held.id === op.id)) queue.push(op);
      } else {
        this.waiting.set(op.parent, [op]);
      }
      return;
    }

    this.clock.observe(op.id);

    /** @type {Letter} */
    const letter = {
      id: op.id,
      parent: op.parent,
      value: op.value,
      deleted: this.waitingDeletes.delete(op.id),
    };
    this.letters.set(op.id, letter);

    const key = op.parent ?? ROOT;
    const siblings = this.children.get(key);
    if (siblings) {
      // Newest first. A plain sort would also work; this inserts in place
      // because sibling lists are short and usually length one.
      let at = 0;
      while (at < siblings.length && compareIds(siblings[at], op.id) > 0) at += 1;
      siblings.splice(at, 0, op.id);
    } else {
      this.children.set(key, [op.id]);
    }

    this.cache = null;

    // This letter may be the parent some held-back changes were waiting for.
    const unblocked = this.waiting.get(op.id);
    if (unblocked) {
      this.waiting.delete(op.id);
      for (const held of unblocked) this.applyInsert(held);
    }
  }

  /**
   * @param {DeleteOp} op
   * @private
   */
  applyDelete(op) {
    this.clock.observe(op.id);
    const letter = this.letters.get(op.target);
    if (!letter) {
      this.waitingDeletes.add(op.target);
      return;
    }
    if (letter.deleted) return;
    letter.deleted = true;
    this.cache = null;
  }

  // ------------------------------------------------------------------- reading

  /**
   * Every letter in reading order, hidden ones included.
   *
   * The walk is written with an explicit stack rather than recursion: a
   * document is a deep chain — one level per letter typed in sequence — and
   * recursion would overflow the stack on a page of text.
   *
   * @returns {Letter[]}
   */
  order() {
    if (this.cache) return this.cache;

    /** @type {Letter[]} */
    const out = [];
    /** @type {Id[]} */
    const stack = [];

    // Push in reverse so the newest sibling is processed first.
    const roots = this.children.get(ROOT) ?? [];
    for (let i = roots.length - 1; i >= 0; i -= 1) stack.push(roots[i]);

    while (stack.length > 0) {
      const id = /** @type {Id} */ (stack.pop());
      const letter = this.letters.get(id);
      if (!letter) continue;
      out.push(letter);
      const kids = this.children.get(id);
      if (kids) {
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
      }
    }

    this.cache = out;
    return out;
  }

  /**
   * Only the letters a reader can see.
   * @returns {Letter[]}
   */
  visible() {
    return this.order().filter((letter) => !letter.deleted);
  }

  /**
   * The document as a string.
   * @returns {string}
   */
  toString() {
    let out = '';
    for (const letter of this.order()) if (!letter.deleted) out += letter.value;
    return out;
  }

  /** Number of visible characters. @returns {number} */
  get length() {
    return this.visible().length;
  }

  /**
   * True when nothing is being held back. Useful in tests: a replica that has
   * received every change should have an empty waiting room, and if it does
   * not, something referred to a letter that was never sent.
   * @returns {boolean}
   */
  settled() {
    return this.waiting.size === 0 && this.waitingDeletes.size === 0;
  }

  // ------------------------------------------------------------------ snapshots

  /** @returns {object} */
  toJSON() {
    return {
      letters: this.order().map((letter) => [
        letter.id,
        letter.parent,
        letter.value,
        letter.deleted ? 1 : 0,
      ]),
      waiting: [...this.waiting.values()].flat(),
      waitingDeletes: [...this.waitingDeletes],
    };
  }

  /**
   * @param {Clock} clock
   * @param {any} json
   * @returns {Text}
   */
  static fromJSON(clock, json) {
    const text = new Text(clock);
    // Saved in reading order, so every parent lands before its children and
    // nothing goes through the waiting room on the way back in.
    for (const [id, parent, value, deleted] of json.letters) {
      text.applyInsert({ type: 'insert', id, parent, value });
      if (deleted) {
        const letter = text.letters.get(id);
        if (letter) letter.deleted = true;
      }
    }
    text.cache = null;
    for (const op of json.waiting ?? []) text.applyInsert(op);
    for (const target of json.waitingDeletes ?? []) text.waitingDeletes.add(target);
    return text;
  }
}

/**
 * Known limitation: interleaving.
 *
 * Runs of typing stay together, but two people who both edit *inside* the same
 * concurrent run can still produce a mixed result. Fixing this properly means
 * moving to a stronger ordering rule — the Fugue paper describes one, and Yjs
 * uses YATA — and that is a deliberate later step, not an oversight.
 *
 * It is worth being precise about what is and is not broken here: interleaving
 * is a quality-of-result problem. Convergence is not affected. Every device
 * still ends up with identical text, which is the property the tests check.
 */
