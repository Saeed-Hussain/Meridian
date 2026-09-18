/**
 * Fake networks for tests.
 *
 * A protocol that only gets tried on a good connection is untested, because a
 * good connection hides every ordering and duplication bug. These channels can
 * be told to delay, drop, duplicate, reorder and partition, and everything is
 * driven by a seed so a failure can be replayed exactly.
 *
 * This is also what a real WebRTC data channel behaves like on a bad mobile
 * connection, which is the condition Meridian exists for.
 */

/** @typedef {import('../../src/session.js').Channel} Channel */

/**
 * A perfect connection: instant, ordered, lossless.
 *
 * Delivery is still deferred to a microtask rather than being a direct call, so
 * that a message never arrives in the middle of the code that sent it. A
 * synchronous pipe would hide re-entrancy bugs that a real network cannot.
 *
 * @returns {[Channel, Channel]}
 */
export function pair() {
  /** @type {((data: string) => void)[]} */
  const handlers = [[], []].map(() => () => {});
  const closed = [false, false];

  /**
   * @param {0 | 1} me
   * @returns {Channel}
   */
  const side = (me) => {
    const them = /** @type {0 | 1} */ (1 - me);
    return {
      send: (data) => {
        if (closed[me] || closed[them]) return;
        Promise.resolve().then(() => {
          if (!closed[them]) handlers[them](data);
        });
      },
      onMessage: (handler) => {
        handlers[me] = handler;
      },
      isOpen: () => !closed[me] && !closed[them],
      close: () => {
        closed[me] = true;
      },
    };
  };

  return [side(0), side(1)];
}

/**
 * A connection that misbehaves on purpose.
 *
 * Messages are held in a queue and released by `deliver()`, so tests control
 * time instead of waiting on it. Nothing here uses real timers: a test that
 * sleeps is slow and, worse, flaky on a loaded machine.
 */
export class Unreliable {
  /**
   * @param {object} options
   * @param {{float: () => number, int: (max: number) => number}} options.rng
   * @param {number} [options.drop] Chance a message is lost, 0 to 1.
   * @param {number} [options.duplicate] Chance a message arrives twice.
   * @param {number} [options.reorder] Chance a message jumps the queue.
   */
  constructor(options) {
    this.rng = options.rng;
    this.drop = options.drop ?? 0;
    this.duplicate = options.duplicate ?? 0;
    this.reorder = options.reorder ?? 0;

    /** @type {{to: 0 | 1, data: string}[]} */
    this.queue = [];
    /** @type {((data: string) => void)[]} */
    this.handlers = [() => {}, () => {}];
    /** @type {boolean} */
    this.partitioned = false;
    this.stats = { sent: 0, delivered: 0, lost: 0, duplicated: 0 };
  }

  /**
   * @param {0 | 1} me
   * @returns {Channel}
   */
  side(me) {
    const them = /** @type {0 | 1} */ (1 - me);
    return {
      send: (data) => {
        this.stats.sent += 1;
        if (this.partitioned || this.rng.float() < this.drop) {
          this.stats.lost += 1;
          return;
        }
        this.push({ to: them, data });
        if (this.rng.float() < this.duplicate) {
          this.stats.duplicated += 1;
          this.push({ to: them, data });
        }
      },
      onMessage: (handler) => {
        this.handlers[me] = handler;
      },
      // Open even while partitioned: a partition is exactly the case where a
      // connection looks fine and nothing gets through, and that is what makes
      // it worth testing.
      isOpen: () => true,
    };
  }

  /**
   * @param {{to: 0 | 1, data: string}} item
   * @private
   */
  push(item) {
    if (this.queue.length > 0 && this.rng.float() < this.reorder) {
      this.queue.splice(this.rng.int(this.queue.length), 0, item);
    } else {
      this.queue.push(item);
    }
  }

  /** Cut the connection without either side noticing. */
  partition() {
    this.partitioned = true;
  }

  /** Let messages through again. */
  heal() {
    this.partitioned = false;
  }

  /**
   * Deliver what is queued, including anything that arrives as a result.
   *
   * Handling a message usually causes a reply, so this keeps going until the
   * queue stays empty. The cap is there so that a protocol bug which makes two
   * peers talk forever fails the test instead of hanging it.
   *
   * @param {number} [maxRounds]
   * @returns {Promise<number>} Messages delivered.
   */
  async deliver(maxRounds = 10000) {
    let delivered = 0;
    let rounds = 0;
    while (this.queue.length > 0) {
      if ((rounds += 1) > maxRounds) {
        throw new Error(`messages never stopped after ${maxRounds} rounds`);
      }
      const item = /** @type {{to: 0 | 1, data: string}} */ (this.queue.shift());
      this.handlers[item.to](item.data);
      delivered += 1;
      this.stats.delivered += 1;
      // Let any promise-based work inside the handler finish before the next
      // message, so ordering stays under the test's control.
      await Promise.resolve();
    }
    return delivered;
  }
}
