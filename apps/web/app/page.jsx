'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThemeToggle } from './theme.jsx';

/**
 * The landing page.
 *
 * Written for someone who has never heard of a CRDT and does not need to. It
 * says what the thing does, shows the one idea that makes it unusual, gives
 * the measurements, and gets out of the way.
 *
 * Every number on this page comes from `npm run bench`, including the ones
 * that are not flattering.
 */
export default function Home() {
  const router = useRouter();
  const [id, setId] = useState('');

  /** A short readable id, since it ends up in the link people share. */
  const start = () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const made = [...bytes]
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12);
    router.push(`/doc?id=${made}`);
  };

  return (
    <div className="page">
      <header className="top">
        <span className="mark">Meridian</span>
        <nav>
          <a href="#how" className="hide-small">
            How it works
          </a>
          <a href="#speed" className="hide-small">
            Speed
          </a>
          <a
            href="https://github.com/Saeed-Hussain/Meridian"
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
          <ThemeToggle />
        </nav>
      </header>

      <section className="hero">
        <h1>A shared workspace that keeps working when the internet does not.</h1>
        <p className="prose">
          Several people write in the same document at once. Everyone can keep typing
          with no connection, and when it comes back the changes merge on their own —
          every person ends up with exactly the same text.
        </p>
        <p className="prose">
          Changes travel straight from one browser to another. The server only
          introduces people to each other; it never sees a word you write.
        </p>

        <div className="cta">
          <button type="button" className="button big" onClick={start}>
            Start a document
          </button>
          <a
            className="button quiet big"
            href="https://github.com/Saeed-Hussain/Meridian"
            target="_blank"
            rel="noreferrer"
          >
            Read the source
          </a>
        </div>
        <p className="aside">
          No account. Nothing to install. The document exists on the machines of the
          people writing it.
        </p>

        <div className="diagram">
          <Diagram />
          <p className="caption">
            The server introduces two browsers and then has nothing left to do.
          </p>
        </div>
      </section>

      <section id="how">
        <p className="eyebrow">How it works</p>
        <h2>Every letter knows where it belongs.</h2>
        <p className="prose">
          The hard part of editing together is not sending text around. It is deciding
          what the document says when two people change the same sentence at the same
          moment, on machines that cannot reach each other.
        </p>

        <ol className="steps">
          <li>
            <div>
              <h3>Every letter gets a permanent name</h3>
              <p>
                Not a position — positions move the instant anybody types above them. A
                name does not.
              </p>
            </div>
          </li>
          <li>
            <div>
              <h3>Each letter remembers what it was typed after</h3>
              <p>
                So a word is a run rather than a crowd competing for one spot. Two
                people typing in the same place produce “helloworld” or “worldhello” —
                never “hweolrllod”.
              </p>
            </div>
          </li>
          <li>
            <div>
              <h3>The rules never look at the clock</h3>
              <p>
                Not at wall-clock time, not at arrival order, not at who connected
                first. So every device reaches the same answer on its own, and no
                server has to decide anything.
              </p>
            </div>
          </li>
        </ol>

        <p className="prose" style={{ marginTop: '2rem' }}>
          <strong>This is written from scratch, not installed.</strong> Almost everyone
          who ships collaborative editing reaches for a library. The merge algorithm
          here is the project — and it is checked by hundreds of randomised runs where
          replicas edit apart and then receive everything in different orders, which
          must all end identical.
        </p>
      </section>

      <section>
        <p className="eyebrow">What you get</p>
        <h2>Offline is the normal case, not the error case.</h2>

        <div className="grid">
          <div className="cell">
            <h3>Works with no connection</h3>
            <p>
              Keep typing on a train, on a plane, on bad hotel wifi. Nothing is blocked
              and nothing is queued behind a spinner.
            </p>
          </div>
          <div className="cell">
            <h3>Nothing is overwritten</h3>
            <p>
              Two people editing the same line both keep their work. There is no “last
              save wins”, because there is no save.
            </p>
          </div>
          <div className="cell">
            <h3>Straight between browsers</h3>
            <p>
              Text goes peer to peer over WebRTC. No server holds a copy, so there is
              no copy to leak or subpoena.
            </p>
          </div>
          <div className="cell">
            <h3>Encrypted, with the key in the link</h3>
            <p>
              The key lives after the <code>#</code>, which browsers never send to a
              server. Share the link and you have shared the document.
            </p>
          </div>
          <div className="cell">
            <h3>Every version, kept</h3>
            <p>
              Drag back through every change ever made and read the document as it was.
              Looking never disturbs the present.
            </p>
          </div>
          <div className="cell">
            <h3>A real desktop app</h3>
            <p>
              The same thing as a Windows application, storing changes in a SQLite file
              you can copy and back up.
            </p>
          </div>
        </div>
      </section>

      <section id="speed">
        <p className="eyebrow">Speed</p>
        <h2>Fast on a document of a hundred thousand characters.</h2>
        <p className="prose">
          The measurement that matters is not how long a large document takes to build —
          nobody waits for that. It is what <strong>one keystroke</strong> costs once
          the document is already large. The budget is one screen refresh, about 16 ms.
        </p>

        <table className="numbers">
          <thead>
            <tr>
              <th>At 100,000 characters</th>
              <th>Median</th>
              <th>Worst</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Type a character at the end</td>
              <td>0.003 ms</td>
              <td>0.1 ms</td>
            </tr>
            <tr>
              <td>Type a character in the middle</td>
              <td>0.81 ms</td>
              <td>2.8 ms</td>
            </tr>
            <tr className="lead">
              <td>A keystroke, all the way through</td>
              <td>5.6 ms</td>
              <td>17.8 ms</td>
            </tr>
            <tr>
              <td>Work out where the cursor is</td>
              <td>0.001 ms</td>
              <td>0.2 ms</td>
            </tr>
            <tr>
              <td>Open a saved document</td>
              <td>536 ms</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>

        <p className="prose" style={{ marginTop: '1.5rem' }}>
          “All the way through” means what the editor really does: take the new text,
          work out what changed, apply it, and draw the result. The drawing is counted
          on purpose — leaving it out would move the cost to the next keystroke rather
          than remove it.
        </p>
        <p className="prose">
          The first version rebuilt the whole document order on every change and cost
          528 µs per character. Holding the letters as a chain and remembering the last
          position looked up brought that to 3 µs — about 170 times faster.
        </p>
      </section>

      <section className="close">
        <h2>Start writing.</h2>
        <p className="prose">
          Make a document, then send someone the whole address — including the part
          after the <code>#</code>. That part is the key, and it never reaches a server.
        </p>

        <div className="cta">
          <button type="button" className="button big" onClick={start}>
            Start a document
          </button>
        </div>

        <form
          className="open-inline"
          onSubmit={(event) => {
            event.preventDefault();
            if (id.trim()) router.push(`/doc?id=${encodeURIComponent(id.trim())}`);
          }}
        >
          <input
            className="field"
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="or open one by id"
            aria-label="Document id"
          />
          <button type="submit" className="button quiet">
            Open
          </button>
        </form>
      </section>

      <footer className="foot-note">
        <span>Built by Saeed Hussain</span>
        <a href="https://github.com/Saeed-Hussain/Meridian" target="_blank" rel="noreferrer">
          Source and design notes
        </a>
        <span>Plain JavaScript · no framework in the core</span>
      </footer>
    </div>
  );
}

/**
 * Two browsers, one line between them, and a server standing aside.
 *
 * Drawn rather than photographed so it stays sharp, scales to any width, and
 * inherits the ink colour — which means it inverts with the theme instead of
 * needing a second copy.
 */
function Diagram() {
  return (
    <svg viewBox="0 0 720 220" role="img" aria-label="Two browsers connected directly, with the server to one side">
      <defs>
        <marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
      </defs>

      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        {/* the two people */}
        <rect x="24" y="96" width="176" height="104" rx="8" />
        <rect x="520" y="96" width="176" height="104" rx="8" />
        <path d="M24 122 H200 M520 122 H696" opacity="0.5" />

        {/* the introduction service, dashed: it is optional after the first hello */}
        <rect x="286" y="10" width="148" height="56" rx="8" strokeDasharray="5 4" opacity="0.55" />
        <path d="M200 120 C 260 120, 280 70, 300 66" strokeDasharray="4 5" opacity="0.4" />
        <path d="M520 120 C 460 120, 440 70, 420 66" strokeDasharray="4 5" opacity="0.4" />

        {/* the connection that carries the document */}
        <path d="M212 148 H508" markerEnd="url(#tip)" />
        <path d="M508 172 H212" markerEnd="url(#tip)" />
      </g>

      <g fill="currentColor" fontSize="13" fontFamily="ui-sans-serif, system-ui, sans-serif">
        <text x="40" y="115" opacity="0.55" fontSize="11">you</text>
        <text x="536" y="115" opacity="0.55" fontSize="11">them</text>
        <text x="40" y="152">Meeting notes</text>
        <text x="536" y="152">Meeting notes</text>
        <text x="40" y="176" opacity="0.6">Both of us are</text>
        <text x="536" y="176" opacity="0.6">Both of us are</text>
        <text x="306" y="44" fontSize="11" opacity="0.6">introductions only</text>
        <text x="300" y="140" fontSize="11" opacity="0.75">the document</text>
      </g>
    </svg>
  );
}
