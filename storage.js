/**
 * Stage Manager Storage & IndexedDB Module
 * Manages tab screenshots (thumbnails) with strict URL binding and data integrity
 */

const DB_NAME = 'StageManagerDB';
const DB_VERSION = 1;
const STORE_THUMBNAILS = 'thumbnails';
const STORE_SETTINGS = 'settings';

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'tabId' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('Failed to open IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Standardize URL for comparisons (origin + pathname + search)
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`.replace(/\/+$/, '');
  } catch (e) {
    return String(url).trim().replace(/\/+$/, '');
  }
}

/**
 * Save screenshot thumbnail for a tab with strict URL binding
 * @param {number} tabId
 * @param {string} url
 * @param {string} dataUrl (Base64 JPEG)
 */
async function saveThumbnail(tabId, url, dataUrl) {
  if (!tabId || !url || !dataUrl) return false;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_THUMBNAILS, 'readwrite');
      const store = tx.objectStore(STORE_THUMBNAILS);
      store.put({
        tabId: Number(tabId),
        url: normalizeUrl(url),
        dataUrl,
        updatedAt: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[StageManager] saveThumbnail error:', err);
    return false;
  }
}

/**
 * Retrieve thumbnail for a tab, strictly verifying that the stored URL matches expectedUrl
 * @param {number} tabId
 * @param {string} [expectedUrl]
 * @returns {Promise<string|null>}
 */
async function getThumbnail(tabId, expectedUrl) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_THUMBNAILS, 'readonly');
      const store = tx.objectStore(STORE_THUMBNAILS);
      const req = store.get(Number(tabId));
      req.onsuccess = () => {
        const item = req.result;
        if (!item || !item.dataUrl) return resolve(null);

        // STRICT URL MATCHING:
        // If expectedUrl is provided, item MUST have a valid matching URL
        if (expectedUrl) {
          const expected = normalizeUrl(expectedUrl);
          const stored = normalizeUrl(item.url);
          if (!stored || expected !== stored) {
            return resolve(null);
          }
        }
        resolve(item.dataUrl);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

/**
 * Retrieve all thumbnails from IndexedDB in one operation
 * @returns {Promise<Array<{tabId: number, url: string, dataUrl: string}>>}
 */
async function getAllThumbnails() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_THUMBNAILS, 'readonly');
      const store = tx.objectStore(STORE_THUMBNAILS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

/**
 * Remove thumbnail when a tab is closed
 * @param {number} tabId
 */
async function removeThumbnail(tabId) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_THUMBNAILS, 'readwrite');
      const store = tx.objectStore(STORE_THUMBNAILS);
      store.delete(Number(tabId));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    return false;
  }
}

/**
 * Prune thumbnails that do not exist or whose URLs don't match the current active tabs
 * @param {Map<number, string>} tabUrlMap Map of tabId -> normalized URL
 */
async function pruneStaleThumbnails(tabUrlMap) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_THUMBNAILS, 'readwrite');
    const store = tx.objectStore(STORE_THUMBNAILS);
    const req = store.openCursor();
    let prunedCount = 0;

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        const currentUrl = tabUrlMap.get(item.tabId);
        // Stale if tab no longer exists OR stored url doesn't match current url
        if (!currentUrl || currentUrl !== normalizeUrl(item.url)) {
          cursor.delete();
          prunedCount++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      if (prunedCount > 0 && typeof Logger !== 'undefined') {
        Logger.info('Storage', `已清理 ${prunedCount} 个旧会话/失效缩略图缓存`);
      }
    };
  } catch (err) {
    console.warn('[StageManager] pruneStaleThumbnails error:', err);
  }
}

/**
 * Wipe all cached thumbnails completely
 */
async function clearAllThumbnails() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_THUMBNAILS, 'readwrite');
      const store = tx.objectStore(STORE_THUMBNAILS);
      store.clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    return false;
  }
}

// Export for module or global use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    saveThumbnail,
    getThumbnail,
    getAllThumbnails,
    removeThumbnail,
    pruneStaleThumbnails,
    clearAllThumbnails,
    normalizeUrl
  };
}
