import { Result, ok, err } from '../../kernel/core/result';
import { LRUCache } from '../../kernel/core/cache';
import { SafeSystemStorageEngine } from '../../system/storage';
import { KnowledgeEntry, KnowledgeTier, RecallQuery, InteractionContext } from './types';

export const SOURCE_RELIABILITY_WEIGHTS: Record<string, number> = {
  'user_interface': 1.0,
  'user_preference': 1.0,
  'system_command': 0.90,
  'cli': 0.90,
  'editor_manager': 0.90,
  'local_llm': 0.75,
  'hermes': 0.75,
  'snowball:teach': 0.85,
  'external_cloud': 0.50,
  'external': 0.50
};

export const PROMOTION_THRESHOLD = 0.85;
export const MAX_KNOWLEDGE_RECORDS = 2000;

export class KnowledgeLayer {
  private cache: LRUCache<string, KnowledgeEntry>;
  private inMemoryMap: Map<string, KnowledgeEntry> = new Map();
  private storage: SafeSystemStorageEngine;
  private readonly storagePrefix = 'snowball/knowledge/';
  public readonly maxRecords: number = MAX_KNOWLEDGE_RECORDS;

  constructor(
    storage?: SafeSystemStorageEngine,
    private readonly maxCacheSize: number = 1000,
    private readonly defaultTtlMs: number = 3600000 // 1 hour
  ) {
    this.storage = storage || new SafeSystemStorageEngine('/vfs/snowball');
    this.cache = new LRUCache<string, KnowledgeEntry>({
      maxSize: maxCacheSize,
      defaultTtlMs: defaultTtlMs
    });
  }

  /**
   * Calculates source reliability weight based on origin
   */
  public getSourceReliabilityWeight(source: string): number {
    if (SOURCE_RELIABILITY_WEIGHTS[source] !== undefined) {
      return SOURCE_RELIABILITY_WEIGHTS[source];
    }
    for (const [key, weight] of Object.entries(SOURCE_RELIABILITY_WEIGHTS)) {
      if (source.includes(key)) return weight;
    }
    return 0.70;
  }

  /**
   * Calculates LFU/LRU score with exponential decay factor:
   * Score = Confidence * AccessCount * e^(-lambda * AgeMs)
   * Half-life = 7 days (604,800,000 ms)
   */
  public calculateEntryScore(entry: KnowledgeEntry, now: number = Date.now()): number {
    if (entry.tags?.includes('system_pinned') || entry.tags?.includes('pinned')) {
      return Infinity; // Protected from eviction
    }
    const ageMs = Math.max(0, now - entry.lastAccessed);
    const halfLifeMs = 7 * 24 * 3600 * 1000;
    const lambda = Math.LN2 / halfLifeMs;
    const decayFactor = Math.exp(-lambda * ageMs);
    return entry.confidence * entry.accessCount * decayFactor;
  }

  /**
   * Evicts lowest scoring entries if storage exceeds maxRecords
   */
  private async evictIfOverflow(): Promise<number> {
    if (this.inMemoryMap.size < this.maxRecords) return 0;

    const now = Date.now();
    const entries = Array.from(this.inMemoryMap.values());
    
    entries.sort((a, b) => this.calculateEntryScore(a, now) - this.calculateEntryScore(b, now));

    let evictedCount = 0;
    const targetSize = Math.floor(this.maxRecords * 0.9);

    for (const entry of entries) {
      if (this.inMemoryMap.size <= targetSize) break;
      if (this.calculateEntryScore(entry, now) === Infinity) continue;

      await this.remove(entry.id);
      evictedCount++;
    }

    return evictedCount;
  }

  /**
   * إضافة أو تحديث معرفة جديدة مع التخزين الدائم والكاش
   */
  async add(
    entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'lastAccessed' | 'createdAt' | 'updatedAt'>
  ): Promise<Result<KnowledgeEntry, Error>> {
    const existing = await this.findByKey(entry.key, entry.tier);

    const sourceWeight = this.getSourceReliabilityWeight(entry.source);
    const effectiveConfidence = Math.min(1.0, entry.confidence * sourceWeight);

    if (existing.isOk) {
      return this.update(existing.value.id, {
        ...entry,
        confidence: Math.max(existing.value.confidence, effectiveConfidence),
        accessCount: existing.value.accessCount + 1
      });
    }

    await this.evictIfOverflow();

    const newEntry: KnowledgeEntry = {
      ...entry,
      confidence: effectiveConfidence,
      id: this.generateId(),
      accessCount: 1,
      lastAccessed: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const saveResult = await this.storage.save(
      `${this.storagePrefix}${newEntry.tier}/${newEntry.key}`,
      newEntry
    );

    if (saveResult.isErr) {
      return err(new Error(`Failed to save knowledge: ${saveResult.error.message}`));
    }

    this.cache.set(newEntry.key, newEntry);
    this.inMemoryMap.set(newEntry.key, newEntry);

    return ok(newEntry);
  }

  /**
   * إضافة معرفة متوافقة مزامنة (Sync API Fallback)
   */
  public async addEntry(
    tier: KnowledgeTier,
    key: string,
    data: unknown,
    options?: { confidence?: number; tags?: string[]; source?: string }
  ): Promise<Result<KnowledgeEntry, Error>> {
    return this.add({
      tier,
      key,
      data,
      confidence: options?.confidence ?? 0.5,
      tags: options?.tags || [tier],
      source: options?.source || 'snowball_layer'
    });
  }

  /**
   * استرجاع المعرفة بناءً على استعلام ومعايير التصفية
   */
  async recall(query: RecallQuery): Promise<Result<KnowledgeEntry[], Error>> {
    const results: KnowledgeEntry[] = [];
    const tiers = query.tier ? [query.tier] : this.getAllTiers();

    for (const tier of tiers) {
      const tierResults = await this.recallFromTier(tier, query);
      if (tierResults.isOk) {
        results.push(...tierResults.value);
      }
    }

    const sorted = this.sortResults(results, query.orderBy || 'recency');
    const limited = sorted.slice(0, query.limit || 50);

    for (const entry of limited) {
      await this.touchEntry(entry);
    }

    return ok(limited);
  }

  /**
   * استرجاع معرفة بواسطة المفتاح والطبقة
   */
  async findByKey(key: string, tier: KnowledgeTier): Promise<Result<KnowledgeEntry, Error>> {
    const cached = this.cache.get(key);
    if (cached && cached.tier === tier) {
      return ok(cached);
    }

    if (this.inMemoryMap.has(key)) {
      const mem = this.inMemoryMap.get(key)!;
      if (mem.tier === tier) {
        this.cache.set(key, mem);
        return ok(mem);
      }
    }

    const stored = await this.storage.load<KnowledgeEntry>(
      `${this.storagePrefix}${tier}/${key}`
    );

    if (stored.isErr) {
      return err(new Error(`Knowledge not found: ${key}`));
    }

    this.cache.set(key, stored.value);
    this.inMemoryMap.set(key, stored.value);
    return ok(stored.value);
  }

  /**
   * تحديث معرفة موجودة بالمعرّف
   */
  async update(id: string, updates: Partial<KnowledgeEntry>): Promise<Result<KnowledgeEntry, Error>> {
    const findResult = await this.findById(id);
    if (findResult.isErr) {
      return err(findResult.error);
    }

    const updated: KnowledgeEntry = {
      ...findResult.value,
      ...updates,
      id: findResult.value.id,
      updatedAt: Date.now()
    };

    const saveResult = await this.storage.save(
      `${this.storagePrefix}${updated.tier}/${updated.key}`,
      updated
    );

    if (saveResult.isErr) {
      return err(new Error(`Failed to update knowledge: ${saveResult.error.message}`));
    }

    this.cache.set(updated.key, updated);
    this.inMemoryMap.set(updated.key, updated);

    return ok(updated);
  }

  /**
   * حذف معرفة بواسطة المعرّف
   */
  async remove(id: string): Promise<Result<void, Error>> {
    const findResult = await this.findById(id);
    if (findResult.isErr) {
      return err(findResult.error);
    }

    const deleteResult = await this.storage.delete(
      `${this.storagePrefix}${findResult.value.tier}/${findResult.value.key}`
    );

    if (deleteResult.isErr) {
      return err(new Error(`Failed to delete knowledge: ${deleteResult.error.message}`));
    }

    this.cache.delete(findResult.value.key);
    this.inMemoryMap.delete(findResult.value.key);
    return ok(undefined);
  }

  /**
   * إحصائيات الطبقات المعرفية
   */
  async getStats(): Promise<Result<Record<KnowledgeTier, number>, Error>> {
    const stats: Record<KnowledgeTier, number> = {
      discovery: 0,
      capability: 0,
      pattern: 0,
      context: 0,
      prediction: 0
    };

    for (const entry of this.inMemoryMap.values()) {
      if (stats[entry.tier] !== undefined) {
        stats[entry.tier]++;
      }
    }

    return ok(stats);
  }

  // ─── Direct Synchronous Compatibility Methods ──────────────────────

  public async getEntry(key: string): Promise<KnowledgeEntry | undefined> {
    for (const tier of this.getAllTiers()) {
      const res = await this.findByKey(key, tier);
      if (res.isOk) return res.value;
    }
    return undefined;
  }

  public query(query: RecallQuery): KnowledgeEntry[] {
    let results = Array.from(this.inMemoryMap.values());

    if (query.tier) {
      results = results.filter(e => e.tier === query.tier);
    }

    if (query.minConfidence !== undefined) {
      const minConf = query.minConfidence;
      results = results.filter(e => e.confidence >= minConf);
    }

    if (query.tags && query.tags.length > 0) {
      const queryTags = query.tags;
      results = results.filter(e => queryTags.some(t => e.tags.includes(t)));
    }

    const orderBy = query.orderBy || 'recency';
    results = this.sortResults(results, orderBy);

    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  public getByTier(tier: KnowledgeTier): KnowledgeEntry[] {
    return this.query({ tier });
  }

  public countByTier(): Record<KnowledgeTier, number> {
    const counts: Record<KnowledgeTier, number> = {
      discovery: 0,
      capability: 0,
      pattern: 0,
      context: 0,
      prediction: 0
    };

    for (const entry of this.inMemoryMap.values()) {
      counts[entry.tier] = (counts[entry.tier] || 0) + 1;
    }

    return counts;
  }

  public totalCount(): number {
    return this.inMemoryMap.size;
  }

  // ─── Private Utility Methods ───────────────────────────────────────

  private async recallFromTier(tier: KnowledgeTier, query: RecallQuery): Promise<Result<KnowledgeEntry[], Error>> {
    let filtered = Array.from(this.inMemoryMap.values()).filter(e => e.tier === tier);

    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter(e =>
        query.tags!.some(tag => e.tags.includes(tag))
      );
    }

    if (query.minConfidence !== undefined) {
      filtered = filtered.filter(e => e.confidence >= query.minConfidence!);
    }

    if (query.context) {
      filtered = filtered.filter(e => this.matchesContext(e, query.context!));
    }

    return ok(filtered);
  }

  private matchesContext(entry: KnowledgeEntry, context: Partial<InteractionContext>): boolean {
    const data = entry.data as Record<string, unknown>;
    if (!data || typeof data !== 'object') return true;

    return Object.entries(context).every(([key, value]) => {
      if (value === undefined) return true;
      return data[key] === value;
    });
  }

  private sortResults(
    entries: KnowledgeEntry[],
    orderBy: 'confidence' | 'recency' | 'accessCount'
  ): KnowledgeEntry[] {
    return [...entries].sort((a, b) => {
      switch (orderBy) {
        case 'confidence':
          return b.confidence - a.confidence;
        case 'recency':
          return b.lastAccessed - a.lastAccessed;
        case 'accessCount':
          return b.accessCount - a.accessCount;
        default:
          return 0;
      }
    });
  }

  private async touchEntry(entry: KnowledgeEntry): Promise<void> {
    const updated: KnowledgeEntry = {
      ...entry,
      accessCount: entry.accessCount + 1,
      lastAccessed: Date.now()
    };
    await this.storage.save(`${this.storagePrefix}${entry.tier}/${entry.key}`, updated);
    this.cache.set(entry.key, updated);
    this.inMemoryMap.set(entry.key, updated);
  }

  private async findById(id: string): Promise<Result<KnowledgeEntry, Error>> {
    for (const entry of this.inMemoryMap.values()) {
      if (entry.id === id) return ok(entry);
    }
    return err(new Error(`Knowledge not found: ${id}`));
  }

  private getAllTiers(): KnowledgeTier[] {
    return ['discovery', 'capability', 'pattern', 'context', 'prediction'];
  }

  private generateId(): string {
    return `know_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
