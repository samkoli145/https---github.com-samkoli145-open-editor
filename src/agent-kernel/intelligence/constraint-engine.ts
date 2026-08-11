import { Result, ok, err } from '../../kernel/core/result';

export type ConstraintSeverity = 'block' | 'warn';

export interface ConstraintRule {
  id: string;
  expression: string; // e.g., 'drop table', 'REGEX:^rm\\s+-rf', 'DENY_TOOL:eval'
  severity: ConstraintSeverity;
  reason: string;
}

export interface ConstraintEvaluationResult {
  isBlocked: boolean;
  violatedRule?: ConstraintRule;
  warnings: string[];
  latencyMs: number;
}

/**
 * High-performance deterministic Constraint Engine.
 * Evaluates inputs, regex patterns, and tool invocations against active rules in <10ms.
 */
export class ConstraintEngine {
  private rules = new Map<string, ConstraintRule>();
  private compiledRegexes = new Map<string, RegExp>();

  public addRule(rule: ConstraintRule): Result<void, Error> {
    if (!rule.id || !rule.expression) {
      return err(new Error('EINVAL: Rule must have valid id and expression'));
    }

    this.rules.set(rule.id, rule);

    if (rule.expression.startsWith('REGEX:')) {
      try {
        const patternStr = rule.expression.substring(6);
        this.compiledRegexes.set(rule.id, new RegExp(patternStr, 'i'));
      } catch (e: any) {
        return err(new Error(`EINVALID_REGEX: Invalid regex pattern in rule '${rule.id}': ${e.message}`));
      }
    }

    return ok(undefined);
  }

  public removeRule(ruleId: string): boolean {
    this.compiledRegexes.delete(ruleId);
    return this.rules.delete(ruleId);
  }

  public getRules(): ConstraintRule[] {
    return Array.from(this.rules.values());
  }

  public evaluate(input: string, toolCall?: { name: string; args: any }): ConstraintEvaluationResult {
    const startTime = Date.now();
    const warnings: string[] = [];

    for (const rule of this.rules.values()) {
      let isMatch = false;

      // 1. Tool Deny rules (e.g. DENY_TOOL:eval)
      if (rule.expression.startsWith('DENY_TOOL:')) {
        const deniedToolName = rule.expression.substring(10).trim();
        if (toolCall && toolCall.name.toLowerCase() === deniedToolName.toLowerCase()) {
          isMatch = true;
        }
      }
      // 2. Compiled Regex rules
      else if (rule.expression.startsWith('REGEX:')) {
        const rx = this.compiledRegexes.get(rule.id);
        if (rx && rx.test(input)) {
          isMatch = true;
        }
      }
      // 3. String literal keyword rules
      else {
        if (input.toLowerCase().includes(rule.expression.toLowerCase())) {
          isMatch = true;
        }
      }

      if (isMatch) {
        if (rule.severity === 'block') {
          return {
            isBlocked: true,
            violatedRule: rule,
            warnings,
            latencyMs: Date.now() - startTime
          };
        } else if (rule.severity === 'warn') {
          warnings.push(`Warning (${rule.id}): ${rule.reason}`);
        }
      }
    }

    return {
      isBlocked: false,
      warnings,
      latencyMs: Date.now() - startTime
    };
  }

  public clear(): void {
    this.rules.clear();
    this.compiledRegexes.clear();
  }
}
