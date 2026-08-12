import { Result, ok, err } from '../../kernel/core/result';
import { LRUCache } from '../../kernel/core/cache';
import { SafeSystemStorageEngine } from '../../system/storage';
import { KnowledgeEntry, KnowledgeTier, RecallQuery, InteractionContext } from './types';

export class KnowledgeLayer {
  private cache: LRUCache<string, KnowledgeEntry>;
  private inMemoryMap: Map<string, KnowledgeEntry> = new Map();
  private storage: SafeSystemStorageEngine;
  private readonly storagePrefix = 'snowball/knowledge/';

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
   * إضافة أو تحديث معرفة جديدة مع التخزين الدائم والكاش
   */
  async add(
    entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'lastAccessed' | 'createdAt' | 'updatedAt'>
  ): Promise<Result<KnowledgeEntry, Error>> {
    const existing = await this.findByKey(entry.key, entry.tier);

    if (existing.isOk) {
      return this.update(existing.value.id, {
        ...entry,
        confidence: Math.max(existing.value.confidence, entry.confidence),
        accessCount: existing.value.accessCount + 1
      });
    }

    const newEntry: KnowledgeEntry = {
      ...entry,
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
