import { Result, ok, err } from '../../kernel/core/result';
import { LRUCache } from '../../kernel/core/cache';
import { Pattern, Prediction, InteractionContext } from './types';

export class PredictiveModel {
  private predictionCache: LRUCache<string, Prediction>;
  private activeList: Prediction[] = [];
  private readonly cacheTtl = 300000; // 5 minutes

  constructor() {
    this.predictionCache = new LRUCache<string, Prediction>({
      maxSize: 200,
      defaultTtlMs: this.cacheTtl
    });
  }

  /**
   * توليد تنبؤات غير متزامن بناءً على الأنماط والسياق الحالي
   */
  async predict(
    patterns: Pattern[],
    currentContext: Partial<InteractionContext>
  ): Promise<Result<Prediction[], Error>> {
    const predictions = this.predictSync(patterns, currentContext);

    for (const prediction of predictions) {
      this.predictionCache.set(prediction.id, prediction);
      if (!this.activeList.some(p => p.id === prediction.id)) {
        this.activeList.push(prediction);
      }
    }

    this.pruneExpiredActive();

    return ok(predictions);
  }

  /**
   * توليد تنبؤات متزامن متوافق مع النواة و Engine
   */
  public predictNextAction(
    currentContext: Partial<InteractionContext>,
    patterns: Pattern[]
  ): Prediction[] {
    return this.predictSync(patterns, currentContext);
  }

  /**
   * تقييم دقة تنبؤ سابق
   */
  async evaluatePrediction(predictionId: string, wasAccurate: boolean): Promise<Result<void, Error>> {
    const prediction = this.predictionCache.get(predictionId);
    if (!prediction) {
      return err(new Error(`Prediction not found: ${predictionId}`));
    }

    if (!wasAccurate) {
      this.activeList = this.activeList.filter(p => p.id !== predictionId);
      this.predictionCache.delete(predictionId);
    }

    return ok(undefined);
  }

  /**
   * الحصول على التنبؤات النشطة الصالحة
   */
  getActivePredictions(): Prediction[] {
    this.pruneExpiredActive();
    return [...this.activeList];
  }

  // ─── Private Logic ──────────────────────────────────────────────────

  private predictSync(
    patterns: Pattern[],
    currentContext: Partial<InteractionContext>
  ): Prediction[] {
    const predictions: Prediction[] = [];

    // 1. تنبؤات بناءً على أنماط التسلسل
    predictions.push(...this.predictFromSequences(patterns, currentContext));

    // 2. تنبؤات بناءً على أنماط التفضيل
    predictions.push(...this.predictFromPreferences(patterns, currentContext));

    // 3. تنبؤات بناءً على أنماط التكرار
    predictions.push(...this.predictFromFrequency(patterns, currentContext));

    // تصفية وترتيب حسب الاحتمال (أعلى 5)
    return predictions
      .filter(p => p.probability >= 0.3)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5);
  }

  private predictFromSequences(
    patterns: Pattern[],
    context: Partial<InteractionContext>
  ): Prediction[] {
    const predictions: Prediction[] = [];
    const sequencePatterns = patterns.filter(p => p.type === 'sequence');

    for (const pattern of sequencePatterns) {
      if (this.contextMatches(pattern.context, context)) {
        predictions.push({
          id: `pred_seq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          what: pattern.observation || 'تسلسل أحداث متوقع',
          probability: Number((pattern.confidence * 0.85).toFixed(2)),
          suggestedAction: pattern.action,
          context,
          expiresAt: Date.now() + 300000 // 5 minutes
        });
      }
    }

    return predictions;
  }

  private predictFromPreferences(
    patterns: Pattern[],
    context: Partial<InteractionContext>
  ): Prediction[] {
    const predictions: Prediction[] = [];
    const preferencePatterns = patterns.filter(p => p.type === 'preference');

    for (const pattern of preferencePatterns) {
      if (!context.language || !pattern.context.language || pattern.context.language === context.language) {
        predictions.push({
          id: `pred_pref_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          what: `استخدام الأداة والمحرر المفضل`,
          probability: Number(pattern.confidence.toFixed(2)),
          suggestedAction: pattern.action,
          context,
          expiresAt: Date.now() + 3600000 // 1 hour
        });
      }
    }

    return predictions;
  }

  private predictFromFrequency(
    patterns: Pattern[],
    context: Partial<InteractionContext>
  ): Prediction[] {
    const predictions: Prediction[] = [];
    const frequencyPatterns = patterns.filter(p => p.type === 'frequency');

    for (const pattern of frequencyPatterns) {
      if (this.contextMatches(pattern.context, context)) {
        predictions.push({
          id: `pred_freq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          what: `نشاط متكرر متوقع في هذا الوقت`,
          probability: Number((pattern.confidence * 0.75).toFixed(2)),
          suggestedAction: pattern.action,
          context,
          expiresAt: Date.now() + 600000 // 10 minutes
        });
      }
    }

    return predictions;
  }

  private contextMatches(
    patternContext: Partial<InteractionContext>,
    currentContext: Partial<InteractionContext>
  ): boolean {
    if (!patternContext || Object.keys(patternContext).length === 0) return true;

    return Object.entries(patternContext).every(([key, value]) => {
      if (value === undefined) return true;
      return (currentContext as any)[key] === value;
    });
  }

  private pruneExpiredActive(): void {
    const now = Date.now();
    this.activeList = this.activeList.filter(p => p.expiresAt > now);
  }
}
