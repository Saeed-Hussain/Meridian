/**
 * Saving a document to SQLite.
 *
 * This is the store used by the desktop app, and by anything running in Node.
 *
 * It takes a database object rather than opening one itself, and only uses
 * `exec` and `prepare`. Both `node:sqlite` (built into Node 22 and later) and
 * `better-sqlite3` provide exactly that, so the same adapter works with
 * either. That matters because Electron ships its own build of Node: whichever
 * of the two is available there, this file does not have to change.
 */

/** @typedef {import('@meridian/core/src/oplog.js').Op} Op */

/**
 * The small part of a SQLite driver this needs.
 *
 * @typedef {object} Statement
 * @property {(...params: any[]) => any} run
 * @property {(...params: any[]) => any} get
 * @property {(...params: any[]) => any[]} all
 *
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => Statement} prepare
 * @property {() => void} [close]
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- The change id is the primary key, so storing the same change twice is a
  -- no-op rather than a duplicate row. Retrying a half-finished write is
  -- normal, and this is what makes it safe.
  --
  -- NOT NULL is not redundant here. SQLite allows NULL in a TEXT PRIMARY KEY
  -- column, unlike almost every other database, so without this a change with
  -- no id would be stored happily and break on the way back out.
  CREATE TABLE IF NOT EXISTS ops (
    id   TEXT PRIMARY KEY NOT NULL,
    json TEXT NOT NULL
  );

  -- At most one row, enforced by the check rather than by hoping.
  CREATE TABLE IF NOT EXISTS snapshot (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  );
`;

export class SqlStore {
  /**
   * @param {Database} db An open database. The caller owns it.
   * @param {object} [options]
   * @param {boolean} [options.durable]
   *   When true, SQLite is told to wait for the disk on every commit. Slower,
   *   and the only setting under which "it was saved" survives the machine
   *   losing power rather than just the app crashing.
   */
  constructor(db, options = {}) {
    /** @type {Database} */
    this.db = db;

    // Write-ahead logging, so a reader never blocks the writer and a crash
    // mid-write leaves a recoverable file rather than a torn one.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${options.durable ? 'FULL' : 'NORMAL'}`);
    db.exec(SCHEMA);

    this.statements = {
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      // `ON CONFLICT(id) DO NOTHING` rather than `INSERT OR IGNORE`: the
      // former ignores only a repeated id, which is expected and harmless,
      // while the latter ignores *every* constraint failure. Under OR IGNORE a
      // change with no id was accepted, written nowhere, and reported as
      // saved — which is the one outcome this whole layer exists to prevent.
      addOp: db.prepare(
        'INSERT INTO ops (id, json) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
      ),
      allOps: db.prepare('SELECT json FROM ops'),
      getSnapshot: db.prepare('SELECT json FROM snapshot WHERE id = 1'),
      setSnapshot: db.prepare('INSERT OR REPLACE INTO snapshot (id, json) VALUES (1, ?)'),
      clearOps: db.prepare('DELETE FROM ops'),
    };
  }

  /**
   * This device's id, made once and kept.
   * @returns {Promise<string>}
   */
  async site() {
    const row = this.statements.getMeta.get('site');
    if (row) return String(row.value);

    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const site = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    this.statements.setMeta.run('site', site);
    return site;
  }

  /**
   * @param {Op[]} ops
   * @returns {Promise<void>}
   */
  async append(ops) {
    if (ops.length === 0) return;
    // One transaction for the batch: either the whole keystroke run is stored
    // or none of it is. Committing per row would also be correct but is an
    // order of magnitude slower, which is felt while typing.
    this.db.exec('BEGIN');
    try {
      for (const op of ops) this.statements.addOp.run(op.id, JSON.stringify(op));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** @returns {Promise<{snapshot: object | null, ops: Op[]}>} */
  async read() {
    const snapshotRow = this.statements.getSnapshot.get();
    return {
      snapshot: snapshotRow ? JSON.parse(String(snapshotRow.json)) : null,
      ops: this.statements.allOps.all().map((row) => JSON.parse(String(row.json))),
    };
  }

  /**
   * Save the state and drop the stored changes together.
   *
   * The transaction is the whole point. A crash between writing the snapshot
   * and deleting the changes would be harmless; a crash between deleting the
   * changes and writing the snapshot would lose the document.
   *
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async replace(snapshot) {
    this.db.exec('BEGIN');
    try {
      this.statements.setSnapshot.run(JSON.stringify(snapshot));
      this.statements.clearOps.run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** @returns {Promise<void>} */
  async close() {
    this.db.close?.();
  }
}

/**
 * Open a SQLite-backed store using Node's built-in driver.
 *
 * A convenience for Node and tests. The browser has no SQLite, and the desktop
 * app may prefer `better-sqlite3`; both cases construct `SqlStore` directly.
 *
 * @param {string} path A file path, or `':memory:'`.
 * @param {object} [options]
 * @param {boolean} [options.durable]
 * @returns {Promise<SqlStore>}
 */
export async function openSqlite(path, options = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  return new SqlStore(new DatabaseSync(path), options);
}
