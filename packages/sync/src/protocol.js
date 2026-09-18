/**
 * The messages two peers send each other, and the checks on the way in.
 *
 * Four message types, and that is the whole protocol:
 *
 *   hello  — "here is everything I have"
 *   ops    — "here are changes you are missing"
 *   want   — "I am too far behind for changes, send me the whole document"
 *   state  — "here is the whole document"
 *   who    — "this is my name, colour and cursor"
 *
 * A hello is always answered with a hello, marked as an answer so the exchange
 * stops after one round trip. That reply is what makes the protocol work at
 * all: a peer cannot know what to send until it knows what the other side has,
 * and a peer holding nothing of its own has no reason to speak first.
 *
 * Everything travels as JSON text, because both transports that matter — a
 * WebRTC data channel and a WebSocket — carry strings. Choosing a binary format
 * would be faster and would mean writing an encoder before anything worked at
 * all; that is a later optimisation with a benchmark attached, not a starting
 * point.
 *
 * ## Why messages coming in are checked
 *
 * Anything arriving from the network is written by someone else. A peer may be
 * running an older build, a newer build, or may be hostile. A malformed message
 * must be dropped, not crash the tab — otherwise one bad peer can take the
 * document down for everyone connected to it.
 */

/** @typedef {import('@meridian/core/src/oplog.js').Op} Op */
/** @typedef {import('@meridian/core/src/oplog.js').Version} Version */

/**
 * @typedef {{t: 'hello', v: Version, r?: boolean}} Hello
 * @typedef {{t: 'ops', ops: Op[]}} Ops
 * @typedef {{t: 'want'}} Want
 * @typedef {{t: 'state', state: any}} State
 * @typedef {{t: 'who', who: any}} Who
 * @typedef {Hello | Ops | Want | State | Who} Message
 */

/**
 * Largest presence message accepted, in characters.
 *
 * Presence is small by nature -- a name, a colour, a cursor position. A tight
 * limit keeps a peer from using it as a side channel to push bulk data at
 * everyone in the room.
 */
export const MAX_PRESENCE = 4 * 1024;

/**
 * Largest message accepted, in characters.
 *
 * A peer that sends something enormous would otherwise be able to exhaust this
 * tab's memory before the JSON parser even returns. Whole-document state is the
 * biggest legitimate message, so the limit has to be generous; it is a guard
 * against the absurd, not a tuning knob.
 */
export const MAX_MESSAGE = 32 * 1024 * 1024;

/**
 * @param {Message} message
 * @returns {string}
 */
export function encode(message) {
  return JSON.stringify(message);
}

/**
 * Turn received text into a message, or explain why it is not one.
 *
 * Returns a result rather than throwing: a bad message from a peer is an
 * expected event on a public network, not an exceptional one, and the caller
 * wants to log and carry on.
 *
 * @param {unknown} data
 * @returns {{ok: true, message: Message} | {ok: false, why: string}}
 */
export function decode(data) {
  if (typeof data !== 'string') return { ok: false, why: 'not text' };
  if (data.length > MAX_MESSAGE) return { ok: false, why: 'too big' };

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, why: 'not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, why: 'not an object' };
  }

  switch (parsed.t) {
    case 'hello':
      if (!isVersion(parsed.v)) return { ok: false, why: 'bad version vector' };
      // `r` marks a hello that is itself an answer, so that two peers greeting
      // each other do not answer each other forever.
      return {
        ok: true,
        message: { t: 'hello', v: parsed.v, r: parsed.r === true },
      };

    case 'ops': {
      if (!Array.isArray(parsed.ops)) return { ok: false, why: 'ops is not a list' };
      // Every change must have a usable id, because the id is what makes
      // applying it twice harmless. One without an id could be applied over and
      // over, so the whole batch is refused rather than partly trusted.
      for (const op of parsed.ops) {
        if (!isOp(op)) return { ok: false, why: 'a change is malformed' };
      }
      return { ok: true, message: { t: 'ops', ops: parsed.ops } };
    }

    case 'want':
      return { ok: true, message: { t: 'want' } };

    case 'state':
      if (parsed.state === null || typeof parsed.state !== 'object') {
        return { ok: false, why: 'state is not an object' };
      }
      return { ok: true, message: { t: 'state', state: parsed.state } };

    case 'who':
      if (parsed.who === null || typeof parsed.who !== 'object') {
        return { ok: false, why: 'who is not an object' };
      }
      if (JSON.stringify(parsed.who).length > MAX_PRESENCE) {
        return { ok: false, why: 'presence too big' };
      }
      return { ok: true, message: { t: 'who', who: parsed.who } };

    default:
      // Not an error. A newer peer may send a type this build predates, and
      // ignoring it is how both stay usable together.
      return { ok: false, why: `unknown type: ${String(parsed.t)}` };
  }
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isVersion(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const counter of Object.values(value)) {
    if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
      return false;
    }
  }
  return true;
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isOp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.t !== 'object' &&
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    /^[1-9]\d*@.+$/.test(value.id)
  );
}
