/**
 * Offline cache for the land boundaries (blocks, plots, title boundaries).
 *
 * The map normally draws from vsl_get_features_bbox, which re-queries on
 * every pan and zoom. That's fine on a desk but useless in a field with one
 * bar of signal: nothing renders until the network answers, and the device
 * never holds a complete set of anything.
 *
 * So the rows are kept in IndexedDB and the map draws from there first.
 * Staying current is handled by a counter in the database
 * (public.vsl_sync_version, bumped by a trigger on every insert, update and
 * delete across the land tables): the client stores the version it
 * downloaded, and on the next check compares its copy against the server's.
 * Same number, nothing to do. Different number, re-download in the
 * background. The check is one tiny row — cheap enough to run on a bad
 * connection, and harmless when it fails.
 *
 * Why IndexedDB and not localStorage: localStorage is synchronous (it blocks
 * the page while it reads) and capped around 5MB of *strings*, so the rows
 * would have to be JSON.stringify'd and re-parsed on every load. IndexedDB
 * stores the array as-is and reads it off the main thread.
 *
 * Nothing here talks to Supabase. The caller owns fetching; this module only
 * stores, reads and clears.
 */

const DB_NAME = "vsl-land-cache";
const DB_VERSION = 1;
const STORE = "land";
/** Single record key — the cache is all-or-nothing, not per-feature. */
const RECORD_KEY = "current";

/** Shape stored under RECORD_KEY:
 *  { version: number, savedAt: string (ISO), rows: Array<bbox-RPC row> } */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Fires when another tab holds an older version of the database open.
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  }).catch((e) => {
    // Don't cache a rejected promise — a later call (different tab state,
    // storage re-granted) deserves a fresh attempt.
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function runTx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(result && "result" in result ? result.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/**
 * The cached land rows, or null when there's nothing usable stored.
 *
 * Never throws: a missing, blocked or corrupt cache is a normal state (first
 * run, private browsing, storage cleared) and the caller's answer is the same
 * in all of them — go to the network.
 */
export async function readLandCache() {
  try {
    const record = await runTx("readonly", (store) => store.get(RECORD_KEY));
    if (!record || !Array.isArray(record.rows)) return null;
    return record;
  } catch (e) {
    console.warn("[Victoria map] Land cache unreadable:", e);
    return null;
  }
}

/**
 * Replaces the cache with a complete set of rows.
 *
 * Call this only once every row is in hand. A half-finished download must
 * never be written — a partial cache looks authoritative and would hide
 * plots that actually exist. There's no staging copy here because there
 * doesn't need to be one: an IndexedDB transaction either commits whole or
 * aborts whole, so if this put fails (quota, storage evicted) the previous
 * cache survives untouched.
 *
 * Returns true when stored. Failure is logged, not thrown — a device that
 * can't cache should still be able to use the map online.
 */
export async function writeLandCache(version, rows) {
  if (!Array.isArray(rows)) return false;
  const record = { version, savedAt: new Date().toISOString(), rows };
  try {
    await runTx("readwrite", (store) => store.put(record, RECORD_KEY));
    return true;
  } catch (e) {
    console.warn("[Victoria map] Couldn't write the land cache:", e);
    return false;
  }
}

/**
 * Empties the cache. Called on sign-out: the rows sit on the device in plain
 * IndexedDB, and row-level security protects the database, not a local copy.
 */
export async function clearLandCache() {
  try {
    await runTx("readwrite", (store) => store.delete(RECORD_KEY));
    return true;
  } catch (e) {
    console.warn("[Victoria map] Couldn't clear the land cache:", e);
    return false;
  }
}
