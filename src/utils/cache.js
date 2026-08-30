/**
 * High-performance, lightweight in-memory cache for high-traffic public queries
 * (homepage featured/trending events, categories, public organizers).
 *
 * Automatically invalidates on event creation, update, deletion, or publishing.
 */

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.data;
  }

  set(key, data, ttlMs = 60000) {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key) {
    this.store.delete(key);
  }

  clearPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clearAll() {
    this.store.clear();
  }
}

export const cache = new MemoryCache();
export default cache;
