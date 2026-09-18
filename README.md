# Meridian

A shared workspace that keeps working when the internet does not.

Several people write in the same document at once. Everyone can keep typing with no
connection. When the connection comes back, all the changes merge on their own, and
every person ends up with exactly the same text.

Changes travel directly between computers over WebRTC. The server only introduces
peers to each other — it never sees what you write.

![Two people editing the same document](docs/two-tabs.png)

## Status

**It works.** Weeks 1 to 9 done: two browsers edit the same document, straight
through each other, and survive being disconnected.

- 126 tests pass, including hundreds of random convergence runs per seed.
- Nine more checks run in two real browsers, covering the whole stack.
- Typecheck is clean under `strict`, from JSDoc comments — no TypeScript.
- Zero dependencies in the core. Nothing to install to run its tests.
- The sync protocol reconciles through 30% packet loss, reordering,
  duplication and network partitions — all seeded, so failures replay exactly.

Next: offline history and a time slider (week 10), then the desktop app.

## Try it

It needs **two terminals**, because both commands keep running. Running them one
after the other in a single terminal will not work: the first never finishes.

Terminal 1 — the introduction service:

```bash
npm install
npm run signal
```

Leave that running. Terminal 2 — the app:

```bash
npm run web
```

Then open <http://localhost:3000>, start a document, and paste its address into a
second browser window. Type in one and watch the other. Turn your internet off
and keep typing — it all merges when you come back.

Stop either one with **Ctrl + C**. If the signalling server says port 8080 is
already in use, an earlier run is still going: `npx kill-port 8080`.

## Checking it

```bash
npm test            # 126 tests, about three seconds
npm run typecheck
npm run two-tabs    # the whole thing, in two real browsers
```

`two-tabs` needs the app and the signalling server already running, in their two
terminals, as above.

## Documents

- [docs/PROPOSAL.pdf](docs/PROPOSAL.pdf) — what this is, why it is hard, and how it
  will be judged as finished.
- [docs/WORKPLAN.pdf](docs/WORKPLAN.pdf) — 12 weeks, day by day, with a "Done when"
  line for every day.
- [docs/DESIGN.pdf](docs/DESIGN.pdf) — how the merging actually works. Read this
  before changing `packages/core/src/text.js`.

The `.md` files next to them are the sources. Edit those, not the PDFs.

## Rebuilding the PDFs

```bash
bash tools/build-docs.sh            # build every document
bash tools/build-docs.sh PROPOSAL   # build just one
```

Needs Python and Chrome, both already installed on this machine. Close the PDF in
your viewer first — Windows will not let the script overwrite an open file.

## Layout

```
packages/core          the merge algorithm, plain JavaScript, no deps   BUILT
packages/storage-sql   saves to SQLite, for desktop and Node           BUILT
packages/storage-idb   saves to IndexedDB, for the browser             BUILT
packages/sync          the sync protocol, plus the WebRTC transport    BUILT
server/signal          introduces peers to each other                  BUILT
apps/web               the editor, in Next.js                          BUILT
apps/desktop           Electron wrapper                                week 11
```

The core must never import Next.js, React or anything from the browser. That rule is
what keeps it testable in plain Node.

## What the browser test checks

`npm run two-tabs` drives two real browsers, in separate profiles so they are
genuinely two devices:

1. the two find each other through the signalling server
2. typing in one appears in the other
3. both type at once, and both edits survive
4. one goes offline, both keep editing, and they agree again on reconnect
5. the text is still there after a reload

It is the only test that exercises WebRTC, because `RTCPeerConnection` does not
exist in Node.

## The one thing that matters

Week 4 of the plan ends with a test that makes thousands of random edits, applies
them in every order, and checks that every copy of the document ends up identical.

**That test passes.** The hard part is solved; what follows is ordinary work.

It has also been checked for teeth. Replacing the sibling sort with arrival order —
the exact bug the tie-break rule prevents — fails 9 tests, including all 5
convergence tests. A suite that cannot fail proves nothing, so it is worth
re-running that experiment after any change to the algorithm.
