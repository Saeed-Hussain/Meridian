/**
 * Identity and ordering.
 *
 * Every change in Meridian needs a name that is unique across all devices and
 * for all time, and any two names must sort into the same order on every
 * device. That is the whole job of this file, and everything else in the core
 * stands on it.
 *
 * An id is written as `"<counter>@<site>"`, for example `"12@a3f9c1d8"`. It is a
 * string so that it can be a Map key and survive JSON without conversion.
 */

/** @typedef {string} Id A change id, formatted `"<counter>@<site>"`. */

/**
 * A device's identity and its two counters.
 *
 * There are two, and the reason is the most important thing in this file.
 *
 * A change needs a **name**, and it needs a **position in an order**. Those
 * sound like one job and are not:
 *
 * - The name has to be gapless per device — 1, 2, 3 — because syncing sends a
 *   summary of the form "I hold everything from device X up to number N". A gap
 *   in a device's own numbering makes that summary meaningless, and the device
 *   ends up reporting that it holds none of its own changes.
 *
 * - The order has to reflect what the writer had already seen. If someone types
 *   a letter between two existing letters, it must land between them on every
 *   device, which means its stamp has to beat the letter it was typed in front
 *   of. That requires taking account of other devices' numbers.
 *
 * One counter cannot do both: advancing it past another device's number is
 * exactly what puts a hole in this device's own sequence. So `counter` names
 * changes, and `lamport` orders them. Neither is a wall clock, because two
 * machines' clocks disagree and a merge rule that trusted them would give
 * different answers on different devices.
 */
export class Clock {
  /**
   * @param {string} [site] This device's id. Generated if not given.
   * @param {number} [counter] Resume from a saved counter.
   * @param {number} [lamport] Resume from a saved stamp.
   */
  constructor(site = randomSite(), counter = 0, lamport = 0) {
    /** @type {string} */
    this.site = site;
    /** Names this device's own changes, with no gaps. @type {number} */
    this.counter = counter;
    /** Orders changes against everyone else's. @type {number} */
    this.lamport = lamport;
  }

  /**
   * Take the next name and stamp for a change made on this device.
   * @returns {{id: Id, l: number}}
   */
  next() {
    this.counter += 1;
    this.lamport += 1;
    return { id: `${this.counter}@${this.site}`, l: this.lamport };
  }

  /**
   * Take account of a change from anywhere.
   *
   * The stamp is raised past anything seen, so the next local change sorts
   * after it. The name counter only moves for this device's own changes, which
   * is what keeps its numbering gapless.
   *
   * @param {Id} id
   * @param {number} [l]
   */
  witness(id, l) {
    if (typeof l === 'number' && l > this.lamport) this.lamport = l;
    this.observe(id);
  }

  /**
   * Move the counter past an id this device itself produced.
   *
   * Needed when loading a saved document: without it a device would hand out an
   * id it has already used, and two different changes would share one name.
   *
   * ## Why other devices' ids are ignored
   *
   * The obvious thing — and what this did at first — is to advance past *every*
   * id seen, in the style of a Lamport clock. That is wrong here, and the way
   * it fails is worth recording.
   *
   * Syncing relies on a summary of the form "I hold everything from device X up
   * to counter N". That is only meaningful if a device's own counters have no
   * gaps: 1, 2, 3, and so on. Advancing past another device's counter puts a
   * hole in this device's own sequence — its next change might be number 9,
   * with 1 to 8 never having existed.
   *
   * The summary then cannot move past the hole, so the device reports holding
   * *none of its own changes*. Peers conclude it is permanently behind and
   * greet it forever, while the text itself is perfectly in sync. It took a
   * partition test over several rounds to see it.
   *
   * Ids do not need to be causally ordered. They need to be unique and to sort
   * the same way everywhere, and `(counter, site)` does that on its own.
   *
   * @param {Id} id
   */
  observe(id) {
    const { counter, site } = parseId(id);
    if (site !== this.site) return;
    if (counter > this.counter) this.counter = counter;
  }

  /** @returns {{site: string, counter: number, lamport: number}} */
  toJSON() {
    return { site: this.site, counter: this.counter, lamport: this.lamport };
  }

  /**
   * @param {{site: string, counter: number, lamport?: number}} json
   * @returns {Clock}
   */
  static fromJSON(json) {
    return new Clock(json.site, json.counter, json.lamport ?? json.counter);
  }
}

/**
 * A random id for this device. Eight hex characters is short enough to read in
 * a log and long enough that two devices colliding is not a real concern.
 * @returns {string}
 */
export function randomSite() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Split an id back into its two parts.
 *
 * The site is found with `indexOf` rather than `split` because a site id is
 * opaque and could one day contain an `@`.
 *
 * @param {Id} id
 * @returns {{counter: number, site: string}}
 */
export function parseId(id) {
  const at = id.indexOf('@');
  if (at < 1) throw new Error(`not an id: ${JSON.stringify(id)}`);
  const counter = Number(id.slice(0, at));
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`not an id: ${JSON.stringify(id)}`);
  }
  return { counter, site: id.slice(at + 1) };
}

/**
 * Put two changes in order: by stamp, then by device.
 *
 * The stamp decides, because it reflects what the writer had seen. The device
 * id only breaks a tie between two changes made without knowledge of each
 * other — which is what "at the same time" means here. Who wins a tie does not
 * matter; every device picking the same winner does.
 *
 * @param {number} aL
 * @param {Id} aId
 * @param {number} bL
 * @param {Id} bId
 * @returns {number}
 */
export function compareStamps(aL, aId, bL, bId) {
  if (aL !== bL) return aL - bL;
  if (aId === bId) return 0;
  return parseId(aId).site < parseId(bId).site ? -1 : 1;
}

/**
 * Put two ids in order.
 *
 * Used where identity is all that matters — deduplication, and breaking a tie
 * between two stamps that are equal. Ordering *changes* uses `compareStamps`,
 * because a name says nothing about what its writer had seen.
 *
 * @param {Id} a
 * @param {Id} b
 * @returns {number} Negative if `a` sorts first, positive if `b` does, 0 if equal.
 */
export function compareIds(a, b) {
  if (a === b) return 0;
  const left = parseId(a);
  const right = parseId(b);
  if (left.counter !== right.counter) return left.counter - right.counter;
  return left.site < right.site ? -1 : 1;
}
