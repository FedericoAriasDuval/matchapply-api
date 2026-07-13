/**
 * src/lib/cache.js
 * Caché LRU en memoria con TTL. Módulo puro, sin dependencias.
 *
 * Evita pagar dos veces la misma llamada al LLM: el mismo CV (mismo sha256 del
 * texto) devuelve el mismo JSON estructurado. Además deduplica llamadas
 * concurrentes idénticas (thundering herd).
 */
export class LruCache {
  constructor({ max = 200, ttlMs = 60 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this._inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // pasa a ser el más reciente
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value); // expulsa el menos usado recientemente
    }
    return value;
  }

  /** Devuelve el valor cacheado o ejecuta fn() y lo guarda. */
  async wrap(key, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this._inflight.has(key)) return this._inflight.get(key);

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value);
        return value;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, p);
    return p;
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    };
  }

  clear() {
    this.map.clear();
    this._inflight.clear();
  }
}

/** Caché del parseo de CVs: 1 hora, 300 documentos. */
export const cvCache = new LruCache({ max: 300, ttlMs: 60 * 60 * 1000 });
