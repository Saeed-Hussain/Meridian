/**
 * The only door between the page and the application.
 *
 * Everything the interface can reach outside its own tab is listed here, in
 * full, in one file. That is the point of a preload: not to be convenient, but
 * to make the whole surface readable at a glance.
 *
 * Four functions, matching the store contract the rest of the project already
 * defines and tests. No file paths, no queries, no method names chosen by the
 * caller — just the four things a document needs to be saved.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meridian', {
  /** True so the page can tell it is running as an application. */
  desktop: true,

  store: {
    /**
     * @param {string} id
     * @returns {Promise<string>}
     */
    site: (id) => ipcRenderer.invoke('store:site', id),

    /**
     * @param {string} id
     * @returns {Promise<{snapshot: object | null, ops: object[]}>}
     */
    read: (id) => ipcRenderer.invoke('store:read', id),

    /**
     * @param {string} id
     * @param {object[]} ops
     * @returns {Promise<void>}
     */
    append: (id, ops) => ipcRenderer.invoke('store:append', id, ops),

    /**
     * @param {string} id
     * @param {object} snapshot
     * @returns {Promise<void>}
     */
    replace: (id, snapshot) => ipcRenderer.invoke('store:replace', id, snapshot),
  },
});
