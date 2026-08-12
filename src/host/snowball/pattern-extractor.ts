import { Result, ok } from '../../kernel/core/result';
import { Interaction, Pattern, InteractionContext } from './types';

export class PatternExtractor {
  /**
   * استخراج الأنماط بشكل غير متزامن مع مغلف Result
   */
  public async extractPatternsAsync(interactions: Interaction[]): Promise<Result<Pattern[], Error>> {
    const patterns = this.extractPatterns(interactions);
    return ok(patterns);
  }

  /**
   * استخراج الأنماط من سلسلة التفاعلات (متزامن لتوافق النواة)
   */
  public extractPatterns(interactions: Interaction[]): Pattern[] {
    const patterns: Pattern[] = [];
    if (!interactions || interactions.length === 0) return patterns;

    // 1. أنماط التكرار (Frequency Patterns)
    patterns.push(...this.extractFrequencyPatterns(interactions));

    // 2. أنماط التسلسل (Sequence Patterns)
    patterns.push(...this.extractSequencePatterns(interactions));

    // 3. أنماط الارتباط (Correlation Patterns)
    patterns.push(...this.extractCorrelationPatterns(interactions));

    // 4. أنماط التفضيل (Preference Patterns)
    patterns.push(...this.extractPreferencePatterns(interactions));

    // تصفية الأنماط ذات الثقة المقبولة (>= 0.25)
    return patterns.filter(p => p.confidence >= 0.25);
  }

  /**
   * أنماط التكرار: ماذا يحدث كثيراً وفي أي سياق؟
   */
  private extractFrequencyPatterns(interactions: Interaction[]): Pattern[] {
    const patterns: Pattern[] = [];
    const typeCounts = new Map<string, number>();

    for (const interaction of interactions) {
      const key = `${interaction.type}:${this.getContextKey(interaction.context)}`;
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    }

    const total = interactions.length;
    for (const [key, count] of typeCounts) {
      const frequency = count / total;
      if (count >= 2) {
        const [type, contextKey] = key.split(':');
        const parsedCtx = this.parseContextKey(contextKey);
        patterns.push({
          id: `freq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'frequency',
          observation: `الحدث ${type} تكرر (${count} مرة) في سياق ${contextKey}`,
          action: `تحضير الموارد مسبقاً للحدث ${type}`,
          confidence: Number(Math.min(frequency * 2.5 + 0.2, 0.95).toFixed(2)),
          occurrences: count,
          lastSeen: Date.now(),
          context: parsedCtx
        });
      }
    }

    return patterns;
  }

  /**
   * أنماط التسلسل: ما هي السلسلة الزمنية المتعاقبة؟
   */
  private extractSequencePatterns(interactions: Interaction[]): Pattern[] {
    const patterns: Pattern[] = [];
    if (interactions.length < 2) return patterns;

    const sequences = new Map<string, number>();

    for (let i = 0; i < interactions.length - 1; i++) {
      const current = interactions[i];
      const next = interactions[i + 1];
      const sequenceKey = `${current.type}→${next.type}`;
      sequences.set(sequenceKey, (sequences.get(sequenceKey) || 0) + 1);
    }

    const total = interactions.length - 1;
    for (const [sequence, count] of sequences) {
      const frequency = count / total;
      if (count >= 2 || frequency > 0.1) {
        const [before, after] = sequence.split('→');
        patterns.push({
          id: `seq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'sequence',
          observation: `بعد الحدث ${before}، يليه عادةً الحدث ${after}`,
          action: `عند اكتشاف ${before}، التنبؤ بـ ${after} وتجهيزه`,
          confidence: Number(Math.min(frequency * 3.0 + 0.2, 0.99).toFixed(2)),
          occurrences: count,
          lastSeen: Date.now(),
          context: {}
        });
      }
    }

    return patterns;
  }

  /**
   * أنماط الارتباط: العلاقة بين لغات البرمجة والمحررات
   */
  private extractCorrelationPatterns(interactions: Interaction[]): Pattern[] {
    const patterns: Pattern[] = [];
    const correlations = new Map<string, { count: number; contexts: Set<string> }>();

    for (const interaction of interactions) {
      const language = interaction.context.language;
      const editor = interaction.context.editor;

      if (language && editor) {
        const key = `${language}:${editor}`;
        const existing = correlations.get(key) || { count: 0, contexts: new Set() };
        existing.count++;
        existing.contexts.add(interaction.context.workingDirectory || 'default');
        correlations.set(key, existing);
      }
    }

    for (const [key, data] of correlations) {
      const [language, editor] = key.split(':');
      if (data.count >= 2) {
        patterns.push({
          id: `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'correlation',
          observation: `تطوير لغة ${language} يرتبط قريباً باستخدام ${editor}`,
          action: `عند فتح ملفات ${language}، اقتراح وتفعيل ${editor}`,
          confidence: Number(Math.min(0.5 + data.count * 0.15, 0.98).toFixed(2)),
          occurrences: data.count,
          lastSeen: Date.now(),
          context: { language, editor }
        });
      }
    }

    return patterns;
  }

  /**
   * أنماط التفضيل: أدوات والمحررات المفضلة للمستخدم
   */
  private extractPreferencePatterns(interactions: Interaction[]): Pattern[] {
    const patterns: Pattern[] = [];
    const toolUsage = new Map<string, { count: number; lastUsed: number }>();

    for (const interaction of interactions) {
      const payload = interaction.payload || {};
      const tool = (payload as any).editor || (payload as any).id || (payload as any).toolId;
      if (tool) {
        const existing = toolUsage.get(tool) || { count: 0, lastUsed: 0 };
        existing.count++;
        existing.lastUsed = Math.max(existing.lastUsed, interaction.timestamp);
        toolUsage.set(tool, existing);
      }
    }

    const totalUsage = Array.from(toolUsage.values()).reduce((sum, t) => sum + t.count, 0);

    if (totalUsage > 0) {
      for (const [tool, data] of toolUsage) {
        const usageRatio = data.count / totalUsage;
        if (data.count >= 1) {
          patterns.push({
            id: `pref_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            type: 'preference',
            observation: `المستخدم يفضل الأداة ${tool} بنسبة ${(usageRatio * 100).toFixed(1)}%`,
            action: `تعيين ${tool} كخيار افتراضي في هذه البيئة`,
            confidence: Number(Math.min(usageRatio + 0.3, 0.95).toFixed(2)),
            occurrences: data.count,
            lastSeen: data.lastUsed,
            context: {}
          });
        }
      }
    }

    return patterns;
  }

  // ─── Helper Methods ──────────────────────────────────────────────

  private getContextKey(context: InteractionContext): string {
    return [
      context.language || 'any',
      context.timeOfDay || 'any',
      context.dayOfWeek || 'any'
    ].join('|');
  }

  private parseContextKey(key: string): Partial<InteractionContext> {
    const parts = key.split('|');
    return {
      language: parts[0] !== 'any' ? parts[0] : undefined,
      timeOfDay: parts[1] !== 'any' ? (parts[1] as any) : undefined,
      dayOfWeek: parts[2] !== 'any' ? parts[2] : undefined
    };
  }
}
