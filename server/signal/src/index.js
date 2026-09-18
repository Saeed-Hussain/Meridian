/**
 * The introduction service.
 *
 * Two browsers cannot call each other directly: neither knows the other's
 * address, and both are usually behind a router that will not accept incoming
 * connections. WebRTC solves that, but only once the two sides have swapped a
 * short description of how to be reached. Swapping it needs a third party that
 * both can reach, and that is all this server is.
 *
 * ## What it must never become
 *
 * It relays connection details and nothing else. It never sees document text,
 * never stores anything, and is not trusted by either peer. That is the whole
 * point of the project: if this server were required for editing, Meridian
 * would just be a worse version of every other collaborative editor.
 *
 * Once two peers are connected, the changes flow between them directly, and
 * this process could be turned off without either noticing.
 *
 * ## Why the room name is a hash
 *
 * Clients join a room named after the document. A room name is therefore
 * something the server gets to see, so clients send a hash of the document id
 * rather than the id itself. The server can tell that two people want the same
 * room without learning which document that is.
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

/** How long a socket may stay silent before being cut loose. */
const IDLE_TIMEOUT = 60_000;

/** Most peers allowed in one room, to bound the cost of a full mesh. */
const MAX_PEERS = 16;

/** Largest signalling message accepted, in bytes. */
const MAX_MESSAGE = 64 * 1024;

/**
 * @typedef {object} Peer
 * @property {string} id
 * @property {import('ws').WebSocket} socket
 * @property {string} room
 * @property {number} lastSeen
 */

export class SignalServer {
  /**
   * @param {object} [options]
   * @param {number} [options.port]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    /** @type {Map<string, Map<string, Peer>>} */
    this.rooms = new Map();
    /** @type {(message: string) => void} */
    this.log = options.log ?? (() => {});

    /** @type {WebSocketServer} */
    this.wss = new WebSocketServer({ port: options.port ?? 0, maxPayload: MAX_MESSAGE });
    this.wss.on('connection', (socket) => this.accept(socket));

    // Cut loose anything that has gone quiet. A browser tab that is closed
    // abruptly, or a laptop lid that shuts, leaves a socket that looks open for
    // a long time; without this, rooms fill with peers nobody can reach.
    this.sweeper = setInterval(() => this.sweep(), IDLE_TIMEOUT / 2);
    this.sweeper.unref?.();
  }

  /** The port actually in use, which matters when 0 was requested. */
  get port() {
    const address = this.wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @private
   */
  accept(socket) {
    /** @type {Peer | null} */
    let peer = null;

    socket.on('message', (raw) => {
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return; // not our business to explain
      }
      if (message === null || typeof message !== 'object') return;

      if (message.t === 'join' && !peer) {
        peer = this.join(socket, String(message.room ?? ''));
        return;
      }
      if (!peer) return; // nothing is relayed before joining
      peer.lastSeen = Date.now();

      if (message.t === 'signal') this.relay(peer, message);
      // Anything else is ignored. This server has no opinion about the contents
      // of a signal, which keeps it working as WebRTC details change.
    });

    socket.on('close', () => {
      if (peer) this.leave(peer);
    });
    socket.on('error', () => {
      if (peer) this.leave(peer);
    });
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {string} room
   * @returns {Peer | null}
   * @private
   */
  join(socket, room) {
    // A room name is opaque to this server, but it still has to be sane before
    // being used as a key.
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(room)) {
      socket.close(4000, 'bad room');
      return null;
    }

    let peers = this.rooms.get(room);
    if (!peers) {
      peers = new Map();
      this.rooms.set(room, peers);
    }
    if (peers.size >= MAX_PEERS) {
      socket.close(4001, 'room full');
      return null;
    }

    /** @type {Peer} */
    const peer = { id: randomUUID(), socket, room, lastSeen: Date.now() };
    peers.set(peer.id, peer);

    // Tell the newcomer who is already here, and tell them a newcomer arrived.
    // The newcomer starts the WebRTC offers, which avoids both sides offering
    // at once -- a mess WebRTC calls a signalling collision.
    send(socket, { t: 'welcome', you: peer.id, peers: [...peers.keys()].filter((id) => id !== peer.id) });
    for (const other of peers.values()) {
      if (other.id !== peer.id) send(other.socket, { t: 'joined', peer: peer.id });
    }

    this.log(`peer ${peer.id.slice(0, 8)} joined ${room} (${peers.size} here)`);
    return peer;
  }

  /**
   * Pass a signal to one named peer in the same room.
   *
   * @param {Peer} from
   * @param {any} message
   * @private
   */
  relay(from, message) {
    const peers = this.rooms.get(from.room);
    const target = peers?.get(String(message.to ?? ''));
    // Silently ignored when the target is unknown or in another room. A peer
    // cannot use this server to reach anyone it was not introduced to.
    if (!target) return;
    send(target.socket, { t: 'signal', from: from.id, data: message.data });
  }

  /**
   * @param {Peer} peer
   * @private
   */
  leave(peer) {
    const peers = this.rooms.get(peer.room);
    if (!peers || !peers.delete(peer.id)) return;

    for (const other of peers.values()) {
      send(other.socket, { t: 'left', peer: peer.id });
    }
    if (peers.size === 0) this.rooms.delete(peer.room);
    this.log(`peer ${peer.id.slice(0, 8)} left ${peer.room}`);
  }

  /** @private */
  sweep() {
    const cutoff = Date.now() - IDLE_TIMEOUT;
    for (const peers of this.rooms.values()) {
      for (const peer of [...peers.values()]) {
        if (peer.lastSeen < cutoff) {
          peer.socket.close(4002, 'idle');
          this.leave(peer);
        }
      }
    }
  }

  /** @returns {Promise<void>} */
  close() {
    clearInterval(this.sweeper);
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

/**
 * Send without caring whether the socket has just died.
 *
 * @param {import('ws').WebSocket} socket
 * @param {object} message
 */
function send(socket, message) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The peer has gone. The close handler will tidy up.
  }
}
