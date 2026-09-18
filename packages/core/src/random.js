/**
 * Seeded randomness for tests.
 *
 * This sits in `src` rather than in a test folder because more than one package
 * needs it: the core's convergence tests and the sync package's bad-network
 * tests must both be replayable from a seed. It is reached through
 * `@meridian/core/testing`.
 *
 * `Math.random` cannot be used here. A test that fails once and then cannot be
 * made to fail again is not a test, it is a rumour. Every run prints its seed,
 * so a failure can be replayed exactly.
 */

/**
 * A small, fast, well-known generator (mulberry32). Not for cryptography, and
 * not used for anything but test input.
 *
 * @param {number} seed
 * @returns {{int: (max: number) => number, pick: <T>(items: T[]) => T, float: () => number}}
 */
export function random(seed) {
  let state = seed >>> 0;

  const float = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    float,
    /** @param {number} max */
    int: (max) => Math.floor(float() * max),
    /** @template T @param {T[]} items @returns {T} */
    pick: (items) => items[Math.floor(float() * items.length)],
  };
}

/**
 * Shuffle a copy of a list, so changes can be delivered in a different order to
 * each replica.
 *
 * @template T
 * @param {T[]} items
 * @param {{int: (max: number) => number}} rng
 * @returns {T[]}
 */
export function shuffled(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A seed for this run. Pass one in to replay a failure:
 *
 *   SEED=12345 npm test
 *
 * @returns {number}
 */
export function seedFromEnv() {
  const given = process.env.SEED;
  if (given) return Number(given);
  return Math.floor(Math.random() * 2 ** 31);
}
