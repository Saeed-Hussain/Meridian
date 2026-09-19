/**
 * Two people typing in the same place at the same time.
 *
 * The worst case for a sequence merge algorithm, and the one a user notices
 * immediately: if it goes wrong the result is not lost work, it is two words
 * shredded into each other.
 *
 * These tests are deliberately about *quality*, not correctness. Convergence is
 * covered elsewhere and is not in question here; what is being pinned down is
 * whether the result is readable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, applyText } from '../src/index.js';

/**
 * A replica that types like a person: one character at a time, with its own
 * cursor, kept as an anchor so it survives other people's edits.
 */
class Typist {
  /** @param {string} site */
  constructor(site) {
    this.doc = new Doc(site);
    /** @type {string | null} */
    this.anchor = null;
  }

  /** Where this person's cursor is now. @returns {number} */
  get caret() {
    return this.doc.text.indexAfter(this.anchor);
  }

  /**
   * Type one character at the cursor, the way the editor does: hand the whole
   * new text to `applyText`, then re-anchor from the new caret position.
   *
   * @param {string} character
   */
  type(character) {
    const before = this.doc.toString();
    const at = this.caret;
    const after = before.slice(0, at) + character + before.slice(at);
    applyText(this.doc, after);
    this.anchor = this.doc.text.anchorAt(at + 1);
  }

  /** @returns {string} */
  toString() {
    return this.doc.toString();
  }
}

test('two people typing words at the same spot keep their words whole', () => {
  // Both start at position 0 of an empty document and type a word, syncing
  // after every single character -- the hardest version of this.
  const a = new Typist('aaaa');
  const b = new Typist('bbbb');

  const first = 'alpha';
  const second = 'bravo';
  for (let i = 0; i < first.length; i += 1) {
    a.type(first[i]);
    b.type(second[i]);
    a.doc.syncTo(b.doc);
    b.doc.syncTo(a.doc);
  }

  assert.equal(a.toString(), b.toString(), 'they agree');
  assert.match(
    a.toString(),
    /^(alphabravo|bravoalpha)$/,
    `words were shredded: ${JSON.stringify(a.toString())}`,
  );
});

test('typing after someone else has typed lands where the cursor is', () => {
  const a = new Typist('aaaa');
  const b = new Typist('bbbb');

  a.type('a');
  a.doc.syncTo(b.doc);
  b.anchor = b.doc.text.anchorAt(1); // b puts its cursor after the "a"

  b.type('b');
  b.doc.syncTo(a.doc);
  assert.equal(a.toString(), 'ab');

  a.type('c'); // a's cursor is still after its own "a"
  a.doc.syncTo(b.doc);
  assert.equal(a.toString(), b.toString());
  assert.equal(a.toString(), 'acb', 'each letter went where its typist was');
});

test('four people typing at once keep four whole words', () => {
  const words = ['alpha', 'bravo', 'delta', 'echo'];
  const people = words.map((_, i) => new Typist(`site${i}`));

  for (let step = 0; step < 5; step += 1) {
    for (const [i, person] of people.entries()) {
      if (step < words[i].length) person.type(words[i][step]);
    }
    for (const from of people) {
      for (const to of people) if (from !== to) from.doc.syncTo(to.doc);
    }
  }

  const texts = people.map((person) => person.toString());
  assert.equal(new Set(texts).size, 1, 'everyone agrees');
  for (const word of words) {
    assert.ok(
      texts[0].includes(word),
      `"${word}" was shredded: ${JSON.stringify(texts[0])}`,
    );
  }
});

test('a word typed offline arrives whole', () => {
  // The easier case, and the one already relied on: no syncing while typing,
  // so each word is an unbroken chain.
  const a = new Typist('aaaa');
  const b = new Typist('bbbb');

  for (const character of 'alpha') a.type(character);
  for (const character of 'bravo') b.type(character);
  a.doc.syncTo(b.doc);
  b.doc.syncTo(a.doc);

  assert.equal(a.toString(), b.toString());
  assert.match(a.toString(), /^(alphabravo|bravoalpha)$/);
});
