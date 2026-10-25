/**
 * Offline cache for drone imagery tiles.
 *
 * The drone layers read .pmtiles archives over HTTP range requests (see
 * WorkerSource in js/drone-tiles.js). Nothing along that path stores
 * anything: the requests carry an Authorization header and come back as 206
 * Partial Content, which browsers cache poorly or not at all, and the
 * service worker deliberately ignores cross-origin requests, so
 * tiles.victoriasugar.ug never reaches a cache layer.
 *
 * That left OpenLayers' in-memory cache as the only thing holding tiles, and
 * it is smaller than it looks. A source built without an explicit cacheSize
 * starts at a high-water mark of zero, and updateCacheSize() only ever raises
 * it to the number of tiles the CURRENT viewport needs. Zoom in a few levels
 * and the wide-view tiles are evicted; zoom back out and they have to be
 * fetched again — instant on a good link, a blank screen on a bad one. A
 * page reload wipes it entirely.
 *
 * So the raw tile bytes are kept here instead, keyed by archive and tile
 * coordinate. A tile you have already looked at renders from disk forever
 * after, including offline and across reloads. Nothing is downloaded up
 * front: the cache fills with exactly the areas and zoom levels someone
 * actually visited.
 *
 * Bytes are stored rather than blob URLs or decoded images. A blob URL is
 * only valid for the page that created it, and decoded bitmaps are far
 * larger than the compressed original.
 */

const DB_NAME = "vsl-tile-cache";
const DB_VERSION = 1;
const STORE = "tiles";
/** Secondary index over `usedAt`, so eviction can walk oldest-first without
 *  loading every record into memory to sort it. */
const INDEX_USED_AT = "usedAt";

/**
 * Roughly how much imagery to keep. Drone tiles run 20-60KB each, so this is
 * on the order of 5,000-15,000 tiles — comfortably a few surveys at working
 * zoom levels. Browsers grant origins far more than this, but a cache that
 * grows without limit on a shared field tablet is its own problem.
 */
const MAX_BYTES = 300 * 1024 * 1024;

/** Evicting one tile at a time would mean a write transaction per tile, so
 *  once over the cap we clear down to this fraction of it in one pass. */
const EVICT_TO = 0.8;

/** Re-stamping `usedAt` on every single hit would turn every cached tile
 *  render into a write. Once a day is enough to keep genuinely-used tiles
 *  away from the eviction end of the index. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Record shape: { key, bytes: ArrayBuffer, size: number, usedAt: number } */

let dbPromise = null;
/** Running total, read once on open so put() doesn't have to count the store
 *  every time. Approximate between sessions is fine — it self-corrects. */
let bytesStored = null;

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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex(INDEX_USED_AT, "usedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  }).catch((e) => {
    dbPromise = null; // a later call deserves a fresh attempt
    throw e;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let out;
        try {
          out = fn(t.objectStore(STORE));
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** Stable key for one tile of one archive. */
export function tileKey(archiveKey, z, x, y) {
  return `${archiveKey}|${z}/${x}/${y}`;
}

/** Totals the stored sizes once, so eviction has something to count against. */
async function ensureTotal() {
  if (bytesStored !== null) return bytesStored;
  let total = 0;
  try {
    await tx("readonly", (store) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        total += cursor.value?.size || 0;
        cursor.continue();
      };
      return null;
    });
    bytesStored = total;
  } catch {
    bytesStored = 0;
  }
  return bytesStored;
}

/**
 * Drops least-recently-used tiles until the store is back under EVICT_TO of
 * the cap. Walks the usedAt index from the oldest end.
 */
async function evictIfNeeded() {
  const total = await ensureTotal();
  if (total <= MAX_BYTES) return;
  const target = MAX_BYTES * EVICT_TO;
  let freed = 0;
  try {
    await tx("readwrite", (store) => {
      const cursorReq = store.index(INDEX_USED_AT).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (total - freed <= target) return; // done; stop walking
        freed += cursor.value?.size || 0;
        cursor.delete();
        cursor.continue();
      };
      return null;
    });
    bytesStored = Math.max(0, total - freed);
  } catch (e) {
    console.warn("[Victoria Drone] Tile cache eviction failed:", e);
  }
}

/**
 * The stored bytes for a tile, or null on a miss.
 *
 * Never throws — a miss and an unusable cache mean the same thing to the
 * caller, which is "go and fetch it".
 */
export async function readTile(key) {
  try {
    const record = await tx("readonly", (store) => store.get(key));
    if (!record || !record.bytes) return null;
    // Touched sparingly; see TOUCH_AFTER_MS.
    if (Date.now() - (record.usedAt || 0) > TOUCH_AFTER_MS) {
      tx("readwrite", (store) => store.put({ ...record, usedAt: Date.now() })).catch(() => {});
    }
    return record.bytes;
  } catch {
    return null;
  }
}

/** Stores one tile's bytes. Failure is logged, never thrown — a device that
 *  can't cache must still be able to show imagery. */
export async function writeTile(key, bytes) {
  if (!bytes || !bytes.byteLength) return false;
  try {
    const size = bytes.byteLength;
    await tx("readwrite", (store) => store.put({ key, bytes, size, usedAt: Date.now() }));
    bytesStored = (await ensureTotal()) + size;
    // Deliberately not awaited: the tile is already stored and on screen, and
    // trimming the cache shouldn't hold up the next one.
    if (bytesStored > MAX_BYTES) evictIfNeeded();
    return true;
  } catch (e) {
    console.warn("[Victoria Drone] Couldn't cache a tile:", e);
    return false;
  }
}

/** How much imagery is held, for a settings or status readout. */
export async function tileCacheSize() {
  return ensureTotal();
}

/**
 * Empties the cache. Called on sign-out — the imagery sits on the device in
 * plain IndexedDB, and the Worker's token check protects the server, not a
 * local copy.
 */
export async function clearTileCache() {
  try {
    await tx("readwrite", (store) => store.clear());
    bytesStored = 0;
    return true;
  } catch (e) {
    console.warn("[Victoria Drone] Couldn't clear the tile cache:", e);
    return false;
  }
}
