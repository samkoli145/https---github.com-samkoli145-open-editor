export interface InferenceRule {
  id: string;
  ifPattern: string; // Regex or substring
  thenDeduction: string;
  actionTool?: string;
}

export interface InferenceDeduction {
  matchedRuleId: string;
  deduction: string;
  actionTool?: string;
  confidence: number;
}

/**
 * Symbolic Inference Engine.
 * Infers logical deductions and tool selections deterministically based on facts and rules.
 */
export class InferenceEngine {
  private rules = new Map<string, InferenceRule>();

  public addRule(rule: InferenceRule): void {
    this.rules.set(rule.id, rule);
  }

  public removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  public infer(input: string, facts: string[] = []): InferenceDeduction[] {
    const deductions: InferenceDeduction[] = [];

    // 1. Check direct IF-THEN inference rules
    for (const rule of this.rules.values()) {
      let matched = false;
      if (rule.ifPattern.startsWith('REGEX:')) {
        const rx = new RegExp(rule.ifPattern.substring(6), 'i');
        matched = rx.test(input);
      } else {
        matched = input.toLowerCase().includes(rule.ifPattern.toLowerCase());
      }

      if (matched) {
        deductions.push({
          matchedRuleId: rule.id,
          deduction: rule.thenDeduction,
          actionTool: rule.actionTool,
          confidence: 1.0
        });
      }
    }

    // 2. Fact-based deduction matching
    for (const fact of facts) {
      if (fact.toLowerCase().includes(input.toLowerCase()) || input.toLowerCase().includes(fact.toLowerCase())) {
        deductions.push({
          matchedRuleId: 'fact_match',
          deduction: fact,
          confidence: 0.9
        });
      }
    }

    return deductions;
  }

  public clear(): void {
    this.rules.clear();
  }
}
