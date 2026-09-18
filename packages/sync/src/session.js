/**
 * One connection to one peer.
 *
 * ## The idea that makes this small
 *
 * There is no message queue and no retry logic in this file, and that is
 * deliberate rather than unfinished.
 *
 * Every connection starts with both sides saying "here is everything I have".
 * From that one message each side can work out exactly what the other is
 * missing. So a dropped message, a connection that died mid-sentence, or a
 * laptop that was shut for a week all have the same cure: reconnect and say
 * hello again.
 *
 * That is why sends are allowed to fail silently here. Anything lost is
 * re-derived at the next handshake, and a queue that tried to guarantee
 * delivery would be a second, weaker copy of a mechanism that already works.
 *
 * What a handshake cannot do on its own is survive being lost. On a link that
 * drops a third of its messages, the hello itself goes missing, and then
 * neither side says anything more. So a handshake is not a one-off: a peer that
 * has not confirmed it holds our latest changes gets greeted again on the next
 * `Network.tick`. Repeating a cheap, idempotent summary until the other side
 * agrees is the whole repair mechanism, and it needs no retransmit buffers or
 * acknowledgement numbers to work.
 *
 * The one thing this file must get right is not sending changes it cannot
 * produce. A peer that asks for changes which have been compacted away must be
 * sent whole state instead — silence would leave it quietly wrong forever.
 */

import { decode, encode } from './protocol.js';

/** @typedef {import('@meridian/core').Doc} Doc */
/** @typedef {import('./protocol.js').Message} Message */
/** @typedef {import('@meridian/core/src/oplog.js').Op} Op */

/**
 * A two-way pipe that carries text. A WebRTC data channel and a WebSocket both
 * fit this shape, which is why nothing below mentions either.
 *
 * @typedef {object} Channel
 * @property {(data: string) => void} send
 * @property {(handler: (data: string) => void) => void} onMessage
 * @property {() => boolean} isOpen
 * @property {(handler: () => void) => void} [onClose]
 * @property {() => void} [close]
 */

export class Session {
  /**
   * @param {Doc} doc
   * @param {Channel} channel
   * @param {object} [options]
   * @param {string} [options.id] A name for this peer, used in logs and tests.
   * @param {(why: string, data: unknown) => void} [options.onBadMessage]
   * @param {(who: any) => void} [options.onPresence]
   */
  constructor(doc, channel, options = {}) {
    /** @type {Doc} */
    this.doc = doc;
    /** @type {Channel} */
    this.channel = channel;
    /** @type {string} */
    this.id = options.id ?? 'peer';
    /** @type {(why: string, data: unknown) => void} */
    this.onBadMessage = options.onBadMessage ?? (() => {});
    /** @type {(who: any) => void} */
    this.onPresence = options.onPresence ?? (() => {});

    /** True once the peer has told us what it has. @type {boolean} */
    this.greeted = false;
    /**
     * What the peer said it held, the last time it said anything.
     *
     * This doubles as the acknowledgement. Nothing in the protocol says
     * "received", so the only evidence that a peer got our changes is its next
     * hello showing a version that includes them. Until then we assume it did
     * not, and `caughtUp` stays false.
     * @type {import('@meridian/core/src/oplog.js').Version | null}
     */
    this.theirVersion = null;
    /**
     * The peer version we last sent whole state for.
     *
     * Two greetings carrying the same version arrive on a normal connect —
     * their opening hello and their answer to ours — and without this the
     * entire document would be sent twice every time. Cleared on each tick, so
     * a lost state message is still retried.
     * @type {string | null}
     */
    this.lastStateFor = null;
    /** @type {boolean} */
    this.closed = false;
    /** Counters, for the tests and for a status display. */
    this.stats = { sent: 0, received: 0, dropped: 0, stateSent: 0, stateReceived: 0 };

    channel.onMessage((data) => this.receive(data));
    channel.onClose?.(() => {
      this.closed = true;
    });
  }

  /**
   * Say hello. Both sides do this; whoever is first does not matter.
   *
   * @param {boolean} [isAnswer] True when replying to someone else's hello.
   */
  start(isAnswer = false) {
    this.send({ t: 'hello', v: this.doc.version(), r: isAnswer });
  }

  /**
   * Everything a peer needs to catch up, in one go.
   *
   * This is what a tick sends, and it is two things rather than one:
   *
   *   1. a hello, to find out what the peer has now, and
   *   2. the changes we already know it is missing.
   *
   * The second half is easy to leave out and breaks the protocol when it is.
   * A tick that only greeted would wait for a reply before sending anything,
   * and a peer that holds nothing of its own believes it is up to date and so
   * never greets first. Both sides then sit silently, each waiting for the
   * other, while the documents differ.
   */
  repair() {
    // A fresh attempt, so a whole-document send is allowed again. Without this
    // reset, a state message lost in transit would never be sent a second time.
    this.lastStateFor = null;
    this.start();
    if (this.theirVersion) this.answer(this.theirVersion);
  }

  /**
   * Handle one piece of text from the peer.
   *
   * @param {unknown} data
   */
  receive(data) {
    const result = decode(data);
    if (!result.ok) {
      this.stats.dropped += 1;
      this.onBadMessage(result.why, data);
      return;
    }
    this.stats.received += 1;
    const message = result.message;

    switch (message.t) {
      case 'hello':
        this.greeted = true;
        this.theirVersion = message.v;
        this.answer(message.v);
        // Answer with our own version, unless this was itself an answer.
        if (!message.r) this.start(true);
        break;

      case 'ops':
        // Changes the peer relayed that we already hold produce nothing, which
        // is what stops two connected peers echoing forever.
        this.doc.receive(message.ops);
        break;

      case 'want':
        this.sendState();
        break;

      case 'state':
        // A merge, not a load. Overwriting would throw away local work the
        // sender has never seen.
        this.doc.mergeState(message.state);
        this.stats.stateReceived += 1;
        break;

      case 'who':
        // Presence never touches the document. It is who is here right now,
        // not what was written, so it is not saved, not merged and not synced
        // -- and a peer going quiet simply stops being present.
        this.onPresence(message.who);
        break;

      default:
        break;
    }
  }

  /**
   * Reply to a peer that has told us what it holds.
   *
   * @param {import('@meridian/core/src/oplog.js').Version} theirs
   * @private
   */
  answer(theirs) {
    if (this.doc.log.tooFarBehind(theirs)) {
      // We cannot produce the changes they need, because they were compacted
      // away. Whole state is the only correct answer.
      const key = JSON.stringify(theirs);
      if (this.lastStateFor !== key) {
        this.lastStateFor = key;
        this.sendState();
      }
      return;
    }

    const missing = this.doc.missing(theirs);
    if (missing.length > 0) this.send({ t: 'ops', ops: missing });

    // Nothing is requested from the peer here, and that is worth explaining.
    //
    // The obvious move is to ask for whole state whenever the peer claims
    // changes we lack. It is also unnecessary: every hello is answered with a
    // hello, so the peer runs this same check against our version and sends
    // state itself if it cannot enumerate what we need. Asking as well sent the
    // entire document twice — once from their hello, once from our request.
    //
    // `want` stays in the protocol for a client that wants state immediately
    // rather than a replay of the history.
  }

  /**
   * Send changes to this peer, if it is caught up enough to use them.
   *
   * @param {Op[]} ops
   */
  sendOps(ops) {
    if (ops.length === 0 || !this.greeted) return;
    this.send({ t: 'ops', ops });
  }

  /**
   * Whether this peer is known to hold everything we hold.
   *
   * Only its own hello can prove that, so this stays false from the moment we
   * make a change until the peer reports a version that covers it. False means
   * "keep trying", which is what `Network.tick` does.
   *
   * @returns {boolean}
   */
  caughtUp() {
    if (!this.greeted || this.theirVersion === null) return false;
    const mine = this.doc.version();
    for (const [site, upto] of Object.entries(mine)) {
      if (upto > (this.theirVersion[site] ?? 0)) return false;
    }
    return true;
  }

  /**
   * Tell this peer where our cursor is and who we are.
   *
   * Sent only once the peer has greeted us, because a presence message before
   * the handshake would be about a document they have not loaded yet.
   *
   * @param {any} who
   */
  sendPresence(who) {
    if (!this.greeted) return;
    this.send({ t: 'who', who });
  }

  /** Send the whole document. */
  sendState() {
    this.send({ t: 'state', state: this.doc.snapshot() });
    this.stats.stateSent += 1;
  }

  /**
   * @param {Message} message
   * @private
   */
  send(message) {
    if (this.closed || !this.channel.isOpen()) return;
    try {
      this.channel.send(encode(message));
      this.stats.sent += 1;
    } catch {
      // Nothing to do and nothing to report. The next handshake works out what
      // this peer is missing, so a failed send costs a round trip, not data.
    }
  }

  /** Stop talking to this peer. */
  close() {
    this.closed = true;
    this.channel.close?.();
  }
}
