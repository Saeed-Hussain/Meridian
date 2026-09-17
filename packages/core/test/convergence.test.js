/**
 * The test the project exists for.
 *
 * Several replicas make random edits while unable to see each other. The
 * changes are then delivered to every replica in a different random order,
 * sometimes twice. Afterwards all replicas must hold identical text.
 *
 * Hand-written tests only check the cases a person thought of, and the cases
 * that break a merge algorithm are the ones nobody thought of. This is why the
 * work plan puts random testing in week 4 rather than at the end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '../src/index.js';
import { random, shuffled, seedFromEnv } from './helpers/random.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz ';

/**
 * Run one round: edit apart, then deliver everything everywhere.
 *
 * @param {number} seed
 * @param {object} [options]
 * @param {number} [options.replicas]
 * @param {number} [options.rounds] How many offline edit-and-share cycles.
 * @param {number} [options.editsPerRound]
 * @param {boolean} [options.duplicate] Also deliver every change a second time.
 * @returns {string} The agreed text.
 */
function converge(seed, options = {}) {
  const {
    replicas = 3,
    rounds = 4,
    editsPerRound = 6,
    duplicate = false,
  } = options;

  const rng = random(seed);
  const docs = Array.from(
    { length: replicas },
    (_, i) => new Doc(`site${i}${String.fromCharCode(97 + i)}`),
  );

  /** @type {import('../src/oplog.js').Op[]} */
  const everything = [];

  for (let round = 0; round < rounds; round += 1) {
    // Each replica edits on its own, seeing nothing from the others.
    for (const doc of docs) {
      for (let e = 0; e < editsPerRound; e += 1) {
        const length = doc.text.length;
        const action = rng.float();

        if (length === 0 || action < 0.6) {
          const at = length === 0 ? 0 : rng.int(length + 1);
          const size = 1 + rng.int(4);
          let word = '';
          for (let c = 0; c < size; c += 1) word += rng.pick([...LETTERS]);
          everything.push(...doc.insert(at, word));
        } else if (action < 0.9) {
          const at = rng.int(length);
          const size = 1 + rng.int(Math.min(3, length - at));
          everything.push(...doc.delete(at, size));
        } else {
          everything.push(...doc.setField('title', `t${rng.int(100)}`));
        }
      }
    }

    // Everyone hears everything, each in their own order.
    for (const doc of docs) {
      const delivery = shuffled(everything, rng);
      doc.receive(delivery);
      if (duplicate) doc.receive(shuffled(delivery, rng));
    }
  }

  const expected = docs[0].toString();
  for (const doc of docs) {
    assert.equal(
      doc.toString(),
      expected,
      `replica ${doc.site} disagrees (seed ${seed})`,
    );
    assert.ok(
      doc.text.settled(),
      `replica ${doc.site} is still holding changes back (seed ${seed})`,
    );
    assert.equal(
      doc.fields.get('title'),
      docs[0].fields.get('title'),
      `replica ${doc.site} disagrees on the title (seed ${seed})`,
    );
  }
  return expected;
}

test('replicas converge over many random runs', () => {
  const base = seedFromEnv();
  console.log(`   seed ${base} (re-run with SEED=${base} npm test)`);
  for (let i = 0; i < 400; i += 1) converge(base + i);
});

test('replicas converge when changes are delivered twice', () => {
  const base = seedFromEnv();
  for (let i = 0; i < 100; i += 1) {
    converge(base + i, { duplicate: true });
  }
});

test('replicas converge with more devices and more edits', () => {
  const base = seedFromEnv();
  for (let i = 0; i < 25; i += 1) {
    converge(base + i, { replicas: 6, rounds: 5, editsPerRound: 10 });
  }
});

test('two replicas converge on a known seed', () => {
  // A fixed seed, so this test is identical on every machine and in CI.
  const text = converge(20260917, { replicas: 2, rounds: 6, editsPerRound: 8 });
  assert.ok(text.length > 0, 'the run should produce some text');
});

test('order of delivery cannot change the result', () => {
  // The strongest statement of the property: same changes, twelve different
  // orders, one answer.
  const rng = random(4242);
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');

  const base = a.insert(0, 'the quick brown fox');
  a.syncTo(b);
  const made = [
    ...base,
    ...a.insert(4, 'very '),
    ...b.insert(4, 'rather '),
    ...a.delete(0, 3),
    ...b.insert(0, '# '),
    ...a.setField('title', 'fox'),
    ...b.addTag('draft'),
  ];

  /** @type {Set<string>} */
  const results = new Set();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fresh = new Doc(`z${attempt}`);
    fresh.receive(shuffled(made, rng));
    assert.ok(fresh.text.settled(), 'nothing held back');
    results.add(fresh.toString());
  }

  assert.equal(results.size, 1, `expected one result, got ${[...results].length}`);
});
