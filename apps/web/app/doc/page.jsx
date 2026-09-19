'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Editor from './editor.jsx';

/**
 * A document, addressed as `/doc?id=<id>#<key>`.
 *
 * One page rather than a route per document, because the desktop build is a
 * folder of files with no server to route anything. A path like `/doc/<id>`
 * would need a file per document id, which cannot be known in advance.
 *
 * The id is a query and the key is the fragment. Browsers send neither part to
 * a server for a static page, and never send the fragment to anyone.
 */
export default function DocumentPage() {
  return (
    <Suspense fallback={null}>
      <FromAddress />
    </Suspense>
  );
}

function FromAddress() {
  const id = useSearchParams().get('id');

  if (!id) {
    return (
      <main className="home">
        <p className="lede">That link is missing a document id.</p>
        <p className="detail">
          A document address looks like <code>/doc?id=…</code> followed by the key.
        </p>
      </main>
    );
  }

  return <Editor id={id} />;
}
