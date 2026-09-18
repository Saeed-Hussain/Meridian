/**
 * All the peers at once.
 *
 * This is what the app talks to: hand it a document, hand it connections as
 * they open, and local changes go out while remote changes come in.
 *
 * ## Relaying, and why it terminates
 *
 * Changes received from one peer are passed on to the others. Without that, a
 * group where everyone is connected to one person but not to each other would
 * never fully sync.
 *
 * Relaying in a loop sounds like it should never stop — A tells B, B tells A —
 * and it stops for a precise reason: `Doc.receive` reports only the changes
 * that were *new*, and only those are relayed. The second time a change comes
 * round there is nothing to pass on, so it dies there. The change ids do the
 * work that a hop counter or a seen-list would otherwise have to.
 *
 * The sender is skipped anyway, which saves a round trip rather than being
 * required for correctness.
 */

import { Session } from './session.js';

/** @typedef {import('@meridian/core').Doc} Doc */
/** @typedef {import('./session.js').Channel} Channel */

export class Network {
  /**
   * @param {Doc} doc
   * @param {object} [options]
   * @param {(why: string, data: unknown) => void} [options.onBadMessage]
   */
  constructor(doc, options = {}) {
    /** @type {Doc} */
    this.doc = doc;
    /** @type {Map<string, Session>} */
    this.peers = new Map();
    /** @type {(why: string, data: unknown) => void} */
    this.onBadMessage = options.onBadMessage ?? (() => {});

    /**
     * Who else is here, and where their cursor is.
     *
     * Deliberately separate from the document. Presence is about this moment —
     * it is never saved, never merged, and never reaches a peer who was
     * offline. Storing it in the document would mean a cursor position from
     * last Tuesday syncing forever.
     * @type {Map<string, any>}
     */
    this.present = new Map();
    /** @type {Set<(present: Map<string, any>) => void>} */
    this.presenceWatchers = new Set();
    /** @type {any} */
    this.me = null;

    /**
     * The peer whose changes are being applied right now, so that they are not
     * sent straight back to it.
     * @type {string | null}
     * @private
     */
    this.applying = null;

    this.stopWatching = doc.onChange((ops) => {
      if (ops.length === 0) return; // a whole-state merge, nothing to relay
      for (const [id, session] of this.peers) {
        if (id !== this.applying) session.sendOps(ops);
      }
    });
  }

  /**
   * Add a peer and greet it.
   *
   * @param {string} id
   * @param {Channel} channel
   * @returns {Session}
   */
  connect(id, channel) {
    this.disconnect(id); // replace any stale session for this peer

    const session = new Session(this.doc, channel, {
      id,
      onBadMessage: (why, data) => this.onBadMessage(why, data),
      onPresence: (who) => {
        this.present.set(id, who);
        for (const watch of this.presenceWatchers) watch(this.present);
      },
    });

    // Mark which peer we are applying changes from, so the relay skips it.
    const receive = session.receive.bind(session);
    session.receive = (data) => {
      const previous = this.applying;
      this.applying = id;
      try {
        receive(data);
      } finally {
        this.applying = previous;
      }
    };

    this.peers.set(id, session);
    session.start();
    return session;
  }

  /**
   * @param {string} id
   */
  disconnect(id) {
    const session = this.peers.get(id);
    if (!session) return;
    session.close();
    this.peers.delete(id);

    // A peer that has gone is no longer present. Leaving a ghost cursor on
    // screen after someone closes their laptop is worse than showing nobody.
    if (this.present.delete(id)) {
      for (const watch of this.presenceWatchers) watch(this.present);
    }
  }

  /**
   * Say who we are and where our cursor is.
   *
   * Sent to everyone, and repeated to a peer that connects later, so a
   * newcomer sees existing cursors rather than an empty room until the next
   * time somebody moves.
   *
   * @param {any} who
   */
  announce(who) {
    this.me = who;
    for (const session of this.peers.values()) session.sendPresence(who);
  }

  /**
   * @param {(present: Map<string, any>) => void} watcher
   * @returns {() => void} Call to stop watching.
   */
  onPresence(watcher) {
    this.presenceWatchers.add(watcher);
    return () => this.presenceWatchers.delete(watcher);
  }

  /** @returns {number} */
  get peerCount() {
    return this.peers.size;
  }

  /**
   * Greet any peer that has not confirmed it is up to date.
   *
   * The app should call this on a timer — a few seconds is plenty. It is the
   * repair mechanism for everything the network can do to us: a lost message, a
   * partition that looked like a working connection, a laptop that was shut for
   * a week.
   *
   * It costs one small message per peer that is behind, and nothing at all once
   * everybody agrees, so it can run forever without being a burden.
   *
   * @returns {number} How many peers were greeted.
   */
  tick() {
    let greeted = 0;
    for (const session of this.peers.values()) {
      // Presence rides along with the repair tick. It is cheap, and it means
      // a peer that missed an announcement is not left with a stale cursor.
      if (this.me !== null) session.sendPresence(this.me);
      if (session.caughtUp()) continue;
      session.repair();
      greeted += 1;
    }
    return greeted;
  }

  /**
   * Say hello to everyone, whether or not they look caught up.
   *
   * Use after waking from sleep, where a connection may look fine and have
   * missed a great deal.
   */
  resync() {
    for (const session of this.peers.values()) session.repair();
  }

  /** @returns {boolean} True when every peer has confirmed it is up to date. */
  get synced() {
    for (const session of this.peers.values()) if (!session.caughtUp()) return false;
    return true;
  }

  /** Close every connection. */
  close() {
    this.stopWatching();
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }
}
