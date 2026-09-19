'use client';

import { use, useEffect, useState } from 'react';
import { useDocument } from '../../../lib/useDocument.js';
import { ThemeToggle } from '../../theme.jsx';

/**
 * The editor.
 *
 * @param {{params: Promise<{id: string}>}} props
 */
export default function DocumentPage({ params }) {
  const { id } = use(params);
  const [name, setName] = useState('');

  // The name is only ever shown to the people in this room, and lives here
  // rather than anywhere shared.
  useEffect(() => {
    const saved = localStorage.getItem('meridian-name');
    setName(saved || `Guest ${Math.floor(Math.random() * 900 + 100)}`);
  }, []);

  useEffect(() => {
    if (name) localStorage.setItem('meridian-name', name);
  }, [name]);

  const {
    edit,
    status,
    peers,
    online,
    saved,
    synced,
    boxRef,
    announce,
    steps,
    viewing,
    view,
  } = useDocument({ id, name: name || 'Guest' });

  const reading = viewing !== null;

  return (
    <main className="editor">
      <header className="bar">
        <input
          className="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Your name"
          maxLength={24}
          spellCheck={false}
        />

        <div className="people">
          {peers.map((peer) => (
            <span
              key={peer.id}
              className="face"
              data-peer
              style={{ '--shade': peer.shade }}
              title={peer.name ?? 'someone'}
            >
              {initial(peer.name)}
            </span>
          ))}
          {peers.length === 0 && <span className="alone">only you</span>}
        </div>

        <span className="spacer" />

        <div className="status">
          <span className="pip" data-on={online} aria-hidden="true" />
          <span>{connectionLabel({ online, peers, synced, status })}</span>
          <span className="divider" aria-hidden="true">
            /
          </span>
          <span>{saved ? 'saved' : 'saving'}</span>
        </div>

        <ThemeToggle />
      </header>

      <textarea
        ref={boxRef}
        className="paper"
        data-editor
        data-reading={reading}
        readOnly={reading}
        defaultValue=""
        onChange={(event) =>
          edit(event.target.value, event.target.selectionStart, event.target.selectionEnd)
        }
        // Editing sets the cursor itself, from the change. These cover the
        // cases where the user moves it without editing.
        //
        // Narrowing this further to arrow keys and clicks was tried and made
        // things measurably worse, so it stays broad.
        onSelect={announce}
        onClick={announce}
        placeholder="Start typing. Close the tab, turn off your internet, come back — it is all still here."
        spellCheck={false}
      />

      {/* Nothing to scrub through until something has been typed. */}
      {steps > 0 && (
        <div className="history">
          <input
            type="range"
            className="scrub"
            data-scrub
            min={0}
            max={steps}
            value={viewing ?? steps}
            aria-label="Step back through the document's history"
            onChange={(event) => {
              const step = Number(event.target.value);
              view(step >= steps ? null : step);
            }}
          />
          {reading ? (
            <button type="button" className="button quiet" data-now onClick={() => view(null)}>
              Back to now
            </button>
          ) : (
            <span className="meta">{steps} changes</span>
          )}
        </div>
      )}

      <footer className="foot">
        <p>
          {reading
            ? 'Reading an earlier version. Editing is off until you come back to now.'
            : 'Share this page’s address to invite someone. The id is hashed before it reaches the server, so the introduction service never learns which document this is.'}
        </p>
      </footer>
    </main>
  );
}

/**
 * The letter shown on someone's marker.
 *
 * @param {string | undefined} name
 * @returns {string}
 */
function initial(name) {
  const trimmed = (name ?? '').trim();
  return trimmed ? [...trimmed][0].toUpperCase() : '?';
}

/**
 * What to say about the connection.
 *
 * Deliberately never claims more than is known. "Synced" means every peer has
 * confirmed it holds everything this device holds — not merely that a message
 * was sent — and with nobody connected there is nothing to be synced with.
 *
 * @param {{online: boolean, peers: any[], synced: boolean, status: string}} state
 * @returns {string}
 */
function connectionLabel({ online, peers, synced, status }) {
  if (!online) return 'offline';
  if (peers.length === 0) return status;
  const who = `${peers.length} other${peers.length === 1 ? '' : 's'}`;
  return synced ? `${who} · synced` : `${who} · syncing`;
}
