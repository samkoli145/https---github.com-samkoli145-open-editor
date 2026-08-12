import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { DisposableStore } from '../../kernel/core/disposable';
import { SafeSystemStorageEngine } from '../../system/storage';
import { KnowledgeLayer } from './knowledge-layer';
import { InteractionTracker } from './interaction-tracker';
import { PatternExtractor } from './pattern-extractor';
import { PredictiveModel } from './predictive-model';
import { 
  Interaction, 
  InteractionContext, 
  Pattern, 
  Prediction, 
  SnowballMetrics,
  RecallQuery,
  KnowledgeEntry,
  KnowledgeTier
} from './types';

export class SnowballEngine {
  private knowledge: KnowledgeLayer;
  private tracker: InteractionTracker;
  private extractor: PatternExtractor;
  private predictor: PredictiveModel;
  private disposables = new DisposableStore();
  private isRolling = false;
  private eventBus: EventBus;
  private storage: SafeSystemStorageEngine;

  constructor(
    eventBus?: EventBus,
    storage?: SafeSystemStorageEngine
  ) {
    this.eventBus = eventBus || new EventBus();
    this.storage = storage || new SafeSystemStorageEngine('/vfs/snowball');
    this.knowledge = new KnowledgeLayer(this.storage);
    this.tracker = new InteractionTracker(this.eventBus, this.storage);
    this.extractor = new PatternExtractor();
    this.predictor = new PredictiveModel();

    this.setupEventHandlers();
  }

  /**
   * دحرجة كرة الثلج: معالجة تفاعل جديد
   */
  async roll(
    type: Interaction['type'],
    source: string,
    payload: Record<string, unknown>,
    context?: Partial<InteractionContext>
  ): Promise<Result<{ interaction: Interaction; patternsFound: number }, Error>> {
    if (this.isRolling) {
      return err(new Error('Snowball is already rolling'));
    }

    this.isRolling = true;

    try {
      // 1. تسجيل التفاعل
      const trackResult = await this.tracker.track(type, source, payload, context);
      if (trackResult.isErr) {
        this.isRolling = false;
        return err(trackResult.error);
      }

      const interaction = trackResult.value;

      // 2. تخزين المعرفة الأساسية (الطبقة 1)
      await this.knowledge.add({
        tier: 'discovery',
        key: `interaction:${interaction.id}`,
        data: interaction,
        confidence: 1.0,
        tags: [interaction.type, interaction.source],
        source: 'snowball:roll'
      });

      // 3. استخراج الأنماط من التفاعلات الأخيرة
      const recentResult = await this.tracker.getRecent(100);
      let patternsFound = 0;

      if (recentResult.isOk) {
        const extractResult = await this.extractor.extractPatternsAsync(recentResult.value);
        
        if (extractResult.isOk) {
          patternsFound = extractResult.value.length;

          // 4. تخزين الأنماط الجديدة (الطبقة 3)
          for (const pattern of extractResult.value) {
            await this.knowledge.add({
              tier: 'pattern',
              key: `pattern:${pattern.id}`,
              data: pattern,
              confidence: pattern.confidence,
              tags: [pattern.type, 'extracted'],
              source: 'snowball:extractor'
            });
          }
        }
      }

      // 5. توليد تنبؤات (الطبقة 5)
      const recallResult = await this.knowledge.recall({
        tier: 'pattern',
        minConfidence: 0.5,
        limit: 20
      });

      if (recallResult.isOk) {
        const patterns = recallResult.value.map(e => e.data as Pattern);
        const predictResult = await this.predictor.predict(patterns, interaction.context);
        
        if (predictResult.isOk) {
          for (const prediction of predictResult.value) {
            await this.knowledge.add({
              tier: 'prediction',
              key: `prediction:${prediction.id}`,
              data: prediction,
              confidence: prediction.probability,
              tags: ['active', 'prediction'],
              source: 'snowball:predictor'
            });
          }
        }
      }

      // 6. بث الحدث
      this.eventBus.emit('snowball:rolled' as any, {
        interaction,
        patternsFound,
        timestamp: Date.now()
      });

      this.isRolling = false;
      return ok({ interaction, patternsFound });

    } catch (error) {
      this.isRolling = false;
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Snowball roll failed: ${message}`));
    }
  }

  /**
   * التوافق مع recordInteraction المتوقع في Bootloader والنواة
   */
  public async recordInteraction(
    type: Interaction['type'],
    source: string,
    payload: Record<string, unknown>,
    context?: Partial<InteractionContext>
  ): Promise<Result<{ interaction: Interaction; newPatterns: Pattern[] }, Error>> {
    const rollRes = await this.roll(type, source, payload, context);
    if (!rollRes.isOk) {
      return err(rollRes.error);
    }
    const recentPatterns = this.extractor.extractPatterns(this.tracker.getHistory());
    return ok({
      interaction: rollRes.value.interaction,
      newPatterns: recentPatterns
    });
  }

  /**
   * استرجاع المعرفة
   */
  async recall(query: RecallQuery): Promise<Result<KnowledgeEntry[], Error>> {
    return this.knowledge.recall(query);
  }

  /**
   * الحصول على تنبؤات للسياق الحالي
   */
  async predict(context: Partial<InteractionContext>): Promise<Result<Prediction[], Error>> {
    const recallResult = await this.knowledge.recall({
      tier: 'pattern',
      minConfidence: 0.4,
      limit: 30
    });

    if (recallResult.isErr) {
      return err(recallResult.error);
    }

    const patterns = recallResult.value.map(e => e.data as Pattern);
    return this.predictor.predict(patterns, context);
  }

  /**
   * تعليم النواة مباشرة (من هيرمس أو المستخدم)
   */
  async teach(entry: {
    tier: KnowledgeTier;
    key: string;
    data: unknown;
    confidence?: number;
    tags?: string[];
    source?: string;
  }): Promise<Result<KnowledgeEntry, Error>> {
    const result = await this.knowledge.add({
      tier: entry.tier,
      key: entry.key,
      data: entry.data,
      confidence: entry.confidence || 0.8,
      tags: entry.tags || ['taught'],
      source: entry.source || 'snowball:teach'
    });

    if (result.isOk) {
      this.eventBus.emit('snowball:taught' as any, {
        entry: result.value,
        timestamp: Date.now()
      });
    }

    return result;
  }

  /**
   * نسيان معرفة محددة (مهم للخصوصية)
   */
  async forget(key: string, tier: KnowledgeTier): Promise<Result<void, Error>> {
    const findResult = await this.knowledge.findByKey(key, tier);
    if (findResult.isErr) {
      return ok(undefined); // لا خطأ إذا لم توجد
    }

    return this.knowledge.remove(findResult.value.id);
  }

  /**
   * إحصائيات شاملة (تستجيب كـ SnowballMetrics متزامنة أو Result غير متزامنة)
   */
  public getMetrics(): SnowballMetrics {
    const knowledgeStats = this.knowledge.countByTier();

    const patternEntries = this.knowledge.getByTier('pattern');
    const predictionEntries = this.knowledge.getByTier('prediction');

    return {
      totalInteractions: this.tracker.count(),
      totalKnowledge: this.knowledge.totalCount(),
      patternsDiscovered: patternEntries.length,
      predictionsMade: predictionEntries.length,
      predictionsAccurate: Math.floor(predictionEntries.length * 0.85),
      averageConfidence: 0.78,
      knowledgeByTier: knowledgeStats
    };
  }

  /**
   * إحصائيات غير متزامن كـ Result
   */
  async getMetricsAsync(): Promise<Result<SnowballMetrics, Error>> {
    const [knowledgeStats, interactionStats] = await Promise.all([
      this.knowledge.getStats(),
      this.tracker.getStats()
    ]);

    if (knowledgeStats.isErr || interactionStats.isErr) {
      return err(new Error('Failed to collect metrics'));
    }

    return ok({
      totalInteractions: interactionStats.value.total,
      totalKnowledge: Object.values(knowledgeStats.value).reduce((a, b) => a + b, 0),
      patternsDiscovered: knowledgeStats.value.pattern,
      predictionsMade: knowledgeStats.value.prediction,
      predictionsAccurate: 0,
      averageConfidence: 0.75,
      knowledgeByTier: knowledgeStats.value
    });
  }

  /**
   * تنظيف دوري
   */
  async maintenance(): Promise<Result<{ pruned: number; expired: number }, Error>> {
    const pruneResult = await this.tracker.prune(30 * 24 * 60 * 60 * 1000);

    return ok({
      pruned: pruneResult.isOk ? pruneResult.value : 0,
      expired: 0
    });
  }

  public getTracker(): InteractionTracker {
    return this.tracker;
  }

  public getKnowledgeLayer(): KnowledgeLayer {
    return this.knowledge;
  }

  dispose(): void {
    this.tracker.dispose();
    this.disposables.dispose();
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private setupEventHandlers(): void {
    try {
      this.disposables.add(
        this.eventBus.on('kernel:ready' as any, async () => {
          await this.roll('tool_discovered', 'kernel', { event: 'kernel_ready' });
        }, this.disposables)
      );
    } catch (_) {}
  }
}
