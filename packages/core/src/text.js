/**
 * The text merge algorithm.
 *
 * This is the part of Meridian that has to be correct. Everything else is
 * ordinary software.
 *
 * ## The idea
 *
 * The document is not stored as a string. It is a chain of single letters,
 * each with its own permanent id and the id of the letter it was typed after.
 *
 * Two rules make every device agree:
 *
 *   1. A letter's id and the letter it was typed after never change.
 *   2. When several letters were typed in the same place — which is what a
 *      conflict is — the one with the higher stamp goes first, and the device
 *      id settles an exact tie.
 *
 * Neither rule looks at arrival order, at wall clocks, or at who connected
 * first. So a device that receives changes in a strange order still ends up
 * with the same text as everyone else, with no server deciding anything.
 *
 * ## How a letter finds its place
 *
 * The letters are held in order, in a chain. To place a new one: start just
 * after the letter it was typed after, then walk forward past every letter
 * whose stamp beats the new one, and stop.
 *
 * That short rule does the whole job, and it works because of one invariant:
 * **a letter's stamp is always higher than that of the letter it was typed
 * after**, since whoever typed it had already seen that letter. So everything
 * typed after a rival letter also outranks the newcomer, and walking past the
 * rival walks past its whole run in one go. The walk cannot overshoot either:
 * the first letter beyond the run belongs to an earlier place in the document,
 * so its stamp is lower and the walk stops there.
 *
 * In practice the walk takes no steps at all, because two people rarely type
 * in exactly the same place at the same moment.
 *
 * ## Why runs of typing stay together
 *
 * Each letter is typed after the one before it, so a word is a run rather than
 * a crowd competing for one spot. Someone else typing in the same place forms
 * a separate run, and one whole run goes before the other: "helloworld" or
 * "worldhello", never "hweolrllod".
 *
 * ## Deleting
 *
 * A deleted letter is marked hidden and kept, because another device may still
 * send a change that refers to it. A hidden letter is called a tombstone.
 * Dropping them safely is a separate job, done later by snapshots, once every
 * device is known to have moved past them.
 */

import { compareStamps } from './id.js';

/** @typedef {import('./id.js').Id} Id */
/** @typedef {import('./id.js').Clock} Clock */

/**
 * A single letter.
 *
 * `before` and `after` hold the chain. Keeping the letters linked, rather than
 * rebuilding the reading order from a tree on every change, is what makes a
 * keystroke cost the same on a long document as on a short one.
 *
 * @typedef {object} Letter
 * @property {Id} id
 * @property {Id | null} parent Id of the letter this was typed after.
 * @property {string} value One character.
 * @property {boolean} deleted
 * @property {number} l The stamp that decides ties.
 * @property {Letter | null} before
 * @property {Letter | null} after
 */

/**
 * A change to the text.
 * @typedef {object} InsertOp
 * @property {'insert'} type
 * @property {Id} id Doubles as the new letter's id.
 * @property {Id | null} parent
 * @property {string} value
 * @property {number} l
 *
 * @typedef {object} DeleteOp
 * @property {'delete'} type
 * @property {Id} id This change's own id, needed so sync can track it.
 * @property {Id} target The letter being hidden.
 * @property {number} l Its place in the order, for replaying history.
 *
 * @typedef {InsertOp | DeleteOp} TextOp
 */

export class Text {
  /**
   * @param {Clock} clock Shared with the rest of the document.
   */
  constructor(clock) {
    /** @type {Clock} */
    this.clock = clock;

    /** @type {Map<Id, Letter>} */
    this.letters = new Map();

    /** First letter in the chain. @type {Letter | null} */
    this.first = null;
    /** Last letter in the chain, so appending does not walk. @type {Letter | null} */
    this.last = null;

    /** Letters a reader can see. Kept rather than counted. @type {number} */
    this.visibleCount = 0;

    /**
     * Inserts that arrived before the letter they were typed after. Keyed by
     * the letter they are waiting for, so they can be applied the moment it
     * turns up.
     *
     * Without this, an out-of-order delivery would silently lose a letter, and
     * the network is allowed to deliver in any order it likes.
     * @type {Map<Id, InsertOp[]>}
     */
    this.waiting = new Map();

    /**
     * Deletes for letters not yet seen. A delete may legitimately arrive
     * before the insert it refers to.
     * @type {Set<Id>}
     */
    this.waitingDeletes = new Set();

    /**
     * The document as a string, once someone has asked for it.
     *
     * Reading the whole chain costs about as long as the document, and the
     * editor asks twice per keystroke: once to work out what changed, and
     * once to draw the result. The first of those two always comes before any
     * change, so it can be answered from here for nothing.
     * @type {string | null}
     */
    this.rendered = null;

    /**
     * The last place looked up, and where it was.
     *
     * Finding the letter at a position means counting along the chain. People
     * type in one place and then a little further along, so remembering where
     * we were last turns almost every lookup into a step or two instead of a
     * walk from the beginning. It is the difference between a keystroke
     * costing the same on any document and costing more the longer it gets.
     * @type {{letter: Letter, index: number} | null}
     */
    this.mark = null;
  }

  // ---------------------------------------------------------------- local edits

  /**
   * Type text at a position, as this device.
   *
   * @param {number} index Position in the visible text.
   * @param {string} value
   * @returns {InsertOp[]} Changes to save and send.
   */
  insert(index, value) {
    if (value === '') return [];
    if (index < 0 || index > this.visibleCount) {
      throw new RangeError(`insert out of range: ${index} of ${this.visibleCount}`);
    }

    /** @type {Id | null} */
    let parent = index === 0 ? null : this.letterAt(index - 1).id;
    /** @type {InsertOp[]} */
    const ops = [];

    let at = index;
    for (const character of value) {
      const { id, l } = this.clock.next();
      /** @type {InsertOp} */
      const op = { type: 'insert', id, parent, value: character, l };
      this.applyInsert(op);
      ops.push(op);
      parent = op.id;

      // Leave the mark on what was just typed. The next keystroke is almost
      // always the next position along, which then costs nothing to find.
      const placed = this.letters.get(op.id);
      if (placed) this.mark = { letter: placed, index: at };
      at += 1;
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
    if (index < 0 || index + count > this.visibleCount) {
      throw new RangeError(
        `delete out of range: ${index}+${count} of ${this.visibleCount}`,
      );
    }

    /** @type {Letter[]} */
    const doomed = [];
    let letter = this.letterAt(index);
    while (doomed.length < count) {
      if (!letter.deleted) doomed.push(letter);
      const next = letter.after;
      if (!next) break;
      letter = next;
    }

    /** @type {DeleteOp[]} */
    const ops = [];
    for (const target of doomed) {
      const { id, l } = this.clock.next();
      /** @type {DeleteOp} */
      const op = { type: 'delete', id, target: target.id, l };
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

    /** @type {Letter | null} */
    let parent = null;
    if (op.parent !== null) {
      parent = this.letters.get(op.parent) ?? null;
      if (!parent) {
        // Hold it until the letter it was typed after arrives.
        const queue = this.waiting.get(op.parent);
        if (queue) {
          if (!queue.some((held) => held.id === op.id)) queue.push(op);
        } else {
          this.waiting.set(op.parent, [op]);
        }
        return;
      }
    }

    this.clock.witness(op.id, op.l);
    const stamp = op.l ?? 0;

    // Start just after the letter this was typed after, then walk past
    // everything that outranks it. See the note at the top of the file for why
    // this short rule is the whole ordering.
    let at = parent ? parent.after : this.first;
    while (at && compareStamps(at.l, at.id, stamp, op.id) > 0) at = at.after;

    /** @type {Letter} */
    const letter = {
      id: op.id,
      parent: op.parent,
      value: op.value,
      deleted: this.waitingDeletes.delete(op.id),
      l: stamp,
      before: at ? at.before : this.last,
      after: at,
    };

    if (letter.before) letter.before.after = letter;
    else this.first = letter;
    if (letter.after) letter.after.before = letter;
    else this.last = letter;

    this.letters.set(op.id, letter);
    if (!letter.deleted) this.visibleCount += 1;

    // Positions after this one have all moved, so the remembered place is no
    // longer true. A local edit sets it again straight away.
    this.mark = null;
    this.rendered = null;

    // This letter may be the one some held-back changes were waiting for.
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
    this.clock.witness(op.id, op.l);
    const letter = this.letters.get(op.target);
    if (!letter) {
      this.waitingDeletes.add(op.target);
      return;
    }
    if (letter.deleted) return;

    letter.deleted = true;
    this.visibleCount -= 1;
    this.mark = null;
    this.rendered = null;
  }

  // ------------------------------------------------------------------- reading

  /**
   * The letter at a visible position.
   *
   * Counts from the nearest known point rather than from the beginning, which
   * is what keeps typing in a long document as cheap as typing in a short one.
   *
   * @param {number} index
   * @returns {Letter}
   */
  letterAt(index) {
    if (index < 0 || index >= this.visibleCount) {
      throw new RangeError(`no letter at ${index} of ${this.visibleCount}`);
    }

    let letter = this.first;
    let at = -1;

    // Start from the last place looked up when it is nearer than the start.
    //
    // One before its index, not at it: the loop below counts each letter as it
    // arrives, so the marked letter has to be counted too rather than assumed.
    // Starting at its index counts it twice, which reads one letter early for
    // every lookup after the first.
    if (this.mark && this.mark.index <= index) {
      letter = this.mark.letter;
      at = this.mark.index - 1;
    }

    while (letter) {
      if (!letter.deleted) {
        at += 1;
        if (at === index) {
          this.mark = { letter, index };
          return letter;
        }
      }
      letter = letter.after;
    }
    throw new Error('the chain is shorter than it claims to be');
  }

  /**
   * Every letter in reading order, hidden ones included.
   * @returns {Letter[]}
   */
  order() {
    /** @type {Letter[]} */
    const out = [];
    for (let letter = this.first; letter; letter = letter.after) out.push(letter);
    return out;
  }

  /**
   * Only the letters a reader can see.
   * @returns {Letter[]}
   */
  visible() {
    /** @type {Letter[]} */
    const out = [];
    for (let letter = this.first; letter; letter = letter.after) {
      if (!letter.deleted) out.push(letter);
    }
    return out;
  }

  /**
   * The document as a string.
   * @returns {string}
   */
  toString() {
    if (this.rendered !== null) return this.rendered;

    let out = '';
    for (let letter = this.first; letter; letter = letter.after) {
      if (!letter.deleted) out += letter.value;
    }
    this.rendered = out;
    return out;
  }

  /** Number of visible characters. @returns {number} */
  get length() {
    return this.visibleCount;
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

  // -------------------------------------------------------------------- cursors

  /**
   * The letter a cursor at this position sits after.
   *
   * A cursor cannot be stored as a number. Someone typing earlier in the
   * document shifts every number after them, and the cursor would appear to
   * jump — the most irritating bug in collaborative editors. An id does not
   * move.
   *
   * @param {number} index
   * @returns {Id | null} Null for the start of the document.
   */
  anchorAt(index) {
    if (index <= 0 || this.visibleCount === 0) return null;
    return this.letterAt(Math.min(index, this.visibleCount) - 1).id;
  }

  /**
   * Turn an anchor back into a position.
   *
   * A hidden letter still works as an anchor: if the letter a cursor sat after
   * has since been deleted by someone else, the cursor belongs where that
   * letter used to be, not at the start of the document.
   *
   * @param {Id | null} anchor
   * @returns {number}
   */
  indexAfter(anchor) {
    if (anchor === null) return 0;

    // The common case by far: the anchor is the letter just typed, which is
    // exactly what the mark is pointing at.
    if (this.mark && this.mark.letter.id === anchor) {
      return this.mark.index + (this.mark.letter.deleted ? 0 : 1);
    }

    let index = 0;
    for (let letter = this.first; letter; letter = letter.after) {
      if (letter.id === anchor) return index + (letter.deleted ? 0 : 1);
      if (!letter.deleted) index += 1;
    }
    return index; // an anchor from letters that have not arrived; the end is safest
  }

  // ------------------------------------------------------------------ snapshots

  /** @returns {object} */
  toJSON() {
    /** @type {any[]} */
    const letters = [];
    for (let letter = this.first; letter; letter = letter.after) {
      letters.push([letter.id, letter.parent, letter.value, letter.deleted ? 1 : 0, letter.l]);
    }
    return {
      letters,
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
    text.mergeState(json);
    return text;
  }

  /**
   * Take in another replica's whole state, rather than its individual changes.
   *
   * Needed when a peer has thrown away old changes to save space and so cannot
   * replay them one by one. Merging states works because the pieces only ever
   * grow: letters are added and never moved, and a deletion never turns back
   * into a live letter.
   *
   * The saved order puts every letter after the one it was typed after, so
   * they can be taken in the order given.
   *
   * @param {any} json State from `toJSON`.
   */
  mergeState(json) {
    for (const [id, parent, value, deleted, l] of json.letters ?? []) {
      this.applyInsert({ type: 'insert', id, parent, value, l: l ?? 0 });
      if (deleted) this.hide(id);
    }
    for (const op of json.waiting ?? []) this.applyInsert(op);
    for (const target of json.waitingDeletes ?? []) this.hide(target);
  }

  /**
   * Mark a letter hidden, remembering it if it has not arrived.
   *
   * Deleting only ever goes one way, so this never revives a letter that some
   * other copy of the state still shows as present.
   *
   * @param {Id} id
   * @private
   */
  hide(id) {
    const letter = this.letters.get(id);
    if (!letter) {
      this.waitingDeletes.add(id);
      return;
    }
    if (letter.deleted) return;
    letter.deleted = true;
    this.visibleCount -= 1;
    this.mark = null;
    this.rendered = null;
  }
}

/**
 * Known limitation: interleaving.
 *
 * Runs of typing stay together, but two people who both edit *inside* the same
 * concurrent run can still produce a mixed result. Fixing it properly means a
 * stronger ordering rule — the Fugue paper describes one, and Yjs uses YATA —
 * and that is a deliberate later step, not an oversight.
 *
 * It is worth being precise about what is and is not broken: interleaving is a
 * quality-of-result problem. Convergence is not affected. Every device still
 * ends up with identical text, which is the property the tests check.
 */
