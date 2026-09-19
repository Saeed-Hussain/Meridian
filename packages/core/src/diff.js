/**
 * Turning "the text box now says this" into changes.
 *
 * A text box hands over its whole contents after every keystroke. The document
 * needs the opposite: the smallest possible description of what altered.
 *
 * Getting this wrong is expensive in a way that is easy to miss. Replacing the
 * whole document on every keystroke would still *look* correct on one machine —
 * and it would delete and re-insert every letter, so two people typing in the
 * same paragraph would obliterate each other's work, every cursor would jump to
 * the end, and the change log would grow without bound.
 *
 * So the rule is: touch as little as possible.
 *
 * ## How
 *
 * Match the identical text at the start, then the identical text at the end.
 * Whatever is left in the middle is what changed.
 *
 *     before:  the quick brown fox
 *     after:   the very quick brown fox
 *     same at the start: "the "
 *     same at the end:   "quick brown fox"
 *     so: insert "very " at position 4
 *
 * This is not a clever diff. It finds one changed run, which is exactly what a
 * keystroke, a paste, or a selected-and-replaced block produces. A cleverer
 * algorithm would produce a smaller answer for edits made in two places at
 * once, which a text box cannot do in one event.
 */

/**
 * @typedef {object} Change
 * @property {number} at Where the change starts.
 * @property {number} removed How many characters were taken out.
 * @property {string} added What was put in.
 */

/**
 * Work out the single edit between two strings.
 *
 * @param {string} before
 * @param {string} after
 * @returns {Change | null} Null when nothing changed.
 */
export function diff(before, after) {
  if (before === after) return null;

  const max = Math.min(before.length, after.length);

  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;

  // Count backwards, stopping before the matched prefix so that the two ranges
  // cannot overlap. Without that guard, "aa" becoming "aaa" would match two
  // characters at the start and two at the end of a three-character string, and
  // the maths would produce a negative length.
  let end = 0;
  while (
    end < max - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  return {
    at: start,
    removed: before.length - start - end,
    added: after.slice(start, after.length - end),
  };
}

/**
 * Apply what a text box now says to a document.
 *
 * Deleting happens before inserting, because the insert position is expressed
 * in terms of the text after the removal.
 *
 * The change is returned as well as the operations, because the caller needs
 * to know *where* the edit happened. An editor works out where to leave the
 * cursor from that, rather than from the text box's own caret: the box and the
 * document disagree for a moment after every edit, and a caret read inside
 * that window points at the wrong letter.
 *
 * @param {import('./doc.js').Doc} doc
 * @param {string} after
 * @returns {{ops: import('./oplog.js').Op[], change: Change | null}}
 */
export function applyText(doc, after) {
  const change = diff(doc.toString(), after);
  if (!change) return { ops: [], change: null };

  /** @type {import('./oplog.js').Op[]} */
  const ops = [];
  if (change.removed > 0) ops.push(...doc.delete(change.at, change.removed));
  if (change.added) ops.push(...doc.insert(change.at, change.added));
  return { ops, change };
}
