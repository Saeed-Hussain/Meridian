/**
 * The WebRTC transport: turning an introduction into a direct connection.
 *
 * This is the only file in the project that knows WebRTC exists. Everything
 * above it deals in a `Channel`, which is anything that carries strings, and
 * that is what let the protocol be tested over a fake network that drops and
 * reorders messages.
 *
 * ## Honesty about testing
 *
 * There are no automated tests for this file, and it is the weakest part of the
 * project as a result. `RTCPeerConnection` does not exist in Node, so it cannot
 * be exercised the way the rest of the code is. Verification happens in week 9
 * against two real browser tabs.
 *
 * The consolation is how little logic is here. Everything that can be got wrong
 * about *syncing* lives in the tested code; this file only opens a pipe and
 * hands it over. If it is broken, nothing works at all — which is a much easier
 * failure to notice than a subtle one.
 *
 * ## Who offers
 *
 * When two peers meet, exactly one must make the offer, or both send one at
 * once and the handshake collapses. WebRTC calls that a signalling collision.
 * The rule here: the peer that arrives last offers, because the signalling
 * server tells a newcomer who is already present and tells the others that
 * somebody joined.
 */

import { encrypted } from './crypto.js';

/** @typedef {import('./session.js').Channel} Channel */

/**
 * Public STUN servers, used to discover this machine's address from outside.
 *
 * These see an address and nothing else, never document content. Direct
 * connection fails anyway for a minority of strict networks — symmetric NAT,
 * some corporate firewalls — and the honest answer there is a relay, which is
 * not built yet and is noted as missing rather than pretended about.
 */
export const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/**
 * Wrap a data channel so the sync protocol can use it.
 *
 * @param {RTCDataChannel} channel
 * @returns {Channel}
 */
export function channelFor(channel) {
  /** @type {(data: string) => void} */
  let handler = () => {};
  /** @type {() => void} */
  let onClose = () => {};

  channel.addEventListener('message', (event) => handler(String(event.data)));
  channel.addEventListener('close', () => onClose());

  return {
    send: (data) => channel.send(data),
    onMessage: (next) => {
      handler = next;
    },
    onClose: (next) => {
      onClose = next;
    },
    isOpen: () => channel.readyState === 'open',
    close: () => channel.close(),
  };
}

/**
 * One direct connection to one peer.
 *
 * Give it a way to send signalling messages and feed it the ones that arrive;
 * it reports a `Channel` when the connection is ready.
 */
export class PeerLink {
  /**
   * @param {object} options
   * @param {boolean} options.offering True if this side starts the handshake.
   * @param {(data: any) => void} options.signal Send a signalling message to the peer.
   * @param {(channel: Channel) => void} options.onOpen
   * @param {() => void} [options.onClose]
   * @param {RTCIceServer[]} [options.ice]
   */
  constructor(options) {
    /** @type {RTCPeerConnection} */
    this.pc = new RTCPeerConnection({ iceServers: options.ice ?? DEFAULT_ICE });
    this.options = options;
    /** @type {boolean} */
    this.opened = false;

    this.pc.addEventListener('icecandidate', (event) => {
      // A null candidate means gathering has finished, and there is nothing
      // useful to send.
      if (event.candidate) options.signal({ candidate: event.candidate.toJSON() });
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'closed') options.onClose?.();
    });

    if (options.offering) {
      // Ordered and reliable, so the protocol above does not have to cope with
      // a channel that reorders. It copes anyway -- there are tests for it --
      // but there is no reason to choose the harder mode.
      const channel = this.pc.createDataChannel('meridian', { ordered: true });
      this.watch(channel);
      this.offer();
    } else {
      this.pc.addEventListener('datachannel', (event) => this.watch(event.channel));
    }
  }

  /**
   * @param {RTCDataChannel} channel
   * @private
   */
  watch(channel) {
    channel.addEventListener('open', () => {
      if (this.opened) return;
      this.opened = true;
      this.options.onOpen(channelFor(channel));
    });
  }

  /** @private */
  async offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.options.signal({ description: this.pc.localDescription?.toJSON() });
  }

  /**
   * Feed in a signalling message that arrived from the peer.
   *
   * @param {any} data
   * @returns {Promise<void>}
   */
  async accept(data) {
    if (data?.description) {
      await this.pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.options.signal({ description: this.pc.localDescription?.toJSON() });
      }
      return;
    }
    if (data?.candidate) {
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch {
        // A candidate can arrive before the description it belongs to, or be
        // stale. Losing one costs a slower connection, not a broken one, so
        // there is nothing worth reporting.
      }
    }
  }

  close() {
    this.pc.close();
  }
}

/**
 * Join a room and keep a direct connection to everyone in it.
 *
 * @param {object} options
 * @param {string} options.url The signalling server, e.g. `ws://localhost:8080`.
 * @param {string} options.room A hash of the document id -- never the id itself,
 *   because the signalling server would then know which document this is.
 * @param {import('./network.js').Network} options.network
 * @param {CryptoKey} [options.key]
 *   Locks everything crossing the connection. It never leaves this machine —
 *   it lives in the link's fragment, which browsers do not send to a server.
 * @param {(why: string) => void} [options.onUnreadable]
 * @param {RTCIceServer[]} [options.ice]
 * @param {(state: string) => void} [options.onState]
 * @returns {{close: () => void}}
 */
export function joinRoom(options) {
  const socket = new WebSocket(options.url);
  /** @type {Map<string, PeerLink>} */
  const links = new Map();

  /** @param {object} message */
  const send = (message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  /**
   * @param {string} id
   * @param {boolean} offering
   * @returns {PeerLink}
   */
  const linkTo = (id, offering) => {
    const existing = links.get(id);
    if (existing) return existing;

    const link = new PeerLink({
      offering,
      ice: options.ice,
      signal: (data) => send({ t: 'signal', to: id, data }),
      onOpen: (channel) =>
        options.network.connect(
          id,
          // Locked at the transport, so the protocol above neither knows nor
          // cares. Without a key the connection is in the clear, which is only
          // ever right for a local test.
          options.key ? encrypted(channel, options.key, { onUnreadable: options.onUnreadable }) : channel,
        ),
      onClose: () => {
        options.network.disconnect(id);
        links.delete(id);
      },
    });
    links.set(id, link);
    return link;
  };

  socket.addEventListener('open', () => {
    send({ t: 'join', room: options.room });
    options.onState?.('connecting');
  });

  socket.addEventListener('message', (event) => {
    /** @type {any} */
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    switch (message.t) {
      case 'welcome':
        // We arrived last, so we offer to everyone already here.
        for (const id of message.peers ?? []) linkTo(String(id), true);
        // Deliberately not reporting a peer count here. This number is true
        // for one instant and then rots: it said "0 peers here" while someone
        // else's cursor was on screen. Who is present is presence's job, and
        // presence is live.
        options.onState?.('connected');
        break;

      case 'joined':
        // Somebody arrived after us; they will offer, so just be ready.
        linkTo(String(message.peer), false);
        break;

      case 'signal': {
        const link = links.get(String(message.from));
        // A signal from a peer we have no link for means we missed the join
        // notice; answering as the non-offering side is the safe assumption.
        (link ?? linkTo(String(message.from), false)).accept(message.data);
        break;
      }

      case 'left': {
        links.get(String(message.peer))?.close();
        links.delete(String(message.peer));
        options.network.disconnect(String(message.peer));
        break;
      }

      default:
        break;
    }
  });

  socket.addEventListener('close', () => options.onState?.('not connected'));

  return {
    close: () => {
      for (const link of links.values()) link.close();
      links.clear();
      socket.close();
    },
  };
}

/**
 * Turn a document id into a room name the signalling server can key on without
 * learning the id itself.
 *
 * @param {string} documentId
 * @returns {Promise<string>}
 */
export async function roomFor(documentId) {
  const bytes = new TextEncoder().encode(`meridian-room:${documentId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
