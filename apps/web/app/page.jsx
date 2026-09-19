'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThemeToggle } from './theme.jsx';

/**
 * The front door: make a document, or open one from a link.
 */
export default function Home() {
  const router = useRouter();
  const [id, setId] = useState('');

  /** A short readable id, since it ends up in the link people share. */
  const makeId = () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes]
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  };

  return (
    <main className="home">
      <div className="home-top">
        <h1 className="wordmark">Meridian</h1>
        <ThemeToggle />
      </div>

      <p className="lede">A shared workspace that keeps working when the internet does not.</p>

      <p className="detail">
        Several people write in the same document at once. Everyone can keep typing with
        no connection, and when it comes back the changes merge on their own — every
        person ends up with exactly the same text.
      </p>
      <p className="detail">
        Changes travel straight between browsers. The server only introduces people to
        each other; it never sees what you write.
      </p>

      <div className="home-actions">
        <button
          type="button"
          className="button"
          onClick={() => router.push(`/doc?id=${makeId()}`)}
        >
          New document
        </button>
      </div>

      <form
        className="open-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (id.trim()) router.push(`/doc?id=${encodeURIComponent(id.trim())}`);
        }}
      >
        <input
          className="field"
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="Open an existing document by id"
          aria-label="Document id"
        />
        <button type="submit" className="button quiet">
          Open
        </button>
      </form>

      <ul className="facts">
        <li>
          <b>Offline</b>
          <span>Everything is saved on your own device first, then shared.</span>
        </li>
        <li>
          <b>Peer to peer</b>
          <span>Text goes browser to browser. No server holds a copy.</span>
        </li>
        <li>
          <b>Merged, not lost</b>
          <span>Two people editing the same line both keep their work.</span>
        </li>
        <li>
          <b>Reversible</b>
          <span>Step back through every change that was ever made.</span>
        </li>
      </ul>
    </main>
  );
}
