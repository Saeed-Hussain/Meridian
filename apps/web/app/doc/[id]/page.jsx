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

  const { text, edit, status, peers, online, saved, boxRef, announce } = useDocument({
    id,
    name: name || 'Guest',
  });

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
          <span>
            {!online
              ? 'offline — still saving'
              : peers.length > 0
                ? `${peers.length} other ${peers.length === 1 ? 'person' : 'people'}`
                : status}
          </span>
          <span className={saved ? 'saved' : 'saving'}>
            {saved ? 'saved' : 'saving…'}
          </span>
        </div>
      </header>

      <textarea
        ref={boxRef}
        className="paper"
        value={text}
        onChange={(event) => edit(event.target.value)}
        onSelect={announce}
        onKeyUp={announce}
        onClick={announce}
        placeholder="Start typing. Close the tab, turn off your internet, come back — it is all still here."
        spellCheck={false}
      />

      <footer>
        <p>
          Share this page&apos;s address to invite someone. The id
          <code>{id}</code> is hashed before it reaches the server, so the
          introduction service never learns which document this is.
        </p>
      </footer>
    </main>
  );
}
