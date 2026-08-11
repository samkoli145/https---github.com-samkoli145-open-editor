import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { TeachingRequest, TeachingMaterial, LearningReport } from './material-schema';
import { ConstraintEngine } from '../intelligence/constraint-engine';
import { InferenceEngine } from '../intelligence/inference-engine';

export class TeachingBridge {
  private learnedIds = new Set<string>();
  private materialsMap = new Map<string, TeachingMaterial>();
  private activeConstraints = new Set<string>();
  private knowledgeStore = new Map<string, string[]>();

  public readonly constraintEngine: ConstraintEngine;
  public readonly inferenceEngine: InferenceEngine;
  public readonly eventBus?: EventBus;

  private readonly maxConstraints = 1000;
  private readonly maxKnowledgePerType = 500;

  constructor(constraintEngine?: ConstraintEngine, inferenceEngine?: InferenceEngine, eventBus?: EventBus) {
    this.constraintEngine = constraintEngine || new ConstraintEngine();
    this.inferenceEngine = inferenceEngine || new InferenceEngine();
    this.eventBus = eventBus;
  }

  public async learn(request: TeachingRequest): Promise<Result<LearningReport, Error>> {
    if (!request || !Array.isArray(request.materials)) {
      return err(new Error('EINVAL: Invalid teaching request format'));
    }

    const report: LearningReport = {
      applied: 0,
      skipped: 0,
      errors: []
    };

    for (const material of request.materials) {
      if (!material.id) {
        report.errors.push({ id: 'unknown', error: 'Missing material ID' });
        continue;
      }

      // Idempotency check: skip if previously learned unless forceOverwrite is enabled
      if (this.learnedIds.has(material.id) && !request.forceOverwrite) {
        report.skipped++;
        continue;
      }

      try {
        if (material.type === 'constraint' || material.type === 'rule') {
          const currentCount = this.constraintEngine.getRules().length;
          if (currentCount >= this.maxConstraints) {
            report.errors.push({ id: material.id, error: 'EMAX: Maximum constraint capacity reached' });
            continue;
          }

          this.activeConstraints.add(material.content);
          this.constraintEngine.addRule({
            id: material.id,
            expression: material.content,
            severity: 'block',
            reason: `Rule/Constraint ${material.id}: ${material.content}`
          });
          if (this.eventBus) {
            this.eventBus.emit('constraint:learned', { id: material.id, content: material.content, sessionId: request.sessionId });
          }
        } else if (material.type === 'fact' || material.type === 'skill') {
          const category = material.type;
          const existing = this.knowledgeStore.get(category) || [];
          if (existing.length >= this.maxKnowledgePerType) {
            report.errors.push({ id: material.id, error: `EMAX: Maximum knowledge capacity reached for category '${category}'` });
            continue;
          }
          existing.push(material.content);
          this.knowledgeStore.set(category, existing);

          this.inferenceEngine.addRule({
            id: material.id,
            ifPattern: material.content,
            thenDeduction: material.content,
            actionTool: material.metadata?.actionTool
          });
          if (this.eventBus) {
            this.eventBus.emit('fact:learned', { id: material.id, content: material.content, sessionId: request.sessionId });
          }
        } else {
          const category = material.type;
          const existing = this.knowledgeStore.get(category) || [];
          if (existing.length >= this.maxKnowledgePerType) {
            report.errors.push({ id: material.id, error: `EMAX: Maximum capacity reached for category '${category}'` });
            continue;
          }
          existing.push(material.content);
          this.knowledgeStore.set(category, existing);
        }

        this.learnedIds.add(material.id);
        this.materialsMap.set(material.id, material);
        report.applied++;
      } catch (e: any) {
        report.errors.push({ id: material.id, error: e?.message || String(e) });
      }
    }

    return ok(report);
  }

  public isLearned(id: string): boolean {
    return this.learnedIds.has(id);
  }

  public getActiveConstraints(): string[] {
    const engineExpressions = this.constraintEngine.getRules().map(r => r.expression);
    const set = new Set([...this.activeConstraints, ...engineExpressions]);
    return Array.from(set);
  }

  public getKnowledge(type: string): string[] {
    return this.knowledgeStore.get(type) || [];
  }

  public exportState(): Record<string, any> {
    return {
      learnedIds: Array.from(this.learnedIds),
      materials: Array.from(this.materialsMap.values()),
      constraints: Array.from(this.activeConstraints),
      knowledge: Object.fromEntries(
        Array.from(this.knowledgeStore.entries()).map(([k, v]) => [k, [...v]])
      )
    };
  }

  public importState(state: Record<string, any>): Result<number, Error> {
    if (!state || typeof state !== 'object') {
      return err(new Error('EINVAL: Invalid state object for import'));
    }

    let count = 0;
    if (Array.isArray(state.learnedIds)) {
      state.learnedIds.forEach((id: string) => this.learnedIds.add(String(id)));
    }

    if (Array.isArray(state.materials)) {
      state.materials.forEach((m: TeachingMaterial) => {
        if (m && m.id) {
          this.materialsMap.set(m.id, m);
          count++;
        }
      });
    }

    if (Array.isArray(state.constraints)) {
      state.constraints.forEach((c: string, idx: number) => {
        this.activeConstraints.add(String(c));
        this.constraintEngine.addRule({
          id: `imp_c_${idx}`,
          expression: String(c),
          severity: 'block',
          reason: `Imported constraint: ${c}`
        });
      });
    }

    if (state.knowledge && typeof state.knowledge === 'object') {
      for (const [k, v] of Object.entries(state.knowledge)) {
        if (Array.isArray(v)) {
          this.knowledgeStore.set(k, v.map(String));
        }
      }
    }

    return ok(count);
  }

  public clear(): void {
    this.learnedIds.clear();
    this.materialsMap.clear();
    this.activeConstraints.clear();
    this.knowledgeStore.clear();
  }
}
