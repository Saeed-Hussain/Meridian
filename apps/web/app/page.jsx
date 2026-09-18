'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The front door: make a document, or open one from a link.
 */
export default function Home() {
  const router = useRouter();
  const [id, setId] = useState('');

  /** A readable id, since it appears in the link people share. */
  const makeId = () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  };

  return (
    <main className="home">
      <h1>Meridian</h1>
      <p className="lede">
        A shared workspace that keeps working when the internet does not.
      </p>

      <p className="detail">
        Several people write in the same document at once. Everyone can keep typing
        with no connection, and when it comes back the changes merge on their own —
        every person ends up with exactly the same text.
      </p>
      <p className="detail">
        Changes travel straight between browsers. The server only introduces people
        to each other; it never sees what you write.
      </p>

      <div className="actions">
        <button type="button" onClick={() => router.push(`/doc/${makeId()}`)}>
          Start a document
        </button>
      </div>

      <form
        className="open"
        onSubmit={(event) => {
          event.preventDefault();
          if (id.trim()) router.push(`/doc/${encodeURIComponent(id.trim())}`);
        }}
      >
        <input
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="or paste a document id"
          aria-label="Document id"
        />
        <button type="submit">Open</button>
      </form>
    </main>
  );
}
