/**
 * The introduction service, tested against a real server on a real socket.
 *
 * Node has a WebSocket client built in, so these are genuine connections over
 * TCP rather than a stand-in. That matters here: the mistakes in this kind of
 * code are in connection lifetime and message ordering, and a fake would hide
 * exactly those.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalServer } from '../src/index.js';

/** A room name of the shape the server accepts. */
const ROOM = 'a'.repeat(32);

/**
 * Connect a client and collect what it is sent.
 *
 * @param {number} port
 * @param {string} [room] Omit to connect without joining.
 * @returns {Promise<{socket: WebSocket, seen: any[], next: (type: string) => Promise<any>, send: (message: object) => void, close: () => void}>}
 */
async function client(port, room = ROOM) {
  const socket = new WebSocket(`ws://localhost:${port}`);
  /** @type {any[]} */
  const seen = [];
  /** @type {((message: any) => void)[]} */
  const waiting = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    seen.push(message);
    for (const resolve of waiting.splice(0)) resolve(message);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  /**
   * Wait for a message of a given type, or fail rather than hang.
   * @param {string} type
   * @returns {Promise<any>}
   */
  const next = async (type) => {
    const existing = seen.find((message) => message.t === type);
    if (existing) return existing;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const message = await Promise.race([
        new Promise((resolve) => waiting.push(resolve)),
        new Promise((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
      if (message && /** @type {any} */ (message).t === type) return message;
      const late = seen.find((m) => m.t === type);
      if (late) return late;
    }
    throw new Error(`never received "${type}"; got ${JSON.stringify(seen)}`);
  };

  /** @param {object} message */
  const send = (message) => socket.send(JSON.stringify(message));

  if (room) send({ t: 'join', room });

  return { socket, seen, next, send, close: () => socket.close() };
}

test('a peer is told who is already in the room', async () => {
  const server = new SignalServer();
  const first = await client(server.port);
  const hello = await first.next('welcome');
  assert.equal(hello.peers.length, 0, 'first in, nobody else here');

  const second = await client(server.port);
  const theirs = await second.next('welcome');
  assert.deepEqual(theirs.peers, [hello.you], 'told about the one already here');

  // And the one already here is told somebody arrived, which is what starts
  // the WebRTC offer.
  const joined = await first.next('joined');
  assert.equal(joined.peer, theirs.you);

  first.close();
  second.close();
  await server.close();
});

test('a signal reaches the peer it is addressed to', async () => {
  const server = new SignalServer();
  const a = await client(server.port);
  const b = await client(server.port);
  const idA = (await a.next('welcome')).you;
  const idB = (await b.next('welcome')).you;

  a.send({ t: 'signal', to: idB, data: { sdp: 'pretend offer' } });
  const relayed = await b.next('signal');

  assert.equal(relayed.from, idA);
  assert.deepEqual(relayed.data, { sdp: 'pretend offer' });

  a.close();
  b.close();
  await server.close();
});

test('a signal aimed at another room goes nowhere', async () => {
  // A peer must not be able to reach anyone it was not introduced to.
  const server = new SignalServer();
  const a = await client(server.port, 'a'.repeat(32));
  const outsider = await client(server.port, 'b'.repeat(32));
  const idOutsider = (await outsider.next('welcome')).you;
  await a.next('welcome');

  a.send({ t: 'signal', to: idOutsider, data: { secret: true } });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(
    outsider.seen.some((message) => message.t === 'signal'),
    false,
    'nothing crossed between rooms',
  );

  a.close();
  outsider.close();
  await server.close();
});

test('nothing is relayed before joining', async () => {
  const server = new SignalServer();
  const joined = await client(server.port);
  const id = (await joined.next('welcome')).you;

  // A client that never sent `join`.
  const lurker = await client(server.port, '');
  lurker.send({ t: 'signal', to: id, data: { sneaky: true } });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(
    joined.seen.some((message) => message.t === 'signal'),
    false,
  );

  joined.close();
  lurker.close();
  await server.close();
});

test('leaving tells the others', async () => {
  const server = new SignalServer();
  const a = await client(server.port);
  const b = await client(server.port);
  await a.next('welcome');
  const idB = (await b.next('welcome')).you;

  b.close();
  const left = await a.next('left');
  assert.equal(left.peer, idB);

  a.close();
  await server.close();
});

test('a nonsense room name is refused', async () => {
  const server = new SignalServer();
  for (const room of ['', 'short', 'has spaces in it and is long enough', 'x'.repeat(200)]) {
    const socket = new WebSocket(`ws://localhost:${server.port}`);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const closed = new Promise((resolve) =>
      socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
    );
    socket.send(JSON.stringify({ t: 'join', room }));
    assert.equal(await closed, 4000, `should refuse ${JSON.stringify(room)}`);
  }
  await server.close();
});

test('rubbish does not bring the server down', async () => {
  const server = new SignalServer();
  const a = await client(server.port);
  await a.next('welcome');

  for (const rubbish of ['not json', '[]', 'null', '123', '{"t":"unknown"}', '{}']) {
    a.socket.send(rubbish);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Still working afterwards: a new peer can still be introduced.
  const b = await client(server.port);
  const theirs = await b.next('welcome');
  assert.equal(theirs.peers.length, 1);

  a.close();
  b.close();
  await server.close();
});

test('the room stops accepting peers once it is full', async () => {
  const server = new SignalServer();
  /** @type {any[]} */
  const clients = [];
  for (let i = 0; i < 16; i += 1) {
    const one = await client(server.port);
    await one.next('welcome');
    clients.push(one);
  }

  const socket = new WebSocket(`ws://localhost:${server.port}`);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const closed = new Promise((resolve) =>
    socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
  );
  socket.send(JSON.stringify({ t: 'join', room: ROOM }));
  assert.equal(await closed, 4001, 'refused with "room full"');

  for (const one of clients) one.close();
  await server.close();
});

test('an empty room is forgotten', async () => {
  // Otherwise the map grows by one entry per document ever opened.
  const server = new SignalServer();
  const only = await client(server.port);
  await only.next('welcome');
  assert.equal(server.rooms.size, 1);

  only.close();
  for (let i = 0; i < 40 && server.rooms.size > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(server.rooms.size, 0, 'the room was cleaned up');

  await server.close();
});
