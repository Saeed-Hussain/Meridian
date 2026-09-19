/**
 * Encryption, and the one claim that has to be true: the introduction service
 * cannot read the document.
 *
 * Worth testing rather than asserting in a README. "The server never sees your
 * text" is the sort of claim that is easy to make and easy to break by
 * accident, so there is a test here that inspects exactly what crosses the
 * wire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '@meridian/core';
import { Network } from '../src/index.js';
import { encrypted, keyFromText, keyToText, newKey, open, seal } from '../src/crypto.js';
import { pair } from './helpers/channels.js';

/**
 * Let the connection finish talking.
 *
 * Turning over the microtask queue is not enough here, which the unencrypted
 * tests get away with. Web Crypto does its work off the main thread and
 * resolves on a timer turn, so encrypting and decrypting only make progress if
 * the event loop is genuinely allowed to run.
 *
 * @returns {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

test('a key survives the trip through a link', async () => {
  const key = await newKey();
  const text = await keyToText(key);

  // It has to be safe in a URL fragment, so no characters needing escaping.
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.ok(text.length >= 42, 'a 256-bit key should not fit in a few characters');

  const again = await keyFromText(text);
  assert.equal(await open(again, await seal(key, 'hello')), 'hello');
});

test('the same text encrypts differently every time', async () => {
  // If it did not, anyone watching could tell when the same thing was sent
  // twice, and reusing a nonce with AES-GCM is far worse than untidy.
  const key = await newKey();
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(await seal(key, 'the same message'));
  assert.equal(seen.size, 50);
});

test('the wrong key cannot read a message', async () => {
  const mine = await newKey();
  const theirs = await newKey();
  const sealed = await seal(mine, 'private');
  await assert.rejects(() => open(theirs, sealed));
});

test('an altered message is refused, not mangled', async () => {
  // AES-GCM authenticates as well as hides. Without that, flipping a bit would
  // quietly change what the document said.
  const key = await newKey();
  const sealed = await seal(key, 'the original text');

  const tampered = [...sealed];
  tampered[tampered.length - 2] = tampered.at(-2) === 'A' ? 'B' : 'A';
  await assert.rejects(() => open(key, tampered.join('')));

  await assert.rejects(() => open(key, 'not even base64 $$$'));
  await assert.rejects(() => open(key, 'AAAA'), 'too short to hold a nonce');
});

test('two peers holding the key sync normally', async () => {
  const key = await newKey();
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const [left, right] = pair();

  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', encrypted(left, key));
  netB.connect('a', encrypted(right, key));
  await settle();

  a.insert(0, 'hello through the lock');
  await settle();
  assert.equal(b.toString(), 'hello through the lock');

  b.insert(0, 'and back: ');
  await settle();
  assert.equal(a.toString(), b.toString());
});

test('nothing readable crosses the wire', async () => {
  // The claim in the README, checked. Everything that passes between the two
  // peers is captured and searched for the text that was typed.
  const key = await newKey();
  const secret = 'the quarterly numbers are terrible';

  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const [left, right] = pair();

  /** @type {string[]} */
  const wire = [];
  /** @param {import('../src/session.js').Channel} channel */
  const watched = (channel) => ({
    ...channel,
    send: (/** @type {string} */ data) => {
      wire.push(data);
      channel.send(data);
    },
  });

  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', encrypted(watched(left), key));
  netB.connect('a', encrypted(watched(right), key));
  await settle();

  a.insert(0, secret);
  a.setField('title', 'do not leak this either');
  await settle();

  assert.equal(b.toString(), secret, 'it did arrive');
  assert.ok(wire.length > 0, 'and something was actually sent');

  const everything = wire.join('|');
  for (const leak of [secret, 'quarterly', 'terrible', 'do not leak', 'insert', 'hello']) {
    assert.equal(
      everything.includes(leak),
      false,
      `"${leak}" appeared in what crossed the wire`,
    );
  }
});

test('a peer with the wrong key is shut out, and says so', async () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  const [left, right] = pair();

  // Both keys first. Awaiting between the two connections let A's opening
  // message arrive before B had anything listening, so it went nowhere and the
  // test saw silence instead of a refusal. The protocol recovers from that on
  // the next tick, but the test was no longer testing what it claimed to.
  const hers = await newKey();
  const his = await newKey();

  /** @type {string[]} */
  const complaints = [];
  const netA = new Network(a);
  const netB = new Network(b);
  netA.connect('b', encrypted(left, hers));
  netB.connect('a', encrypted(right, his, { onUnreadable: (why) => complaints.push(why) }));
  await settle();

  a.insert(0, 'members only');
  await settle();
  netA.tick();
  await settle();

  assert.equal(b.toString(), '', 'nothing got through');
  assert.ok(complaints.length > 0, 'and the app can tell the user why');
});

test('an encrypted connection still reports whether it is open', async () => {
  // The sync protocol asks before sending. A wrapper that always claimed to be
  // open would have it shouting into a closed connection.
  const key = await newKey();
  const [left] = pair();
  const locked = encrypted(left, key);

  assert.equal(locked.isOpen(), true);
  locked.close?.();
  assert.equal(locked.isOpen(), false);
});
