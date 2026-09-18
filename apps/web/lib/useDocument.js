'use client';

/**
 * Wiring a document to the screen, to disk, and to other people.
 *
 * Everything difficult already happened in the packages this imports. What is
 * left is the awkward part of a collaborative editor that no algorithm helps
 * with: React wants to own the text box, and so does the document.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { open, applyText } from '@meridian/core';
import { IdbStore } from '@meridian/storage-idb';
import { Network } from '@meridian/sync';
import { joinRoom, roomFor } from '@meridian/sync/webrtc';

/** How often to greet peers that have not confirmed they are up to date. */
const TICK = 3000;

const COLOURS = ['#e0544e', '#2d7ff9', '#37a06a', '#b45bd6', '#d98324', '#0f9bb5'];

/**
 * This tab's device id.
 *
 * Two tabs of the same browser share one IndexedDB, so they cannot share a
 * device id: their change ids would collide and each would silently throw the
 * other's edits away as duplicates. They are two replicas and need two names.
 *
 * `sessionStorage` is per tab and survives a reload, which is exactly the
 * lifetime wanted — the same tab keeps its identity when refreshed, and a
 * closed tab's identity is retired.
 *
 * @param {string} id
 * @returns {string}
 */
function tabSite(id) {
  const key = `meridian-site-${id}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;

  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const site = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(key, site);
  return site;
}

/**
 * @param {object} options
 * @param {string} options.id The document id, which never leaves this machine.
 * @param {string} options.name What to call yourself to other people.
 * @param {string} [options.signalUrl]
 * @returns {object}
 */
export function useDocument({ id, name, signalUrl }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('opening');
  const [peers, setPeers] = useState([]);
  const [online, setOnline] = useState(true);
  const [saved, setSaved] = useState(true);

  const nameRef = useRef(name);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  const docRef = useRef(null);
  const netRef = useRef(null);
  const storeRef = useRef(null);
  const boxRef = useRef(null);

  /**
   * Where the cursor is, remembered as the letter it sits after rather than as
   * a number. A number would be wrong the moment anybody typed above it.
   */
  const anchorRef = useRef({ start: null, end: null });

  // ------------------------------------------------------------------ opening

  useEffect(() => {
    let alive = true;
    /** @type {any} */
    let room = null;
    /** @type {any} */
    let timer = null;

    (async () => {
      const store = await IdbStore.open(`meridian-${id}`);
      const { doc, saved: persistence } = await open(store, { site: tabSite(id) });
      if (!alive) return;

      docRef.current = doc;
      storeRef.current = persistence;
      setText(doc.toString());
      setStatus('offline');

      const net = new Network(doc, {
        onBadMessage: (why) => console.warn('ignored a message from a peer:', why),
      });
      netRef.current = net;

      // Redraw whenever the document changes, from any source. Putting the
      // cursor back is the whole reason anchors exist: a remote edit above the
      // cursor shifts every position below it.
      const stopWatching = doc.onChange(() => {
        setText(doc.toString());
        setSaved(false);
        persistence.flush().then(
          () => alive && setSaved(true),
          (error) => alive && setStatus(`could not save: ${error.message}`),
        );
      });

      const stopPresence = net.onPresence((present) => {
        setPeers([...present.entries()].map(([peerId, who]) => ({ id: peerId, ...who })));
      });

      // Say who we are straight away. Announcing only when the cursor moves
      // left a tab invisible to everyone until its owner happened to click
      // something, which reads as "nobody else is here" when somebody is.
      net.announce({
        name: nameRef.current,
        colour: COLOURS[hash(doc.site) % COLOURS.length],
        anchor: null,
      });

      // The document id is hashed before it becomes a room name, so the
      // signalling server can match two people without learning what they are
      // working on.
      room = joinRoom({
        url: signalUrl ?? `ws://${globalThis.location.hostname}:8080`,
        room: await roomFor(id),
        network: net,
        onState: (state) => alive && setStatus(state),
      });

      // Repair runs on a timer because a lost handshake has no other cure.
      timer = setInterval(() => net.tick(), TICK);

      // A handle for driving the app from outside: the browser test uses it to
      // cut the connection and put it back, which nothing else can do. Turning
      // off the network in a testing tool blocks web requests but leaves an
      // established peer connection alone, so "offline" has to be asked for.
      //
      // It exposes no more than the page already has, and a "work offline"
      // button would use exactly the same two calls.
      globalThis.__meridian = {
        doc,
        net,
        offline() {
          room?.close();
          room = null;
          for (const peer of [...net.peers.keys()]) net.disconnect(peer);
        },
        async online() {
          if (room) return;
          room = joinRoom({
            url: signalUrl ?? `ws://${globalThis.location.hostname}:8080`,
            room: await roomFor(id),
            network: net,
            onState: (state) => alive && setStatus(state),
          });
        },
      };

      return () => {
        stopWatching();
        stopPresence();
      };
    })().catch((error) => {
      if (alive) setStatus(`failed to open: ${error.message}`);
    });

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      room?.close();
      netRef.current?.close();
      storeRef.current?.close();
    };
  }, [id, signalUrl]);

  // ----------------------------------------------------------------- the box

  /**
   * The text box changed. Work out the smallest edit that explains it and
   * apply that, rather than replacing the document.
   *
   * @param {string} next
   */
  const edit = useCallback((next) => {
    const doc = docRef.current;
    if (!doc) return;

    const box = boxRef.current;
    if (box) rememberCursor(doc, box);

    applyText(doc, next);
    announce();
  }, []);

  /** Tell the other people where this cursor is now. */
  const announce = useCallback(() => {
    const doc = docRef.current;
    const net = netRef.current;
    const box = boxRef.current;
    if (!doc || !net || !box) return;

    rememberCursor(doc, box);
    net.announce({
      name: nameRef.current,
      colour: COLOURS[hash(doc.site) % COLOURS.length],
      anchor: anchorRef.current.start,
      head: anchorRef.current.end,
    });
  }, [name]);

  /**
   * Put the cursor back where it belongs after a redraw.
   *
   * React resets a controlled text box's selection to the end whenever its
   * value changes, so without this every keystroke — and every remote edit —
   * would throw the cursor to the bottom of the document.
   */
  useEffect(() => {
    const doc = docRef.current;
    const box = boxRef.current;
    if (!doc || !box || document.activeElement !== box) return;

    const start = doc.text.indexAfter(anchorRef.current.start);
    const end = doc.text.indexAfter(anchorRef.current.end);
    if (box.selectionStart !== start || box.selectionEnd !== end) {
      box.setSelectionRange(start, end);
    }
  }, [text]);

  // Offline and online are worth showing honestly: the app keeps working
  // either way, which is the entire promise, and the user should be able to
  // see that rather than take it on trust.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    globalThis.addEventListener('online', update);
    globalThis.addEventListener('offline', update);
    return () => {
      globalThis.removeEventListener('online', update);
      globalThis.removeEventListener('offline', update);
    };
  }, []);

  /**
   * @param {any} doc
   * @param {HTMLTextAreaElement} box
   */
  function rememberCursor(doc, box) {
    anchorRef.current = {
      start: doc.text.anchorAt(box.selectionStart ?? 0),
      end: doc.text.anchorAt(box.selectionEnd ?? 0),
    };
  }

  return { text, edit, status, peers, online, saved, boxRef, announce, doc: docRef };
}

/**
 * A small stable number from a string, used only to pick a colour.
 *
 * @param {string} value
 * @returns {number}
 */
function hash(value) {
  let total = 0;
  for (const character of value) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return total;
}
