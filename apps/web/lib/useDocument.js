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
import { BridgeStore } from '@meridian/storage-bridge';
import { Network } from '@meridian/sync';
import { joinRoom, roomFor } from '@meridian/sync/webrtc';
import { keyFromText, keyToText, newKey } from '@meridian/sync';

/** How often to greet peers that have not confirmed they are up to date. */
const TICK = 3000;

/**
 * Shades of grey for people's markers.
 *
 * The interface has no colour in it, so people are told apart by their initial
 * and by a shade. That is a tighter constraint than a palette of hues and a
 * better one: it reads the same for anyone who cannot distinguish colours.
 *
 * These are lightness percentages, not colours, because the right grey depends
 * on the theme. A dark circle is correct on a white page and invisible on a
 * black one, so the stylesheet flips the value for dark mode. Handing it a hex
 * here would bake in an answer that is wrong half the time.
 *
 * The range stops at 46 so that white text on the lightest circle still has
 * enough contrast to read.
 */
const SHADES = [12, 19, 26, 33, 40, 46];

/**
 * The key for this document, from the link — or a new one, put into the link.
 *
 * It lives in the fragment, the part after `#`, because browsers never send a
 * fragment to a server. So the key reaches the other person through the link
 * and never reaches the introduction service, which is the whole basis of the
 * claim that the server cannot read anything.
 *
 * The consequence is worth being plain about: the link *is* the key. Anyone
 * who has it can read the document, and losing it loses the document, because
 * nothing else can decrypt it.
 *
 * @returns {Promise<CryptoKey>}
 */
async function keyForDocument() {
  const fragment = globalThis.location.hash.slice(1);
  if (fragment) {
    try {
      return await keyFromText(fragment);
    } catch {
      // A damaged key in the link. Starting a fresh one would silently split
      // the document in two, so this fails loudly instead.
      throw new Error('the key in this link is not valid');
    }
  }

  const key = await newKey();
  // `replaceState` rather than assigning to `location.hash`: the latter adds a
  // history entry, so the back button would step through the same document.
  history.replaceState(
    null,
    '',
    `${globalThis.location.pathname}${globalThis.location.search}#${await keyToText(key)}`,
  );
  return key;
}

/**
 * Where the introduction service is.
 *
 * Defaults to port 8080 on whatever host served the page, which is right for
 * `npm run signal` on the same machine. Set `NEXT_PUBLIC_SIGNAL_URL` to point
 * somewhere else — needed when 8080 is taken and the server was started on
 * another port.
 *
 * @param {string} [override]
 * @returns {string}
 */
function signalAddress(override) {
  if (override) return override;
  if (process.env.NEXT_PUBLIC_SIGNAL_URL) return process.env.NEXT_PUBLIC_SIGNAL_URL;
  const secure = globalThis.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${globalThis.location.hostname}:8080`;
}

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
  const [status, setStatus] = useState('opening');
  const [peers, setPeers] = useState([]);
  const [online, setOnline] = useState(true);
  const [saved, setSaved] = useState(true);
  const [synced, setSynced] = useState(true);
  const [steps, setSteps] = useState(0);
  /**
   * Which point in history is being looked at, or null for the present.
   *
   * While this is set the editor is read-only. Editing a past version would
   * mean deciding what to do with everything typed since, and there is no good
   * answer -- so looking and editing are kept apart.
   */
  const [viewing, setViewing] = useState(null);
  /**
   * The same value as `viewing`, readable from callbacks that must not wait
   * for a re-render — chiefly the edit handler, which has to refuse edits the
   * instant a past version is on screen.
   */
  const viewingRef = useRef(null);

  /**
   * The text this code last agreed the box was showing.
   *
   * Anything in the box that differs from this is a keystroke the document has
   * not been told about yet. That is the whole basis of the flush below: it is
   * how a change arriving from a peer can tell what it is about to trample.
   * @type {{current: string}}
   */
  const shownRef = useRef('');

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
      // On the desktop the changes go to a SQLite file through the
      // application process; in a browser there is no such process and
      // IndexedDB is the only place to put them. Both satisfy the same
      // contract and pass the same tests, so nothing below this line differs.
      const store = BridgeStore.open(id) ?? (await IdbStore.open(`meridian-${id}`));
      const { doc, saved: persistence } = await open(store, { site: tabSite(id) });
      if (!alive) return;

      docRef.current = doc;
      storeRef.current = persistence;
      showInBox(doc.toString());
      setStatus('offline');

      const net = new Network(doc, {
        onBadMessage: (why) => console.warn('ignored a message from a peer:', why),
      });
      netRef.current = net;

      // Redraw whenever the document changes, from any source. Putting the
      // cursor back is the whole reason anchors exist: a remote edit above the
      // cursor shifts every position below it.
      const stopWatching = doc.onChange(() => {
        // Write straight to the box, in the same turn. Going through React
        // state put a render between a change and the text being visible, and
        // a keystroke arriving inside that gap was inserted at the wrong
        // place. The document is the source of truth; the box is a view of it
        // that is kept exactly in step.
        showInBox(doc.toString());
        setSteps(doc.historyLength);
        setSaved(false);
        persistence.flush().then(
          () => alive && setSaved(true),
          (error) => alive && setStatus(`could not save: ${error.message}`),
        );
      });

      // Take in anything still sitting in the box before a change from a peer
      // is applied.
      //
      // The browser puts a typed character into the box and tells this code
      // about it a moment later. A change arriving inside that moment used to
      // land on a document that did not yet contain the character, so the
      // character was then placed against the wrong neighbour — two people
      // typing in one spot produced interleaved words. Applying it first puts
      // the two changes in the order they actually happened.
      const stopFlushing = doc.onBeforeChange(() => {
        const box = boxRef.current;
        if (!box || viewingRef.current !== null) return;
        if (box.value === shownRef.current) return;

        shownRef.current = box.value;
        const { change } = applyText(doc, box.value);
        if (change) {
          const end = doc.text.anchorAt(change.at + [...change.added].length);
          anchorRef.current = { start: end, end };
        }
      });

      const stopPresence = net.onPresence((present) => {
        setPeers([...present.entries()].map(([peerId, who]) => ({ id: peerId, ...who })));
      });

      // Say who we are straight away. Announcing only when the cursor moves
      // left a tab invisible to everyone until its owner happened to click
      // something, which reads as "nobody else is here" when somebody is.
      net.announce({
        name: nameRef.current,
        shade: SHADES[hash(doc.site) % SHADES.length],
        anchor: null,
      });

      // The document id is hashed before it becomes a room name, so the
      // signalling server can match two people without learning what they are
      // working on.
      const key = await keyForDocument();
      if (!alive) return;

      room = joinRoom({
        url: signalAddress(signalUrl),
        room: await roomFor(id),
        network: net,
        key,
        onUnreadable: () =>
          alive && setStatus('someone here has a different link'),
        onState: (state) => alive && setStatus(state),
      });

      setSteps(doc.historyLength);

      // Repair runs on a timer because a lost handshake has no other cure.
      // The same tick reports whether every peer has confirmed it is up to
      // date, which is the only honest basis for saying "synced".
      timer = setInterval(() => {
        net.tick();
        setSynced(net.synced);
      }, TICK);

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
            url: signalAddress(signalUrl),
            room: await roomFor(id),
            network: net,
            key,
            onState: (state) => alive && setStatus(state),
          });
        },
      };

      return () => {
        stopWatching();
        stopFlushing();
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
  const edit = useCallback((next, caretStart, caretEnd) => {
    const doc = docRef.current;
    if (!doc || viewingRef.current !== null) return;

    // What the box holds is now the document's problem, not the box's.
    // Recording it here is what lets a remote change arriving mid-keystroke
    // tell the difference between text this code has already taken in and
    // text it has not.
    shownRef.current = next;

    const { change } = applyText(doc, next);

    // The cursor goes just after whatever was typed, worked out from the
    // change itself rather than from the text box's caret.
    //
    // Reading the caret here was a real bug with a surprising symptom. The box
    // and the document disagree for a moment after every edit, and a caret
    // read inside that window points into text that no longer matches -- so
    // the anchor landed on somebody else's letter. The next keystroke then
    // attached there, and two people typing in one place produced interleaved
    // words instead of two whole ones. It came and went with timing, which is
    // exactly what made it hard to see.
    //
    // The change says where the edit was and how long it was. That is true
    // whatever the box is doing.
    if (change) {
      const end = doc.text.anchorAt(change.at + [...change.added].length);
      anchorRef.current = { start: end, end };
    }
    tellPeers(doc);
  }, []);

  /**
   * Send the current cursor, without touching it.
   *
   * @param {any} doc
   */
  function tellPeers(doc) {
    const net = netRef.current;
    if (!net) return;
    net.announce({
      name: nameRef.current,
      shade: SHADES[hash(doc.site) % SHADES.length],
      anchor: anchorRef.current.start,
      head: anchorRef.current.end,
    });
  }

  /**
   * The cursor moved by itself — a click, an arrow key, a selection.
   *
   * Here the text box and the document agree, so reading the caret is safe.
   * After an edit they do not agree yet, which is why `edit` sets the anchor
   * itself rather than calling this.
   */
  const announce = useCallback(() => {
    const doc = docRef.current;
    const box = boxRef.current;
    if (!doc || !box) return;

    rememberCursor(doc, box);
    tellPeers(doc);
  }, []);

  /**
   * Show text in the box, keeping this person's cursor where it belongs.
   *
   * Setting a text box's value moves the caret to the end, so it has to be put
   * back. The cursor is held as an anchor — the letter it sits after — which
   * is why somebody typing higher up the document does not drag it along.
   *
   * @param {string} value
   */
  function showInBox(value) {
    const doc = docRef.current;
    const box = boxRef.current;
    shownRef.current = value;
    if (!box || box.value === value) return;

    const start = doc ? doc.text.indexAfter(anchorRef.current.start) : value.length;
    const end = doc ? doc.text.indexAfter(anchorRef.current.end) : value.length;

    box.value = value;

    // Always put the caret back, focused or not. Skipping it for an unfocused
    // box left the DOM caret wherever setting the value had dropped it, and
    // the next thing to read the caret then recorded a cursor that was never
    // there -- so the following keystroke attached to the wrong letter. The
    // DOM caret and the stored anchor have to agree at all times, because
    // either one may be read next.
    box.setSelectionRange(start, end);
  }

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
    // Only trust the caret when the box and the document agree.
    //
    // They disagree for a moment after every edit, local or remote: the box
    // holds one version while the document holds another. A position read in
    // that window refers to text that no longer matches, so it silently lands
    // on a different letter -- and since `keyup` fires in exactly that window,
    // it was overwriting the correct anchor after every keystroke. The visible
    // result was two people typing in one place producing interleaved words
    // instead of two whole ones.
    if (box.value !== doc.toString()) return;

    anchorRef.current = {
      start: doc.text.anchorAt(box.selectionStart ?? 0),
      end: doc.text.anchorAt(box.selectionEnd ?? 0),
    };
  }

  /**
   * Look at the document as it was, or return to the present with null.
   *
   * The past version is built as a separate document and thrown away, so
   * nothing here can damage the real one.
   *
   * @param {number | null} step
   */
  const view = useCallback((step) => {
    const doc = docRef.current;
    if (!doc) return;

    if (step === null) {
      viewingRef.current = null;
      setViewing(null);
      showInBox(doc.toString());
      return;
    }
    viewingRef.current = step;
    setViewing(step);
    // Past versions are built as separate documents and thrown away, so
    // nothing here can disturb the real one.
    showInBox(doc.at(step).toString());
  }, []);

  return {
    edit,
    status,
    peers,
    online,
    saved,
    synced,
    boxRef,
    announce,
    doc: docRef,
    steps,
    viewing,
    view,
  };
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
