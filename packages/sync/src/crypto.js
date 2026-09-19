/**
 * Locking the document before it leaves the machine.
 *
 * ## Where the key lives
 *
 * In the fragment of the address — the part after the `#`. Browsers never send
 * a fragment to a server, so a link like
 *
 *     https://.../doc/k3f9c1d8#s7Yk2p...
 *
 * carries the key past the introduction service without it ever seeing it. The
 * server learns that two people want the same room, and nothing else.
 *
 * That also means the link *is* the key. Anyone who has it can read the
 * document, and losing it loses the document, because nothing anywhere else can
 * decrypt it. That is the trade that comes with not trusting a server.
 *
 * ## What this is, and is not
 *
 * This wraps a connection so that everything crossing it is encrypted. It does
 * not authenticate anybody. A peer holding the key is treated as entitled to
 * the document, which is exactly as strong as the link-sharing model implies.
 * Identity would need a separate handshake, and pretending otherwise would be
 * worse than saying so.
 *
 * AES-GCM detects tampering as well as hiding content: a message altered in
 * flight fails to decrypt rather than decrypting to something else. Every
 * message gets a fresh random nonce, because reusing one with the same key in
 * GCM is catastrophic rather than merely untidy.
 */

/** @typedef {import('./session.js').Channel} Channel */

/** Bytes of randomness in a nonce. 96 bits is what GCM is specified for. */
const NONCE = 12;

/**
 * Make a key for a new document.
 *
 * @returns {Promise<CryptoKey>}
 */
export function newKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Turn a key into text short enough to live in a link.
 *
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function keyToText(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return base64url(raw);
}

/**
 * Read a key back out of a link.
 *
 * @param {string} text
 * @returns {Promise<CryptoKey>}
 */
export function keyFromText(text) {
  return crypto.subtle.importKey('raw', unbase64url(text), { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Wrap a connection so everything crossing it is encrypted.
 *
 * The sync protocol above this is unchanged and unaware. Encryption belongs to
 * the transport, so a message is locked exactly once, on its way out, and the
 * code that decides *what* to send does not have to think about it at all.
 *
 * @param {Channel} channel
 * @param {CryptoKey} key
 * @param {object} [options]
 * @param {(why: string) => void} [options.onUnreadable]
 *   Called when a message cannot be decrypted — a peer with the wrong key, or
 *   something altered on the way. Dropped either way; this is only so the app
 *   can say something useful rather than appearing to be broken.
 * @returns {Channel}
 */
export function encrypted(channel, key, options = {}) {
  const onUnreadable = options.onUnreadable ?? (() => {});
  /** @type {(data: string) => void} */
  let deliver = () => {};

  channel.onMessage(async (data) => {
    try {
      deliver(await open(key, data));
    } catch {
      // Deliberately not specific. Saying *why* a message failed to decrypt
      // tells whoever sent it something about the key, and there is nothing
      // useful to do differently for each cause anyway.
      onUnreadable('a message could not be read');
    }
  });

  return {
    send: (data) => {
      // The promise is not awaited because `send` cannot wait -- it is called
      // from ordinary synchronous code. A send that fails is no worse than a
      // dropped packet, which the protocol already recovers from at the next
      // handshake.
      seal(key, data).then(
        (sealed) => channel.send(sealed),
        () => {},
      );
    },
    onMessage: (handler) => {
      deliver = handler;
    },
    isOpen: () => channel.isOpen(),
    onClose: channel.onClose ? (handler) => channel.onClose?.(handler) : undefined,
    close: channel.close ? () => channel.close?.() : undefined,
  };
}

/**
 * Encrypt one message. The nonce travels in front of the ciphertext.
 *
 * @param {CryptoKey} key
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function seal(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE));
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
  );

  const packed = new Uint8Array(new ArrayBuffer(iv.length + body.length));
  packed.set(iv, 0);
  packed.set(body, iv.length);
  return base64url(packed);
}

/**
 * Decrypt one message, or throw.
 *
 * @param {CryptoKey} key
 * @param {string} packed
 * @returns {Promise<string>}
 */
export async function open(key, packed) {
  const bytes = unbase64url(packed);
  if (bytes.length <= NONCE) throw new Error('too short to be a message');

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, NONCE) },
    key,
    bytes.subarray(NONCE),
  );
  return new TextDecoder().decode(plain);
}

/**
 * Base64 without the characters that need escaping in a URL.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * @param {string} text
 * @returns {Uint8Array<ArrayBuffer>} Explicitly not shared memory, which is
 *   the one kind of buffer Web Crypto refuses.
 */
function unbase64url(text) {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));

  // Built over an explicit buffer so the type is a plain Uint8Array rather
  // than one that might be backed by shared memory. Web Crypto will not accept
  // the latter, and the difference is invisible until the typechecker says so.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
