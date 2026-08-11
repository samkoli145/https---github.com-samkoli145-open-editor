export interface CacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number | null;
}

/**
 * High-performance, O(1) LRU Cache with TTL support.
 * Tailored for sub-10ms latency budgets in LLM prompt caching, tool outputs, and preloaded pattern lookups.
 */
export class LRUCache<K, V> {
  private maxSize: number;
  private defaultTtlMs: number | null;
  private cache = new Map<K, CacheEntry<V>>();

  private hits = 0;
  private misses = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize && options.maxSize > 0 ? options.maxSize : 500;
    this.defaultTtlMs = options.defaultTtlMs && options.defaultTtlMs > 0 ? options.defaultTtlMs : null;
  }

  public get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Refresh position in Map for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  public set(key: K, value: V, ttlMs?: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl ? Date.now() + ttl : null;
    this.cache.set(key, { value, expiresAt });
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: K): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public size(): number {
    return this.cache.size;
  }

  public getMetrics(): { size: number; maxSize: number; hits: number; misses: number; hitRatio: number } {
    const total = this.hits + this.misses;
    const hitRatio = total > 0 ? this.hits / total : 0;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRatio: Number(hitRatio.toFixed(3))
    };
  }
}
