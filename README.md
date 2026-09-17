# Meridian

A shared workspace that keeps working when the internet does not.

Several people write in the same document at once. Everyone can keep typing with no
connection. When the connection comes back, all the changes merge on their own, and
every person ends up with exactly the same text.

Changes travel directly between computers over WebRTC. The server only introduces
peers to each other — it never sees what you write.

## Status

**The merge algorithm works and is proven.** Weeks 1 to 5 of the plan are done.

- 33 tests pass, including hundreds of random convergence runs per seed.
- Typecheck is clean under `strict`, from JSDoc comments — no TypeScript.
- Zero dependencies in the core. Nothing to install to run the tests.

Next: saving to disk (week 6), then the network (week 7).

```bash
npm install     # only needed for the typecheck tools
npm test        # the core itself needs nothing
npm run typecheck
```

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
packages/core     the merge algorithm, plain JavaScript, no framework   BUILT
apps/web          Next.js interface and demo                            week 9
apps/desktop      Electron wrapper                                      week 11
server/signal     small WebSocket server that introduces peers          week 7
```

The core must never import Next.js, React or anything from the browser. That rule is
what keeps it testable in plain Node.

## The one thing that matters

Week 4 of the plan ends with a test that makes thousands of random edits, applies
them in every order, and checks that every copy of the document ends up identical.

**That test passes.** The hard part is solved; what follows is ordinary work.

It has also been checked for teeth. Replacing the sibling sort with arrival order —
the exact bug the tie-break rule prevents — fails 9 tests, including all 5
convergence tests. A suite that cannot fail proves nothing, so it is worth
re-running that experiment after any change to the algorithm.
