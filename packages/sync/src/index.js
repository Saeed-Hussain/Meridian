/**
 * @meridian/sync — the sync protocol.
 *
 * Transport-agnostic on purpose. Nothing in this package mentions WebRTC or
 * WebSocket; both are just something that carries strings. That is what makes
 * the protocol testable over a fake network that drops and reorders messages,
 * which is where the real bugs are.
 */

export { Network } from './network.js';
export { Session } from './session.js';
export { encode, decode, MAX_MESSAGE, MAX_PRESENCE } from './protocol.js';
export { encrypted, newKey, keyToText, keyFromText, seal, open } from './crypto.js';

// The browser transport is deliberately *not* re-exported here. It is reached
// as `@meridian/sync/webrtc`, so that importing the protocol in Node never
// pulls in code written against RTCPeerConnection.
