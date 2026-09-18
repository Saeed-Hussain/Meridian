/**
 * Presence: who is here and where their cursor is.
 *
 * The rule being tested throughout: presence must never touch the document. It
 * describes this moment, so it is not saved, not merged and not replayed. A
 * cursor position from last Tuesday syncing forever would be absurd.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '@meridian/core';
import { Network, decode } from '../src/index.js';
import { pair } from './helpers/channels.js';

/** @returns {Promise<void>} */
async function settle() {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

/**
 * @param {Doc} a
 * @param {Doc} b
 * @returns {Promise<{netA: Network, netB: Network}>}
 */
async function link(a, b) {
  const [left, right] = pair();
  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', left);
  netB.connect('a', right);
  await settle();
  return { netA, netB };
}

test('a peer learns who else is here', async () => {
  const { netA, netB } = await link(new Doc('aaaa'), new Doc('bbbb'));

  netA.announce({ name: 'Saeed', colour: '#c33', anchor: null });
  await settle();

  assert.equal(netB.present.size, 1);
  assert.equal(netB.present.get('a').name, 'Saeed');
});

test('watchers are told when presence changes', async () => {
  const { netA, netB } = await link(new Doc('aaaa'), new Doc('bbbb'));
  /** @type {number[]} */
  const sizes = [];
  netB.onPresence((present) => sizes.push(present.size));

  netA.announce({ name: 'first' });
  await settle();
  netA.announce({ name: 'second' });
  await settle();

  assert.deepEqual(sizes, [1, 1]);
  assert.equal(netB.present.get('a').name, 'second', 'the latest wins');
});

test('presence never reaches the document', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const { netA } = await link(a, b);

  netA.announce({ name: 'Saeed', anchor: '3@aaaa' });
  await settle();

  assert.equal(b.toString(), '', 'no text appeared');
  assert.equal(b.log.size, 0, 'nothing was added to the change log');
  assert.deepEqual(b.version(), {}, 'and nothing to sync');
});

test('a peer that leaves stops being present', async () => {
  // A ghost cursor left on screen after someone closes their laptop is worse
  // than showing nobody at all.
  const { netA, netB } = await link(new Doc('aaaa'), new Doc('bbbb'));
  netA.announce({ name: 'Saeed' });
  await settle();
  assert.equal(netB.present.size, 1);

  netB.disconnect('a');
  assert.equal(netB.present.size, 0, 'the cursor went with them');
});

test('a peer joining later still sees existing cursors', async () => {
  // Without repeating presence on a tick, a newcomer would see an empty room
  // until somebody happened to move.
  const a = new Doc('aaaa');
  const netA = new Network(a);
  netA.announce({ name: 'Saeed' });

  const b = new Doc('bbbb');
  const netB = new Network(b);
  const [left, right] = pair();
  netA.connect('b', left);
  netB.connect('a', right);
  await settle();

  assert.equal(netB.present.size, 0, 'nothing sent yet, the tick has not run');
  netA.tick();
  await settle();
  assert.equal(netB.present.get('a').name, 'Saeed');
});

test('presence is not sent before the handshake', async () => {
  // It would describe a document the peer has not loaded, and the cursor
  // position would refer to letters they do not have.
  const doc = new Doc('aaaa');
  const [left, right] = pair();
  const net = new Network(doc);
  const session = net.connect('peer', left);

  let sentBefore = 0;
  right.onMessage(() => {
    sentBefore += 1;
  });
  net.announce({ name: 'early' });
  assert.equal(session.greeted, false);
  await settle();
  // Only the handshake should have gone out, never a presence message.
  assert.equal(session.stats.sent, 1, 'just the hello');
});

test('an oversized presence message is refused', () => {
  // Presence is small by nature. A loose limit would let a peer push bulk data
  // at everyone in the room through a channel nothing else checks.
  const huge = decode(JSON.stringify({ t: 'who', who: { pad: 'x'.repeat(5000) } }));
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.why, 'presence too big');

  const fine = decode(JSON.stringify({ t: 'who', who: { name: 'Saeed' } }));
  assert.equal(fine.ok, true);
});

test('malformed presence is refused', () => {
  for (const bad of [
    JSON.stringify({ t: 'who' }),
    JSON.stringify({ t: 'who', who: 'a string' }),
    JSON.stringify({ t: 'who', who: null }),
  ]) {
    assert.equal(decode(bad).ok, false, bad);
  }
});

test('three peers all see each other', async () => {
  const netA = new Network(new Doc('aaaa'));
  const netB = new Network(new Doc('bbbb'));
  const netC = new Network(new Doc('cccc'));

  const [ab, ba] = pair();
  const [ac, ca] = pair();
  netA.connect('b', ab);
  netB.connect('a', ba);
  netA.connect('c', ac);
  netC.connect('a', ca);
  await settle();

  netA.announce({ name: 'Saeed' });
  netB.announce({ name: 'Ali' });
  netC.announce({ name: 'Zara' });
  await settle();

  assert.equal(netB.present.get('a').name, 'Saeed');
  assert.equal(netC.present.get('a').name, 'Saeed');
  assert.equal(netA.present.size, 2, 'a sees both of the others');
});
