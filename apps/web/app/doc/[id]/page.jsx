'use client';

import { use, useEffect, useState } from 'react';
import { useDocument } from '../../../lib/useDocument.js';

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
      <header>
        <div className="who">
          <span className="dot" data-online={online} />
          <input
            className="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Your name"
            maxLength={24}
          />
        </div>

        <div className="people">
          {peers.map((peer) => (
            <span key={peer.id} className="chip" style={{ '--chip': peer.colour }}>
              {peer.name ?? 'someone'}
            </span>
          ))}
          {peers.length === 0 && <span className="alone">nobody else here yet</span>}
        </div>

        <div className="state">
          <span>{connectionLabel({ online, peers, synced, status })}</span>
          <span className={saved ? 'saved' : 'saving'}>
            {saved ? 'saved' : 'saving…'}
          </span>
        </div>
      </header>

      <textarea
        ref={boxRef}
        className="paper"
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
            <button type="button" className="now" onClick={() => view(null)}>
              Back to now
            </button>
          ) : (
            <span className="hint">
              drag to see earlier versions · {steps} changes
            </span>
          )}
        </div>
      )}

      <footer>
        <p>
          {reading
            ? 'This is how the document looked. Editing is off while you are looking back.'
            : 'Share this page’s address to invite someone. The id is hashed before it reaches the server, so the introduction service never learns which document this is.'}
        </p>
      </footer>
    </main>
  );
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
  if (!online) return 'offline — still saving';
  if (peers.length === 0) return status;
  const who = `${peers.length} other ${peers.length === 1 ? 'person' : 'people'}`;
  return synced ? `${who} · synced` : `${who} · syncing…`;
}
