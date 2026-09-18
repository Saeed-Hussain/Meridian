/**
 * Two peers on a perfect connection, and the message checks on the way in.
 * The nasty network lives in unreliable.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '@meridian/core';
import { Network, decode, encode } from '../src/index.js';
import { pair } from './helpers/channels.js';

/**
 * Let every queued message and reply finish.
 *
 * Delivery happens on microtasks, so turning the event loop over a few dozen
 * times is enough for a handshake and everything it triggers. No timers, so
 * the tests stay fast and do not go flaky on a loaded machine.
 *
 * @returns {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

/**
 * Connect two documents and let them talk until they go quiet.
 *
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

test('a fresh peer receives the whole document', async () => {
  const a = new Doc('aaaa');
  a.insert(0, 'hello world');
  const b = new Doc('bbbb');

  await link(a, b);
  assert.equal(b.toString(), 'hello world');
});

test('changes flow both ways as they are made', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  await link(a, b);

  a.insert(0, 'from a');
  await settle();
  assert.equal(b.toString(), 'from a');

  b.insert(6, ' and b');
  await settle();
  assert.equal(a.toString(), 'from a and b');
});

test('two peers editing at once end up identical', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'ab');
  await link(a, b);

  // Neither has seen the other's edit when it is made.
  a.insert(1, 'X');
  b.insert(1, 'Y');
  await settle();

  assert.equal(a.toString(), b.toString());
  assert.match(a.toString(), /^a(XY|YX)b$/);
});

test('peers stop talking once they agree', async () => {
  // If relaying did not terminate, these two would send messages forever.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const { netA } = await link(a, b);

  a.insert(0, 'x');
  await settle();
  const session = /** @type {any} */ (netA.peers.get('b'));
  const after = session.stats.sent;
  await settle();
  assert.equal(session.stats.sent, after, 'no further messages');
});

test('a change relays to a peer that is not directly connected', async () => {
  // a — b — c, with a and c never connected to each other.
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const c = new Doc('cccc');

  const [ab, ba] = pair();
  const [bc, cb] = pair();
  const netA = new Network(a);
  const netB = new Network(b);
  const netC = new Network(c);
  netA.connect('b', ab);
  netB.connect('a', ba);
  netB.connect('c', bc);
  netC.connect('b', cb);
  await settle();

  a.insert(0, 'through b');
  await settle();
  assert.equal(c.toString(), 'through b', 'c got it via b');

  c.insert(9, ' and back');
  await settle();
  assert.equal(a.toString(), 'through b and back');
});

test('a peer behind a compacted log is sent whole state', async () => {
  const a = new Doc('aaaa');
  a.insert(0, 'early');
  a.compact(); // the individual changes no longer exist

  const b = new Doc('bbbb');
  const { netA } = await link(a, b);

  assert.equal(b.toString(), 'early');
  assert.equal(/** @type {any} */ (netA.peers.get('b')).stats.stateSent, 1);
});

test('state transfer does not destroy the receiver own work', async () => {
  const a = new Doc('aaaa');
  a.insert(0, 'from a');
  a.compact();

  const b = new Doc('bbbb');
  b.insert(0, 'from b');

  await link(a, b);
  await settle();

  assert.ok(b.toString().includes('from b'), 'b kept its work');
  assert.ok(b.toString().includes('from a'), 'and received a changes');
  assert.equal(a.toString(), b.toString(), 'both agree');
});

test('disconnecting stops the flow, reconnecting catches up', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const { netA, netB } = await link(a, b);

  netA.disconnect('b');
  netB.disconnect('a');

  a.insert(0, 'while apart');
  b.insert(0, 'also apart');
  await settle();
  assert.notEqual(a.toString(), b.toString(), 'they are out of touch');

  // A new connection, which is what a reconnect really is.
  const [left, right] = pair();
  netA.connect('b', left);
  netB.connect('a', right);
  await settle();

  assert.equal(a.toString(), b.toString(), 'the handshake repaired it');
});

test('the same peer connecting twice replaces the old session', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const { netA } = await link(a, b);
  assert.equal(netA.peerCount, 1);

  const [fresh] = pair();
  netA.connect('b', fresh);
  assert.equal(netA.peerCount, 1, 'not two sessions for one peer');
});

// ------------------------------------------------------------ message checking

test('rubbish from a peer is dropped, not fatal', async () => {
  const doc = new Doc('aaaa');
  const [left] = pair();
  /** @type {string[]} */
  const complaints = [];
  const net = new Network(doc, { onBadMessage: (why) => complaints.push(why) });
  const session = net.connect('peer', left);

  const nonsense = [
    'not json at all',
    '[]',
    'null',
    '42',
    JSON.stringify({ t: 'hello' }),
    JSON.stringify({ t: 'hello', v: { site: 'not a number' } }),
    JSON.stringify({ t: 'hello', v: { site: -1 } }),
    JSON.stringify({ t: 'ops' }),
    JSON.stringify({ t: 'ops', ops: 'nope' }),
    JSON.stringify({ t: 'ops', ops: [{ type: 'insert' }] }),
    JSON.stringify({ t: 'ops', ops: [{ type: 'insert', id: 'no counter@x' }] }),
    JSON.stringify({ t: 'state', state: 'nope' }),
    JSON.stringify({ t: 'from the future' }),
  ];
  for (const bad of nonsense) session.receive(bad);

  assert.equal(complaints.length, nonsense.length, 'each one was refused');
  assert.equal(doc.toString(), '', 'nothing was applied');
});

test('a batch with one bad change is refused whole', () => {
  // Accepting the good half would apply a change with no usable id, which could
  // then be applied again and again.
  const result = decode(
    JSON.stringify({
      t: 'ops',
      ops: [
        { type: 'insert', id: '1@aaaa', parent: null, value: 'a' },
        { type: 'insert', id: '', parent: null, value: 'b' },
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test('an enormous message is refused before it is parsed', () => {
  const result = decode('x'.repeat(33 * 1024 * 1024));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.why, 'too big');
});

test('good messages survive a round trip', () => {
  /** @type {any[]} */
  const messages = [
    { t: 'hello', v: { aaaa: 3 }, r: false },
    { t: 'hello', v: { aaaa: 3 }, r: true },
    { t: 'want' },
    { t: 'ops', ops: [{ type: 'delete', id: '2@bbbb', target: '1@aaaa' }] },
    { t: 'state', state: { version: 1 } },
  ];
  for (const message of messages) {
    const result = decode(encode(message));
    assert.equal(result.ok, true, `${message.t} should decode`);
    if (result.ok) assert.deepEqual(result.message, message);
  }
});
