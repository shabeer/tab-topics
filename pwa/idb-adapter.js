// IndexedDB storage adapter for Tab Topics PWA.
// Conforms to the { async get(key), async set(value, key) } adapter interface in store.js.

const DB_NAME = 'TabTopicsDB';
const STORE_NAME = 'keyval';
const DB_VERSION = 1;
const DEFAULT_KEY = 'tabTopicsState';

let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not available'));
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

export function indexedDbAdapter() {
  return {
    async get(key = DEFAULT_KEY) {
      try {
        const db = await getDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
      } catch {
        // Fallback to localStorage if IndexedDB fails
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      }
    },

    async set(value, key = DEFAULT_KEY) {
      try {
        const db = await getDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const req = store.put(value, key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } catch {
        // Fallback to localStorage
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // ignore storage quota errors
        }
      }
    },
  };
}
