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
 * A device's own identity plus its counter. One of these per open document.
 *
 * The counter only ever goes up. It is not a wall clock: clocks on two machines
 * disagree, and a merge rule that trusted them would produce different results
 * on different devices, which is exactly the bug this design has to avoid.
 */
export class Clock {
  /**
   * @param {string} [site] This device's id. Generated if not given.
   * @param {number} [counter] Resume from a saved counter.
   */
  constructor(site = randomSite(), counter = 0) {
    /** @type {string} */
    this.site = site;
    /** @type {number} */
    this.counter = counter;
  }

  /**
   * Take the next id for a change made on this device.
   * @returns {Id}
   */
  next() {
    this.counter += 1;
    return `${this.counter}@${this.site}`;
  }

  /**
   * Move the counter past an id seen from somewhere else.
   *
   * Without this, a device that reloads from a snapshot could hand out an id it
   * has already used, and two different changes would share one name.
   *
   * @param {Id} id
   */
  observe(id) {
    const { counter } = parseId(id);
    if (counter > this.counter) this.counter = counter;
  }

  /** @returns {{site: string, counter: number}} */
  toJSON() {
    return { site: this.site, counter: this.counter };
  }

  /**
   * @param {{site: string, counter: number}} json
   * @returns {Clock}
   */
  static fromJSON(json) {
    return new Clock(json.site, json.counter);
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
 * Put two ids in order.
 *
 * Higher counter wins. When counters are equal — which is what "at the same
 * time" means here — the site id breaks the tie. The tie-break is arbitrary on
 * purpose: it does not matter which device wins, only that every device picks
 * the same winner.
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
