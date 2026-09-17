/**
 * @meridian/core — the merge algorithm.
 *
 * Plain JavaScript, no dependencies, no framework. This package must never
 * import React, Next.js or anything from the browser, so that it stays testable
 * in plain Node and reusable in Electron.
 */

export { Doc } from './doc.js';
export { Text } from './text.js';
export { FieldMap } from './map.js';
export { TagSet } from './set.js';
export { OpLog } from './oplog.js';
export { Clock, compareIds, parseId, randomSite } from './id.js';
