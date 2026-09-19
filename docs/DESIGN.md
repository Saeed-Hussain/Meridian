# Meridian — How the merging works

This is the written version of the algorithm in `packages/core`. It is the
document to read before changing anything in `text.js`.

**Written:** 17 September 2026
**Covers:** weeks 1 to 12 of the work plan

---

## 1. The one rule everything follows

> The result must depend only on **which** changes have arrived, never on **when**
> they arrived or **in what order**.

Every decision below comes from that rule. Any code that breaks it is a bug, even
if the tests happen to pass.

This is why the design never uses:

- the computer's clock — two machines disagree, so the same changes would merge
  differently on each one;
- arrival order — the network is allowed to deliver in any order it likes;
- "who connected first" — that would need a server to decide, and there is no
  server here.

---

## 2. Naming changes

Every change gets an id: `"<counter>@<site>"`, for example `"12@a3f9c1d8"`.

- **site** is a random id made once per device.
- **counter** goes up by one for every change that device makes.

Two ids are compared by counter first, then by site. The site part is only a
tie-break. It does not matter which device wins a tie — only that every device
picks the same winner.

When a device loads a saved document, it moves its counter past every id **of its
own** that it has seen. Without that, it would hand out an id it had already
used, and two different changes would share one name.

### Two counters, not one

Every change also carries a second number, called its stamp. A change therefore
has a **name** and a **position in an order**, and these need different rules:

| | Name (`counter`) | Stamp (`lamport`) |
|---|---|---|
| Must be gapless per device | Yes | No |
| Moves for other devices' changes | No | Yes |
| Used for | Syncing, deduplication | Ordering |

One counter cannot do both, and using one for both was a real bug in this
project. The story is worth keeping:

Syncing sends a summary of the form *"I hold everything from device X up to
number N"*. That only means something if each device's own numbering is
unbroken. But ordering needs the opposite: a letter typed between two others
must beat the letter on its right, which means taking account of numbers from
other devices.

Doing both with one counter put holes in each device's own sequence — its next
change might be number 9, with 1 to 8 never existing. The summary then could not
move past the hole, so **the device reported holding none of its own changes**.
Peers concluded it was permanently behind and greeted it forever, while the text
itself was perfectly in sync. It took a partition test running over several
rounds to see it at all.

Code: `src/id.js`.

---

## 3. Text as a tree, not a string

The document is stored as a tree of single letters. Each letter holds:

| Field | Meaning |
|---|---|
| `id` | Its permanent name |
| `parent` | The id of the letter it was typed after, or `null` for the start |
| `value` | One character |
| `deleted` | Whether it is hidden |

The text you read is the tree walked depth-first: a letter, then everything typed
after that letter, then the next sibling.

### The tie-break

Several letters can share a parent. That is what a conflict is. They are sorted
**by stamp, newest first**, with the device id breaking an exact tie.

The stamp, not the name. A letter typed between two others was written by
someone who had *seen* the letter on its right, so its stamp beats it and it
lands in the right place. Sorting by name instead let a device with a low
counter push its letter to the wrong side of a letter it was deliberately typed
in front of.

Because the tree is built only from `id` and `parent` — both of which never change
— and the sort is fixed, every device builds the same tree from the same set of
changes. The same tree read the same way gives the same text. No server decides
anything.

### Why typed words stay whole

When you type `hello`, each letter's parent is the letter before it. The word is a
**chain**, not five siblings.

If someone else types `world` in the same spot, their chain hangs off the same
parent as your `h`. The sort puts one whole chain before the other:

```
helloworld     or     worldhello
```

never `hweolrllod`. This is the main reason the tree is shaped this way.

Code: `src/text.js`.

---

## 4. Deleting

A deleted letter is marked hidden and kept. It is called a tombstone.

It cannot actually be removed, because another device may still send a change that
refers to it. If it were gone, that change would have nowhere to attach.

Two things follow:

- **Position mapping matters.** Hidden letters must not be counted when working out
  where a new letter goes. Getting this wrong looks correct until something is
  deleted. There is a test for exactly this.
- **Tombstones pile up.** Removing them safely needs proof that every device has
  moved past them. That is snapshot work, and it is not built yet.

---

## 5. Changes that arrive early

A change may arrive before the change it depends on. Two cases:

| Case | What happens |
|---|---|
| An insert whose parent is unknown | Held in `waiting`, keyed by the parent it needs. Applied the moment that parent arrives. |
| A delete for an unknown letter | Its target is remembered in `waitingDeletes`. When the letter arrives, it is born hidden. |

Both are required, not defensive extras: the convergence test delivers changes in
random order, so this path runs constantly.

`text.settled()` reports whether anything is still held back. A replica that has
received every change and is not settled means something referred to a letter that
was never sent — a real bug, and the tests assert on it.

---

## 6. Applying a change twice

Every apply path is written so that applying the same change again does nothing:

- insert — ignored if the id is already known;
- delete — already hidden, so nothing changes;
- field — the same id cannot beat itself;
- tag — adding an id to a set twice is one entry.

This matters because a peer is allowed to resend anything at any time, and after a
reconnect it usually will.

---

## 7. The other two data types

**Fields** (`src/map.js`) — one value per name, such as the title. Highest id wins.
Losing one of two titles is correct; there is no sensible way to merge them. What
matters is that everyone loses the same one.

**Tags** (`src/set.js`) — a set where adding beats removing. Each add carries its
own tag. A remove can only remove tags it could actually see, so a tag added at the
same moment as a remove survives.

Add-wins is the safer default for shared documents: losing a tag someone just added
is confusing, while seeing one you thought you removed is merely annoying.

---

## 8. Syncing

Sending the whole document on every meeting would work and would be unusable on a
slow connection. Instead each device keeps a small summary, called a version
vector: for each device, the highest counter it holds **with no gaps**.

```
{ "a3f9c1d8": 42, "7b2e0c11": 17 }
```

Two peers swap summaries and each replies with only what the other lacks.

The "no gaps" part is important. If a device holds change 1 and change 3 but not 2,
its summary says 1. Claiming 3 would make a peer skip change 2 forever.

A change already held may occasionally be re-sent when it sits past a gap in the
other side's history. That is a little extra traffic in exchange for a summary that
stays tiny, and applying a change twice does nothing.

Code: `src/oplog.js`.

---

## 9. Saving to disk

The rule: **a change is written to this device before it is sent anywhere.** A
device that loses local work is worse than one that cannot sync, because the user
can see it happen.

### What a store has to do

| Method | Job |
|---|---|
| `site()` | This device's id, made once and kept forever |
| `append(ops)` | Add changes. Must ignore ones it already has |
| `read()` | Everything needed to rebuild the document |
| `replace(snapshot)` | Save the state and delete the changes, **as one step** |

Three adapters exist, and all three pass the same test kit
(`@meridian/core/testing`). One shared kit rather than one suite per adapter, so
"correct" means one thing instead of three slightly different things.

| Adapter | Where | Built on |
|---|---|---|
| `MemoryStore` | Tests, and the reference to copy | Nothing |
| `SqlStore` | Desktop and Node | `node:sqlite`, or `better-sqlite3` |
| `IdbStore` | Browser | IndexedDB |

`SqlStore` takes a database object and only calls `exec` and `prepare`. Both
drivers provide exactly that, so the same file works with either. This matters
because Electron ships its own build of Node, and whichever driver is available
there, the adapter does not change.

### Writes are queued

Changes arrive from a plain function call that cannot wait. Writing to disk can.
So `Persistence` keeps a queue and writes one batch at a time, in order.

Without the queue, two edits in the same millisecond race, and on some stores the
second is lost. There is a test with a deliberately slow store that fails if the
queue is removed.

`flush()` waits for the queue and **raises the first write error**. A failing disk
must not be swallowed: the app has to be able to tell the user their work is not
being saved.

### Why `replace` must be one transaction

Saving state and deleting changes are one step on purpose:

- crash *after* writing state but *before* deleting changes — harmless, the
  changes are simply replayed;
- crash *after* deleting changes but *before* writing state — **the document is
  gone**.

---

## 10. Compacting, and the trap inside it

Tombstones and old changes pile up forever, so eventually the stored changes are
replaced by a snapshot of the state.

This introduces a real danger. Once the changes are gone, this device can no
longer hand them out one by one. A peer that is behind the trim point would ask
for them, receive nothing, and **quietly stay wrong forever**. Sync would report
success the whole time.

So the change log records what it has thrown away:

- `trimmed` — the version vector whose result we hold but whose changes we cannot
  produce;
- `tooFarBehind(theirs)` — true when a peer needs something inside that range;
- when it is true, `syncTo` sends **whole state** instead of changes.

### Merging whole state

The tempting shortcut is to overwrite the local document with the incoming state.
That would destroy any local work the sender had not seen. So it is a merge, not
a load:

| Part | How two states merge |
|---|---|
| Text | Union of letters by id. A deletion on either side wins |
| Fields | Per name, the higher id wins |
| Tags | Union of added tags, union of removed tags |

Every part only ever grows, and deleting never reverses, so merging states is
safe to repeat and order does not matter — the same property the individual
changes have. A snapshot that predates a deletion cannot bring the letter back,
and there is a test for exactly that.

This is also how a brand new device can join a long-lived document without
replaying its entire history.

---

## 11. The network

Nothing in `packages/sync` mentions WebRTC or WebSocket. A connection is just
something that carries strings:

```js
{ send, onMessage, isOpen, onClose?, close? }
```

That is what makes the protocol testable over a fake network that drops,
duplicates and reorders messages, which is where its real bugs were found. The
one file that does know about WebRTC — `src/webrtc.js` — only opens a pipe and
hands it over.

### Four messages

| Message | Meaning |
|---|---|
| `hello` | Here is everything I have |
| `ops` | Here are changes you are missing |
| `want` | I am too far behind for changes, send the whole document |
| `state` | Here is the whole document |

**Every hello is answered with a hello**, marked as an answer so the exchange
stops after one round trip. That reply is not a nicety; without it the protocol
does not work. A peer cannot know what to send until it knows what the other
side has, and a peer holding nothing of its own believes it is up to date and so
never speaks first. Both sides then sit silently, each waiting for the other,
while the documents differ.

### There is no message queue

A dropped message, a connection that died mid-sentence, and a laptop shut for a
week all have the same cure: say hello again. From one hello each side works out
exactly what the other lacks, so anything lost is re-derived rather than
retransmitted. Sends are allowed to fail silently for that reason.

### Repair is a tick, not an event

A handshake cannot survive being lost. On a link dropping a third of its
messages the hello itself goes missing, and then neither side says anything
more.

So `Network.tick()` greets any peer that has not confirmed it holds everything we
hold. The app calls it on a timer, every few seconds. Two details make it work:

- **A hello doubles as the acknowledgement.** Nothing says "received"; the only
  evidence a peer got our changes is its next hello reporting a version that
  covers them.
- **A tick sends changes too, not just a greeting.** Greeting alone would wait
  for a reply before sending anything, which is the silent stand-off described
  above.

Measured: at 30% packet loss, two peers reconcile in **under a dozen tick
rounds**, and the test fails rather than looping if repair is ever unbounded.

### Relaying, and why it terminates

Changes from one peer are passed to the others, so a group where everyone
connects to one person still syncs fully.

This sounds like it should never stop — A tells B, B tells A — and it stops for a
precise reason: `Doc.receive` reports only the changes that were **new**, and
only those are relayed. The second time a change comes round there is nothing to
pass on, so it dies there. The change ids do the work a hop counter would
otherwise have to.

### Messages from peers are checked

Anything arriving from the network was written by someone else, who may be
running an older build, a newer build, or trying to break things. Malformed
messages are dropped, not thrown, because a bad message is an expected event on
a public network. A batch of changes containing one malformed change is refused
whole — accepting the good half would apply a change with no usable id, which
could then be applied over and over.

### Introductions

Two browsers cannot call each other directly, so `server/signal` relays the
connection details they need to find each other. It sees nothing else, stores
nothing, and is trusted by neither peer. Once connected, changes travel directly
and the server could be switched off without either side noticing.

Rooms are named by a **hash** of the document id, so the server can tell that two
people want the same room without learning which document it is.

The newcomer makes the WebRTC offer, because the server tells an arriving peer
who is already present. If both offered at once the handshake would collapse —
WebRTC calls that a signalling collision.

---

## 12. The editor

Two problems stand between a correct merge algorithm and an editor anyone would
use. Neither is solved by the algorithm, and both are pure logic, so both are
tested in Node rather than discovered by hand in a browser.

### Turning a text box into changes

A text box hands over its whole contents after every keystroke. The document
needs the opposite: the smallest description of what altered.

`diff()` matches the identical text at the start, then at the end, and whatever
is left in the middle is the change.

Replacing the whole document instead would still *look* right on one machine.
It would also delete and re-insert every letter, so two people typing in the
same paragraph would obliterate each other, every cursor would jump, and the
change log would grow without bound. There is a test asserting that adding two
letters produces exactly two changes.

One trap, with a test of its own: `"aa"` becoming `"aaa"` matches two characters
at the start *and* two at the end of a three-character string. Without a guard
the two ranges overlap and the removed count goes negative.

### Keeping the cursor still

A cursor cannot be stored as a number. Someone typing earlier in the document
shifts every number after it, and the cursor appears to jump — the single most
irritating bug in collaborative editors.

So a cursor is stored as **the id of the letter it sits after**. That letter is
the same letter no matter what anyone types elsewhere. `anchorAt(index)` and
`indexAfter(anchor)` convert between the two.

Two details that are easy to get wrong:

- A **deleted** letter still works as an anchor. If someone else removes the
  letter your cursor sat after, the cursor belongs where that letter was, not at
  the start of the document.
- An **unknown** anchor resolves to the end. It means a cursor referring to
  letters that have not arrived yet; the end is wrong but harmless, while the
  start would look like the document had scrolled itself.

### Presence is not part of the document

Who is here and where their cursor is travels as a fifth message type, `who`,
and never touches the document. It is not saved, not merged and not replayed.
Storing it in the document would mean a cursor position from last Tuesday
syncing forever.

It is capped at 4 KB, because a channel nothing else checks is otherwise a way
to push bulk data at everyone in the room.

### Two tabs are two devices

The bug that only a browser could have found.

Two tabs of one browser share one IndexedDB. Both opened it, both adopted the
stored device id, and so **they became the same device**. Their change ids
collided, each discarded the other's edits as duplicates it already had, and the
two tabs disagreed permanently while every status indicator said they were in
sync.

Two tabs are two replicas and need two identities. The tab's id now lives in
`sessionStorage`, which is per tab and survives a reload — exactly the lifetime
wanted. They still share a store, which is fine: changes are globally unique and
merge.

This also changed how a document is loaded. It is now built by **merging** the
saved state rather than loading it, because loading adopts whichever device
wrote the snapshot — right for one device, wrong for the second tab, whose own
identity has to survive.

---

## 13. History

Every change carries a stamp, so there is a single order everyone agrees on:
sorted by stamp, then by device to break a tie. A change always sorts after
everything its writer had already seen, which gives the property the slider
needs — **the first N changes can be applied on their own**. A letter never
arrives before the letter it was typed after, so every point in history is a
document that makes sense rather than a half-built one.

`doc.at(n)` builds that past version as a **separate document**. It is replayed,
never undone. Undoing needs an inverse for every kind of change, and one wrong
inverse corrupts the live document; replaying cannot touch it at all. There is a
test that walks every step of a history and checks the real document is
unchanged afterwards.

The cost is O(changes) each time the slider moves, which is fine for a document
and would need an index for a long one.

### Where history stops

After compacting there is nothing left to replay, because those changes no
longer exist anywhere. The earliest view is the trim point.

That needed fixing rather than explaining: at first the slider showed an *empty*
document there, which is not what the document was, only what is left when there
are no changes. The state saved at the trim point is now kept as the floor of
history, and restored on reload because it is the same state the store already
holds.

---

## 14. The text box is not the document

The editor keeps the document as the source of truth and writes to the text box
directly, rather than driving the box from React state. Every version of the
bug below came from the same root: **the box and the document disagree for a
moment after every edit, and anything read in that window is wrong.**

It took four attempts to corner, so the sequence is worth recording:

| What was wrong | Symptom |
|---|---|
| The cursor was read before the change was applied — a new position looked up in old text | Cursor drifted onto another person's letter |
| The caret was restored *after* paint, leaving a gap a keystroke could land in | Interleaving that came and went with typing speed |
| `keyup` re-read the caret right after an edit had already set it | The correct cursor was overwritten by a stale one |
| The caret was only restored when the box had focus | With several windows open, the DOM caret and the stored cursor drifted apart |

What finally made it mostly right: the cursor is now worked out from **the change
itself** — where the edit was, and how long it was — which is true regardless of
what the box is doing. React's render is out of the typing path entirely.

### What is still wrong

Four windows typing into the same spot of an empty document at the same instant
still interleave, and often: across recent runs, all four words survived whole
in perhaps a third of them. The rest kept two of the four intact.

Worth being precise about what that is and is not:

- The merge algorithm is **not** at fault. `interleave.test.js` runs the same
  scenario in Node — four typists, syncing after every single character — and
  every word comes out whole, every time.
- Nothing is ever lost, and every window always agrees. The browser test
  requires both of those and fails if either breaks.
- What is left is a race between the text box and the document that sometimes
  attaches a letter to the wrong neighbour. It shreds words; it does not damage
  the document.

The browser test prints `words kept whole: n/4` rather than failing on it, so
the number stays visible and a change for better or worse is obvious. Making it
a hard failure would only invite the test to be weakened later.

---

## 15. Encryption

Everything crossing a connection is encrypted with AES-GCM, and the key lives in
the **fragment** of the link — the part after `#`. Browsers never send a fragment
to a server, so the key reaches the other person through the link and never
reaches the introduction service.

That is what turns "the server cannot read your document" from a claim into a
fact, and there is a test that treats it as one: it captures everything the two
peers send, then searches it for the typed text, the field values and even the
protocol's own message names. It fails if anything readable appears.

Two things worth saying plainly rather than burying:

- **The link is the key.** Anyone who has it can read the document, and losing
  it loses the document, because nothing anywhere else can decrypt it.
- **This encrypts; it does not authenticate.** A peer holding the key is treated
  as entitled to the document, which is exactly as strong as link-sharing
  implies. Identity needs a separate handshake, and pretending otherwise would
  be worse than saying so.

Encryption sits at the **transport**: `encrypted(channel, key)` wraps a
connection, and the protocol above is unchanged and unaware. A message is locked
once, on its way out, and the code deciding *what* to send never thinks about
it. Every message gets a fresh random nonce, because reusing one with the same
key in GCM is catastrophic rather than untidy. GCM also authenticates, so a
message altered in flight fails to decrypt instead of decrypting to something
else.

---

## 16. The desktop application

The same interface, exported to a folder of files, wrapped in Electron, with a
real database underneath.

### The page is not trusted

It talks to strangers over WebRTC, so in Electron it is treated the way a
browser would treat it: no Node, context isolation on, sandbox on, and a
content-security policy that refuses to load anything from outside the bundle.

Which means the page cannot touch a disk. So SQLite lives in the application
process, and the page reaches it through a preload exposing **four functions** —
the store contract the project already defines. Deliberately not one general
"run this" channel taking a method name and arguments: that would be an open
door from a page that talks to strangers into the process that can write files.

`BridgeStore` is the other half, and it is run against the **same conformance
kit** as the memory, SQLite and IndexedDB stores, wired to a real database with
everything serialised exactly as it is between processes. So "the desktop app
saves correctly" reduces to "SQLite saves correctly", which was already proven,
rather than resting on the adapter looking simple.

At runtime the app picks: SQLite through the bridge on the desktop, IndexedDB in
a browser. Both satisfy the same contract, so nothing above that line differs.

### Three things that had to be got right

| Problem | What happens if you do the obvious thing |
|---|---|
| Loading the page | `loadFile` on the exported HTML gives a blank window. The export asks for `/_next/...`, and from a `file://` page a leading slash means the root of the drive. It is served from a private `app://` scheme instead — which also gives the page a stable origin, since a `file://` page has an opaque one and its storage can vanish between runs. |
| Addressing a document | A path like `/doc/<id>` needs one exported file per document id, which cannot be known in advance. The editor is one page at `/doc?id=…`, with the key still in the fragment. |
| Starting it | `ELECTRON_RUN_AS_NODE` makes the Electron binary behave as plain Node, and editors built on Electron — VS Code among them — set it in every terminal they open. So `electron .` silently starts a Node process and the first thing the code touches is undefined. The launcher removes the variable. |

Two smaller ones, both found by running it: Electron only takes its product name
from the build configuration once packaged, so unpackaged it writes its data to
a directory called `Electron`, shared with every other Electron app in
development. And the `app://` scheme has to be registered as privileged before
the app is ready, or the page counts as untrusted and Web Crypto — which the
encryption depends on — is not available to it.

### Checking it

`npm run desktop:check` starts the application with the window hidden, types
into the document through the real interface, reopens it, and checks the text
came back from the SQLite file. A running process proves nothing on its own.

### Testing the source is not testing the product

That check runs against the source, and the source is not what people install.
The difference produced the worst bug of the project, precisely because nothing
went red.

The SQLite adapter was a workspace dependency — a symlink to a folder outside
the application. The packaged app is a sealed archive of whatever the build
lists, and a symlink to somewhere else is not in it. So the installer contained
an app that started perfectly and failed the instant anybody opened a document,
while all 155 tests, both browser suites and the desktop check stayed green.
Every one of them ran against the source, where the symlink resolves.

Two things came out of it. The adapter is now **copied in** at build time, the
same way the interface is, rather than imported by package name — it has no
dependencies of its own, so a copy is all of it. And `npm run packaged-check`
drives the **built binary** through a debugging port: open a document, type,
reload, read it back. It is the only check that looks at the thing people would
actually install.

---

## 17. Speed

### The measurement that matters

Not how long it takes to build a large document — nobody waits for that — but
**what one keystroke costs on a document that is already large**. A person
typing wants the next character before they notice it is missing, and the
budget for that is one screen refresh, about 16ms.

At 100,000 characters, on an ordinary laptop:

| | median | worst |
|---|---|---|
| Type a character at the end | 0.003 ms | 0.1 ms |
| Type a character in the middle | 0.81 ms | 2.8 ms |
| Delete a character in the middle | 0.95 ms | 3.0 ms |
| **A keystroke, all the way through** | **5.6 ms** | 17.8 ms |
| Work out where the cursor is | 0.001 ms | 0.2 ms |
| Read the whole document as text | 22.6 ms | — |
| Save it | 197 ms | — |
| Load it back | 536 ms | — |

"All the way through" means what the editor really does: take the new text,
work out what changed, apply it, and render the result back. The render is
included on purpose — leaving it out would move the cost to the next keystroke
rather than remove it.

Run it with `npm run bench`, or `SIZE=200000 npm run bench`.

### What made it fast

The first version rebuilt the whole reading order from a tree on every change.
At 5,000 characters a keystroke already cost 1.3ms and building cost 528µs per
character — both growing with the document, so 100,000 characters would have
meant about 26ms per keystroke and minutes to type.

Two changes, in order of how much they were worth:

**The letters are a chain, not a tree.** Each letter links to the one before
and after it, so placing a new one is a couple of pointer writes instead of
rebuilding an order. The ordering rule became simpler at the same time: start
just after the letter you were typed after, walk forward past everything whose
stamp beats yours, stop.

That short rule is exactly equivalent to the old depth-first walk, and it works
because of one invariant — *a letter's stamp is always higher than that of the
letter it was typed after*, since whoever typed it had seen that letter. So
everything typed after a rival also outranks the newcomer, and walking past the
rival skips its whole run at once. It cannot overshoot either: the first letter
past that run belongs to an earlier place in the document, so its stamp is
lower and the walk stops.

**The last position looked up is remembered.** Finding the letter at a position
means counting along the chain. People type in one place and then a little
further along, so remembering where we were turns nearly every lookup into a
step or two. Typing at the end went from 1.3ms to 0.003ms.

Result: building a document went from 528µs to 3µs per character, a factor of
about 170.

### What is still slow, and why

The 5.6ms keystroke is almost entirely **rendering the document to a string**.
That is O(n) and there is no way around it with an ordinary text box, which
wants the whole text as one value. Improving it needs a rope — the text held in
chunks so an edit rewrites one chunk rather than the lot — and that is a real
piece of work, not a tweak.

It is under one frame at 100,000 characters, and occasionally over at the worst
case. Loading a long document takes half a second, which is once per open.

### Size

| | |
|---|---|
| Saved, with full history | 11.8 MB — 124 bytes per character |
| Saved after compacting | 4.0 MB — 66% smaller |
| Memory in use | 90 MB |

124 bytes per character is the price of every change being separately named and
orderable. Compacting throws away the history and keeps the state, which is
where most of it goes.

---

## 18. How this is tested

| Test | What it proves |
|---|---|
| `text.test.js` | The specific cases that are easy to get wrong, including editing after a deletion and receiving changes backwards |
| `types.test.js` | Fields, tags, the version vector, and save/load |
| `convergence.test.js` | The real proof: hundreds of random runs where replicas edit apart and then receive everything in different random orders |
| `storage.test.js` | Reload, crash, write ordering, write failure, compacting, and state merge |
| `storage-sql`, `storage-idb` | The same shared kit, run against SQLite on disk and against IndexedDB |
| `sync/session.test.js` | Handshakes, relaying, reconnecting, and refusing malformed messages |
| `sync/unreliable.test.js` | Loss, duplication, reordering and partitions, all seeded and replayable |
| `signal/signal.test.js` | The introduction service, over real sockets |
| `core/editing.test.js` | Diffing and cursor anchoring, including 2000 random diff pairs |
| `sync/presence.test.js` | Presence arriving, expiring, and never reaching the document |
| `core/history.test.js` | Stepping back, the floor after compacting, and not disturbing the present |
| `core/interleave.test.js` | Several people typing in one spot — a quality test, not a correctness one |
| `tools/two-tabs.js` | The whole thing, in two real browsers |
| `tools/four-windows.js` | Four windows, two of them cut off and reconnected |
| `sync/crypto.test.js` | Keys, tampering, and that nothing readable crosses the wire |
| `storage-bridge` | The desktop store, against the shared conformance kit |
| `desktop:check` | The packaged interface, typing and reloading, in Electron |

Every run prints its seed. Replay a failure with:

```bash
SEED=12345 npm test
```

### The test suite has teeth

A test that cannot fail is worthless, so each of these was deliberately broken
again to check the suite noticed:

| Bug reintroduced | Result |
|---|---|
| Sibling sort by arrival order | 9 tests fail, including all 5 convergence tests |
| One-way handshake (no hello reply) | 3 sync tests fail |
| Counters absorbing other devices' numbers | 1 test fails |
| Two tabs sharing one device id | 1 test fails, and the browser test disagrees on text |
| Letters not walking past their rivals when placed | 21 tests fail |

The last one is the interesting result. Only its own regression test caught it,
and the network tests did not — because the flaw is symmetric: both sides
under-report their versions identically, so the mistakes cancel out and sync
looks healthy. A bug that hides from end-to-end tests is exactly the kind worth
a unit test of its own.

Worth repeating after any change to `text.js`, `id.js` or `session.js`.

---

## 19. What is known to be missing

Written down honestly, because a limitation you know about is a plan and one you
have hidden is a trap.

| Limitation | Effect | When |
|---|---|---|
| **Interleaving** | Two people editing *inside* the same concurrent run can still mix. Convergence is unaffected — everyone sees the same mixed result. Fixing it means a stronger ordering rule, such as Fugue or YATA. | Later |
| **Tombstones are never dropped** | Memory grows with every deletion ever made. Compacting trims the change log but keeps hidden letters, because a peer may still refer to them | Needs a way to prove every device has moved past them |
| **Compacting is manual** | Nothing decides when to compact yet. It needs a trigger, such as a change count or an age | Week 10 |
| **Reading order is rebuilt after each change** | Cached, so a burst costs one walk — but it is still O(document) per edit and will need a proper index | Performance week |
| **No encryption yet** | Changes travel as plain data | Week 11 |
| **The WebRTC transport has no unit tests** | `src/webrtc.js` cannot run in Node. It is now covered end to end by `tools/two-tabs.js`, which drives two real browsers, but not by the ordinary suite | Stands |
| **Remote cursors are not drawn** | Their positions arrive and are held; a plain `<textarea>` cannot paint another person's caret. Needs a rendered editor rather than a text box | Later |
| **Plain text only** | No formatting, and the field and tag types are not yet used by the interface | Later |
| **Words interleave under a browser race** | Often, when several windows type into the same spot at the same instant. The algorithm is not the cause — see section 14 | Open |
| **Stepping through history is O(changes)** | Each move of the slider replays from the start. Fine for a document, not for a long one | Later |
| **Rendering is O(document)** | The 5.6ms keystroke at 100,000 characters is almost all of it. Needs a rope to improve | Later |
| **Loading a long document takes half a second** | Every change is replayed on open. Compacting helps; an index would help more | Later |
| **The installer is not signed** | Windows will warn about an unknown publisher. Signing needs a certificate | Open |
| **Only Windows is built** | The configuration targets NSIS. macOS and Linux need their own targets and testing | Later |
| **No relay fallback** | A minority of strict networks — symmetric NAT, some corporate firewalls — cannot connect directly at all. The honest answer is a TURN relay, which is not built | Later |
| **Encryption does not authenticate** | Anyone with the link can read and write. There is no notion of who a peer is | Later |
| **No installer is produced yet** | `electron-builder` is configured but a signed installer has not been built or tested | Week 12 |

| **IndexedDB is tested against a stand-in** | `fake-indexeddb` exercises the real transaction flow, but not a real browser | Week 9, with the web app |

The first one is the interesting one, and it is a deliberate trade. Convergence was
the goal for week 4, and convergence is proven. Better ordering is an improvement
on top of something correct, not a missing foundation.
