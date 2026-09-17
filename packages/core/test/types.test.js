/**
 * The other two data types, the change log, and saving to JSON.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, OpLog, compareIds, Clock, parseId } from '../src/index.js';

// ------------------------------------------------------------------------- ids

test('ids from one device are unique and rising', () => {
  const clock = new Clock('aaaa');
  const ids = Array.from({ length: 100 }, () => clock.next());
  assert.equal(new Set(ids).size, 100);
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(compareIds(ids[i], ids[i - 1]) > 0, 'each id sorts after the last');
  }
});

test('ids order the same way whichever way round they are asked', () => {
  const ids = ['1@aaaa', '2@aaaa', '1@bbbb', '10@aaaa', '2@bbbb'];
  for (const x of ids) {
    for (const y of ids) {
      const forward = compareIds(x, y);
      const back = compareIds(y, x);
      if (x === y) assert.equal(forward, 0);
      else assert.equal(Math.sign(forward), -Math.sign(back), `${x} vs ${y}`);
    }
  }
  // Counter first, so 10 beats 2 rather than losing as a string would.
  assert.ok(compareIds('10@aaaa', '2@aaaa') > 0);
});

test('a clock never reuses a counter it has seen', () => {
  const clock = new Clock('aaaa', 0);
  clock.observe('50@bbbb');
  assert.ok(parseId(clock.next()).counter > 50);
});

test('rubbish is not accepted as an id', () => {
  for (const bad of ['', 'abc', '@aaaa', '0@aaaa', '-1@aaaa', 'x@aaaa']) {
    assert.throws(() => parseId(bad), /not an id/, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------- fields

test('the higher id wins a clash on one field', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.setField('title', 'from a');
  b.setField('title', 'from b');
  a.syncTo(b);
  b.syncTo(a);
  assert.equal(a.fields.get('title'), b.fields.get('title'));
});

test('different fields do not interfere', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.setField('title', 'plan');
  b.setField('colour', 'blue');
  a.syncTo(b);
  b.syncTo(a);
  assert.deepEqual(a.fields.toObject(), b.fields.toObject());
  assert.equal(a.fields.get('title'), 'plan');
  assert.equal(a.fields.get('colour'), 'blue');
});

// ------------------------------------------------------------------------ tags

test('adding a tag beats removing it at the same time', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.addTag('urgent');
  a.syncTo(b);
  assert.ok(b.tags.has('urgent'));

  b.removeTag('urgent'); // b removes the tag it can see
  a.addTag('urgent'); // a adds it again, not knowing
  a.syncTo(b);
  b.syncTo(a);

  assert.deepEqual(a.tags.values(), b.tags.values());
  assert.ok(a.tags.has('urgent'), 'the add should survive');
});

test('a removed tag stays removed', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.addTag('draft');
  a.syncTo(b);
  b.removeTag('draft');
  b.syncTo(a);
  assert.equal(a.tags.has('draft'), false);
  assert.deepEqual(a.tags.values(), []);
});

test('removing a tag that was never added does nothing', () => {
  const doc = new Doc('aaaa');
  assert.deepEqual(doc.removeTag('nope'), []);
});

// ------------------------------------------------------------------ change log

test('the summary only counts changes held with no gaps', () => {
  const log = new OpLog();
  log.add({ type: 'insert', id: '1@aaaa' });
  log.add({ type: 'insert', id: '3@aaaa' }); // 2 is missing
  assert.deepEqual(log.version(), { aaaa: 1 }, 'must not claim to hold 3');

  log.add({ type: 'insert', id: '2@aaaa' }); // fills the gap
  assert.deepEqual(log.version(), { aaaa: 3 });
});

test('the log ignores a change it already has', () => {
  const log = new OpLog();
  assert.equal(log.add({ type: 'insert', id: '1@aaaa' }), true);
  assert.equal(log.add({ type: 'insert', id: '1@aaaa' }), false);
  assert.equal(log.size, 1);
});

test('sync sends only what the other side is missing', () => {
  const a = new Doc('aaaa');
  const b = new Doc('bbbb');
  a.insert(0, 'hello');

  assert.equal(a.syncTo(b), 5, 'all five letters');
  assert.equal(a.syncTo(b), 0, 'nothing left to send');

  a.insert(5, '!');
  assert.equal(a.syncTo(b), 1, 'just the new letter');
  assert.equal(b.toString(), 'hello!');
});

// ------------------------------------------------------------------- snapshots

test('saving and loading gives back the same document', () => {
  const doc = new Doc('aaaa');
  doc.insert(0, 'hello world');
  doc.delete(5, 6);
  doc.setField('title', 'greeting');
  doc.addTag('draft');

  const saved = JSON.parse(JSON.stringify(doc.toJSON()));
  const loaded = Doc.fromJSON(saved);

  assert.equal(loaded.toString(), 'hello');
  assert.equal(loaded.fields.get('title'), 'greeting');
  assert.deepEqual(loaded.tags.values(), ['draft']);
  assert.deepEqual(loaded.version(), doc.version());
  assert.deepEqual(loaded.toJSON(), doc.toJSON(), 'a second save matches the first');
});

test('a loaded document can still be edited and still syncs', () => {
  const a = new Doc('aaaa');
  a.insert(0, 'abc');
  const b = new Doc('bbbb');
  a.syncTo(b);

  const reloaded = Doc.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  reloaded.insert(3, 'd'); // new id must not clash with anything already used
  reloaded.syncTo(b);

  assert.equal(b.toString(), 'abcd');
  b.syncTo(reloaded);
  assert.equal(reloaded.toString(), b.toString());
});

test('a document with changes still held back survives a save', () => {
  const a = new Doc('aaaa');
  const ops = a.insert(0, 'abc');

  const b = new Doc('bbbb');
  b.receive([ops[2]]); // only the last letter, so it cannot be placed yet
  assert.equal(b.toString(), '');
  assert.equal(b.text.settled(), false);

  const loaded = Doc.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
  loaded.receive(ops); // the rest arrives after the reload
  assert.equal(loaded.toString(), 'abc');
  assert.ok(loaded.text.settled());
});
