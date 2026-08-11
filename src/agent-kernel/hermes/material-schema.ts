export type MaterialType = 'rule' | 'constraint' | 'fact' | 'example' | 'skill' | 'metric';

export interface TeachingMaterial {
  id: string;          // معرف فريد لضمان الإديمبوتنسي
  type: MaterialType;  // نوع المادة (تحكم في كيفية معالجتها)
  targetPersona?: string; // من المستهدف؟ (مثال: 'code-assistant')
  content: string;     // المحتوى التصريحي (YAML/JSON/Text)
  priority: 'low' | 'normal' | 'high';
  metadata?: Record<string, any>;
}

export interface TeachingRequest {
  sessionId: string;   // عزل التعلم حسب الجلسة (نمط Jupyter)
  materials: TeachingMaterial[];
  forceOverwrite?: boolean; // لكسر الإديمبوتنسي عند الضرورة
}

export interface LearningReportError {
  id: string;
  error: string;
}

export interface LearningReport {
  applied: number;
  skipped: number;
  errors: LearningReportError[];
}
