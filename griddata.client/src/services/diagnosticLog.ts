const DB_NAME = 'griddata-diagnostics'
const STORE_NAME = 'reports'
const MAX_REPORTS = 5000

/**
 * Persist a completed receiver report on that receiver device.  IndexedDB is
 * deliberately used instead of a server call: an optical transfer must remain
 * completely usable when the display and camera devices have no network link.
 */
export function saveDiagnosticReport(report: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve()
  return new Promise(resolve => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
    open.onerror = () => resolve()
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.add({ createdAt: new Date().toISOString(), report })
      // Maintain a bounded local history without delaying a finished transfer.
      const count = store.count()
      count.onsuccess = () => {
        let excess = Math.max(0, count.result - MAX_REPORTS)
        if (!excess) return
        store.openCursor().onsuccess = event => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
          if (!cursor || excess <= 0) return
          cursor.delete(); excess--; cursor.continue()
        }
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = tx.onabort = () => { db.close(); resolve() }
    }
  })
}
