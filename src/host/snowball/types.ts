export type KnowledgeTier = 
  | 'discovery'      // الطبقة 1: وجود الأدوات
  | 'capability'     // الطبقة 2: قدرات الأدوات
  | 'pattern'        // الطبقة 3: أنماط الاستخدام
  | 'context'        // الطبقة 4: فهم السياق
  | 'prediction';    // الطبقة 5: التنبؤ الذكي

export type InteractionType = 
  | 'tool_discovered'
  | 'file_opened'
  | 'command_executed'
  | 'browser_launched'
  | 'server_started'
  | 'error_occurred'
  | 'user_preference';

export interface Interaction {
  readonly id: string;
  readonly type: InteractionType;
  readonly timestamp: number;
  readonly source: string;           // المصدر: 'editor-manager', 'cli', etc.
  readonly context: InteractionContext;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, string>;
}

export interface InteractionContext {
  readonly workingDirectory?: string;
  readonly project?: string;
  readonly language?: string;
  readonly editor?: string;
  readonly timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  readonly dayOfWeek?: string;
  readonly session?: string;
}

export interface KnowledgeEntry {
  readonly id: string;
  readonly tier: KnowledgeTier;
  readonly key: string;              // مفتاح فريد للاسترجاع
  readonly data: unknown;            // البيانات الفعلية
  readonly confidence: number;       // 0.0 - 1.0
  readonly accessCount: number;
  readonly lastAccessed: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tags: string[];
  readonly source: string;           // من أين جاءت هذه المعرفة
}

export interface Pattern {
  readonly id: string;
  readonly type: 'sequence' | 'frequency' | 'correlation' | 'preference';
  readonly observation: string;
  readonly action: string;
  readonly confidence: number;
  readonly occurrences: number;
  readonly lastSeen: number;
  readonly context: Partial<InteractionContext>;
}

export interface Prediction {
  readonly id: string;
  readonly what: string;             // ماذا نتنبأ
  readonly probability: number;      // احتمال الحدوث
  readonly suggestedAction: string;  // الإجراء المقترح
  readonly context: Partial<InteractionContext>;
  readonly expiresAt: number;        // متى تنتهي صلاحية التنبؤ
}

export interface RecallQuery {
  readonly tier?: KnowledgeTier;
  readonly tags?: string[];
  readonly context?: Partial<InteractionContext>;
  readonly minConfidence?: number;
  readonly limit?: number;
  readonly orderBy?: 'confidence' | 'recency' | 'accessCount';
}

export interface SnowballMetrics {
  readonly totalInteractions: number;
  readonly totalKnowledge: number;
  readonly patternsDiscovered: number;
  readonly predictionsMade: number;
  readonly predictionsAccurate: number;
  readonly averageConfidence: number;
  readonly knowledgeByTier: Record<KnowledgeTier, number>;
}
