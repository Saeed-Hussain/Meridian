/**
 * The protocol on a bad connection.
 *
 * A sync protocol that has only ever run on localhost is untested. A good
 * connection hides every ordering, duplication and loss bug, and those are the
 * bugs that show up on a phone on a train — which is the condition this whole
 * project exists for.
 *
 * Everything here is seeded, so a failure can be replayed exactly:
 *
 *   SEED=12345 npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '@meridian/core';
import { Network } from '../src/index.js';
import { Unreliable } from './helpers/channels.js';
import { random, seedFromEnv } from '@meridian/core/testing';

const LETTERS = 'abcdefghijklmnop ';

/**
 * Two peers over a connection that misbehaves.
 *
 * @param {object} options
 * @param {number} options.seed
 * @param {number} [options.drop]
 * @param {number} [options.duplicate]
 * @param {number} [options.reorder]
 * @param {number} [options.rounds]
 * @param {number} [options.edits]
 * @returns {Promise<{a: Doc, b: Doc, link: Unreliable, repairRounds: number}>}
 */
async function run(options) {
  const { seed, drop = 0, duplicate = 0, reorder = 0, rounds = 5, edits = 5 } = options;
  const rng = random(seed);

  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const link = new Unreliable({ rng, drop, duplicate, reorder });

  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', link.side(0));
  netB.connect('a', link.side(1));
  await link.deliver();

  for (let round = 0; round < rounds; round += 1) {
    for (const doc of [a, b]) {
      for (let e = 0; e < edits; e += 1) {
        const length = doc.text.length;
        if (length === 0 || rng.float() < 0.7) {
          let word = '';
          for (let c = 0; c < 1 + rng.int(3); c += 1) word += rng.pick([...LETTERS]);
          doc.insert(length === 0 ? 0 : rng.int(length + 1), word);
        } else {
          const at = rng.int(length);
          doc.delete(at, 1 + rng.int(Math.min(2, length - at)));
        }
      }
    }
    await link.deliver();
  }

  // Messages have stopped, and on a lossy link some were thrown away -- possibly
  // including a handshake. So repair the way a real client does: tick on a
  // timer until both sides confirm they are up to date.
  //
  // The bound matters. Anti-entropy that needed unlimited rounds would not be a
  // repair mechanism, so the test fails rather than looping forever.
  const repairRounds = await repair([netA, netB], [link]);

  return { a, b, link, repairRounds };
}

/**
 * Tick until every peer confirms it is caught up.
 *
 * @param {Network[]} nets
 * @param {Unreliable[]} links
 * @param {number} [maxRounds]
 * @returns {Promise<number>} Rounds needed.
 */
async function repair(nets, links, maxRounds = 60) {
  for (let round = 1; round <= maxRounds; round += 1) {
    let greeted = 0;
    for (const net of nets) greeted += net.tick();
    for (const link of links) await link.deliver();
    if (greeted === 0 && nets.every((net) => net.synced)) return round;
  }
  throw new Error(`still not synced after ${maxRounds} rounds`);
}

test('a perfect connection converges', async () => {
  const seed = seedFromEnv();
  console.log(`   seed ${seed} (replay with SEED=${seed} npm test)`);
  for (let i = 0; i < 20; i += 1) {
    const { a, b } = await run({ seed: seed + i });
    assert.equal(a.toString(), b.toString(), `seed ${seed + i}`);
  }
});

test('messages arriving out of order converge', async () => {
  const seed = seedFromEnv();
  for (let i = 0; i < 20; i += 1) {
    const { a, b } = await run({ seed: seed + i, reorder: 0.5 });
    assert.equal(a.toString(), b.toString(), `seed ${seed + i}`);
    assert.ok(a.text.settled(), 'nothing left held back');
  }
});

test('messages arriving twice converge', async () => {
  const seed = seedFromEnv();
  for (let i = 0; i < 20; i += 1) {
    const { a, b, link } = await run({ seed: seed + i, duplicate: 0.4 });
    assert.equal(a.toString(), b.toString(), `seed ${seed + i}`);
    assert.ok(link.stats.duplicated > 0, 'the test actually duplicated something');
  }
});

test('30 percent packet loss converges after a fresh handshake', async () => {
  // The interesting one. Losing a third of all messages means changes are
  // definitely missed, and the only repair is the handshake.
  const seed = seedFromEnv();
  let worst = 0;
  for (let i = 0; i < 20; i += 1) {
    const { a, b, link, repairRounds } = await run({ seed: seed + i, drop: 0.3 });
    assert.equal(a.toString(), b.toString(), `seed ${seed + i}`);
    assert.ok(link.stats.lost > 0, 'the test actually lost something');
    worst = Math.max(worst, repairRounds);
  }
  console.log(`   worst case: ${worst} repair rounds at 30% loss`);
});

test('a thoroughly broken connection still converges', async () => {
  const seed = seedFromEnv();
  for (let i = 0; i < 20; i += 1) {
    const { a, b } = await run({
      seed: seed + i,
      drop: 0.2,
      duplicate: 0.2,
      reorder: 0.4,
      rounds: 6,
      edits: 6,
    });
    assert.equal(a.toString(), b.toString(), `seed ${seed + i}`);
    assert.ok(a.text.settled());
  }
});

test('a partition heals', async () => {
  // A partition is the nastiest case because nothing looks wrong: the channel
  // reports itself open the whole time and silently carries nothing.
  const rng = random(seedFromEnv());
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const link = new Unreliable({ rng });

  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', link.side(0));
  netB.connect('a', link.side(1));
  await link.deliver();

  a.insert(0, 'together');
  await link.deliver();
  assert.equal(b.toString(), 'together');

  link.partition();
  a.insert(8, ' apart-a');
  b.insert(0, 'apart-b ');
  await link.deliver();
  assert.notEqual(a.toString(), b.toString(), 'the partition really blocked');

  link.heal();
  await repair([netA, netB], [link]);

  assert.equal(a.toString(), b.toString(), 'and it healed');
  assert.ok(a.toString().includes('apart-a'));
  assert.ok(a.toString().includes('apart-b'));
});

test('a peer that was away for a long time catches up in one handshake', async () => {
  const rng = random(seedFromEnv());
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const link = new Unreliable({ rng });

  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', link.side(0));
  netB.connect('a', link.side(1));
  await link.deliver();

  link.partition();
  for (let i = 0; i < 200; i += 1) a.insert(a.text.length, 'x');
  await link.deliver();

  link.heal();
  const before = link.stats.sent;
  await repair([netA, netB], [link]);

  assert.equal(a.toString(), b.toString());
  assert.ok(
    link.stats.sent - before < 20,
    `catching up took ${link.stats.sent - before} messages, not one batch`,
  );
});

test('three peers on bad connections all agree', async () => {
  // a — b — c again, both links unreliable, so changes have to survive two
  // lossy hops to reach the far end.
  const rng = random(seedFromEnv());
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const c = new Doc('cccc');

  const ab = new Unreliable({ rng, drop: 0.2, reorder: 0.3 });
  const bc = new Unreliable({ rng, drop: 0.2, reorder: 0.3 });

  const netA = new Network(a);
  const netB = new Network(b);
  const netC = new Network(c);
  netA.connect('b', ab.side(0));
  netB.connect('a', ab.side(1));
  netB.connect('c', bc.side(0));
  netC.connect('b', bc.side(1));

  /** @returns {Promise<void>} */
  const deliver = async () => {
    // Both links, repeatedly: a change relayed by b appears on the other link
    // only after b has handled it.
    for (let i = 0; i < 6; i += 1) {
      await ab.deliver();
      await bc.deliver();
    }
  };
  await deliver();

  a.insert(0, 'from a ');
  c.insert(0, 'from c ');
  b.insert(0, 'from b ');
  await deliver();

  for (let round = 0; round < 40; round += 1) {
    let greeted = 0;
    for (const net of [netA, netB, netC]) greeted += net.tick();
    await deliver();
    if (greeted === 0 && [netA, netB, netC].every((net) => net.synced)) break;
  }

  assert.equal(a.toString(), b.toString(), 'a and b agree');
  assert.equal(b.toString(), c.toString(), 'b and c agree');
  for (const doc of [a, b, c]) assert.ok(doc.text.settled(), `${doc.site} settled`);
});
