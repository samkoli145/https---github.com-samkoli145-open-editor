import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { DisposableStore } from '../../kernel/core/disposable';
import { SafeSystemStorageEngine } from '../../system/storage';
import { Interaction, InteractionType, InteractionContext } from './types';

export class InteractionTracker {
  private disposables = new DisposableStore();
  private inMemoryBuffer: Interaction[] = [];
  private storage: SafeSystemStorageEngine;
  private eventBus: EventBus;
  private readonly storageKey = 'snowball/interactions';
  private readonly maxBufferSize = 2000;

  constructor(
    eventBus?: EventBus,
    storage?: SafeSystemStorageEngine
  ) {
    this.eventBus = eventBus || new EventBus();
    this.storage = storage || new SafeSystemStorageEngine('/vfs/snowball');
    this.setupEventListeners();
  }

  /**
   * تسجيل تفاعل جديد بأسلوب متزامن متوافق مع المحرك الأساسي
   */
  public recordInteraction(
    type: InteractionType,
    source: string,
    payload: Record<string, unknown>,
    customContext?: Partial<InteractionContext>
  ): Result<Interaction, Error> {
    const context = this.enrichContext(customContext || {});

    const interaction: Interaction = {
      id: this.generateId(),
      type,
      timestamp: Date.now(),
      source,
      context,
      payload,
      metadata: {
        sessionId: context.session || this.getSessionId(),
        version: '1.0.0'
      }
    };

    this.inMemoryBuffer.push(interaction);
    if (this.inMemoryBuffer.length > this.maxBufferSize) {
      this.inMemoryBuffer.shift();
    }

    // حفظ في التخزين الدائم في الخلفية
    this.storage.append(this.storageKey, interaction).catch(e => {
      console.warn('[InteractionTracker] Failed to persist interaction:', e);
    });

    // بث الحدث عبر EventBus
    try {
      this.eventBus.emit('snowball:interaction' as any, {
        interaction,
        timestamp: Date.now()
      });
    } catch (_) {}

    return ok(interaction);
  }

  /**
   * تسجيل تفاعل جديد غير متزامن مع توثيق الأخطاء
   */
  public async track(
    type: InteractionType,
    source: string,
    payload: Record<string, unknown>,
    context?: Partial<InteractionContext>
  ): Promise<Result<Interaction, Error>> {
    const res = this.recordInteraction(type, source, payload, context);
    if (!res.isOk) return res;

    const saveResult = await this.storage.append(this.storageKey, res.value);
    if (saveResult.isErr) {
      return err(new Error(`Failed to track interaction: ${saveResult.error.message}`));
    }

    return ok(res.value);
  }

  /**
   * استرجاع السجل من الذاكرة المؤقتة (متزامن)
   */
  public getHistory(limit?: number): Interaction[] {
    if (limit && limit > 0) {
      return this.inMemoryBuffer.slice(-limit);
    }
    return [...this.inMemoryBuffer];
  }

  public getByType(type: InteractionType): Interaction[] {
    return this.inMemoryBuffer.filter(i => i.type === type);
  }

  public count(): number {
    return this.inMemoryBuffer.length;
  }

  /**
   * الحصول على التفاعلات الأخيرة من التخزين الدائم (غير متزامن)
   */
  public async getRecent(limit: number = 100): Promise<Result<Interaction[], Error>> {
    const stored = await this.storage.list<Interaction>(this.storageKey);
    if (stored.isErr) {
      return ok([...this.inMemoryBuffer].reverse().slice(0, limit));
    }

    const merged = [...stored.value, ...this.inMemoryBuffer];
    const uniqueMap = new Map<string, Interaction>();
    for (const item of merged) {
      uniqueMap.set(item.id, item);
    }

    const sorted = Array.from(uniqueMap.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return ok(sorted);
  }

  /**
   * البحث في التفاعلات مع الفلاتر
   */
  public async search(filter: {
    type?: InteractionType;
    since?: number;
    until?: number;
    context?: Partial<InteractionContext>;
  }): Promise<Result<Interaction[], Error>> {
    const recentRes = await this.getRecent(1000);
    if (recentRes.isErr) return recentRes;

    let filtered = recentRes.value;

    if (filter.type) {
      filtered = filtered.filter(i => i.type === filter.type);
    }

    if (filter.since) {
      filtered = filtered.filter(i => i.timestamp >= filter.since!);
    }

    if (filter.until) {
      filtered = filtered.filter(i => i.timestamp <= filter.until!);
    }

    if (filter.context) {
      filtered = filtered.filter(i => this.matchesContext(i.context, filter.context!));
    }

    return ok(filtered.sort((a, b) => b.timestamp - a.timestamp));
  }

  /**
   * إحصائيات التفاعلات
   */
  public async getStats(): Promise<Result<{
    total: number;
    byType: Record<InteractionType, number>;
    lastInteraction: number | null;
  }, Error>> {
    const history = this.inMemoryBuffer;
    const byType = {} as Record<InteractionType, number>;

    for (const item of history) {
      byType[item.type] = (byType[item.type] || 0) + 1;
    }

    return ok({
      total: history.length,
      byType,
      lastInteraction: history.length > 0
        ? Math.max(...history.map(i => i.timestamp))
        : null
    });
  }

  /**
   * تنظيف التفاعلات القديمة
   */
  public async prune(olderThanMs: number): Promise<Result<number, Error>> {
    const cutoff = Date.now() - olderThanMs;
    const initialCount = this.inMemoryBuffer.length;

    this.inMemoryBuffer = this.inMemoryBuffer.filter(i => i.timestamp >= cutoff);
    const pruned = initialCount - this.inMemoryBuffer.length;

    await this.storage.save(this.storageKey, this.inMemoryBuffer);

    return ok(pruned);
  }

  public dispose(): void {
    this.disposables.dispose();
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private setupEventListeners(): void {
    try {
      this.disposables.add(
        this.eventBus.on('editor:fileOpened' as any, (event: any) => {
          this.recordInteraction(
            'file_opened',
            'editor-manager',
            (event.payload || {}) as Record<string, unknown>,
            { language: event.payload?.language }
          );
        }, this.disposables)
      );

      this.disposables.add(
        this.eventBus.on('discovery:found' as any, (event: any) => {
          this.recordInteraction(
            'tool_discovered',
            'system-discovery',
            (event.payload || {}) as Record<string, unknown>
          );
        }, this.disposables)
      );

      this.disposables.add(
        this.eventBus.on('arch:command_executed' as any, (event: any) => {
          this.recordInteraction(
            'command_executed',
            'linux-arch-execution',
            (event.payload || {}) as Record<string, unknown>
          );
        }, this.disposables)
      );
    } catch (_) {}
  }

  private enrichContext(context: Partial<InteractionContext>): InteractionContext {
    const now = new Date();
    return {
      ...context,
      timeOfDay: this.getTimeOfDay(now),
      dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
      session: context.session || this.getSessionId()
    };
  }

  private getTimeOfDay(date: Date): 'morning' | 'afternoon' | 'evening' | 'night' {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  private getSessionId(): string {
    return `session_${Date.now().toString(36)}`;
  }

  private matchesContext(actual: InteractionContext, filter: Partial<InteractionContext>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      if (value === undefined) return true;
      return (actual as any)[key] === value;
    });
  }

  private generateId(): string {
    return `int_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
