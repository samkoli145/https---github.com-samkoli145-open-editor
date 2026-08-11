import { ConstraintEngine, ConstraintEvaluationResult } from './constraint-engine';
import { InferenceEngine, InferenceDeduction } from './inference-engine';
import { ToolRegistry } from '../tools';

export type DecisionType = 'BLOCKED' | 'EXECUTE_TOOL' | 'RESPOND_FACT' | 'FALLBACK_LLM';

export interface DecisionResult {
  decision: DecisionType;
  toolName?: string;
  toolArgs?: any;
  factResponse?: string;
  constraintEvaluation?: ConstraintEvaluationResult;
  deductions?: InferenceDeduction[];
  latencyMs: number;
}

/**
 * Unified Decision Engine coordinating Constraint evaluation and Symbolic Inference.
 */
export class DecisionEngine {
  public readonly constraintEngine: ConstraintEngine;
  public readonly inferenceEngine: InferenceEngine;
  public readonly toolRegistry: ToolRegistry;

  constructor(constraintEngine: ConstraintEngine, inferenceEngine: InferenceEngine, toolRegistry: ToolRegistry) {
    this.constraintEngine = constraintEngine;
    this.inferenceEngine = inferenceEngine;
    this.toolRegistry = toolRegistry;
  }

  public decide(input: string, requestedToolName?: string, requestedToolArgs: any = {}, facts: string[] = []): DecisionResult {
    const startTime = Date.now();

    // 1. Evaluate Constraints first ("النواهي قبل الأوامر")
    const constraintEval = this.constraintEngine.evaluate(
      input,
      requestedToolName ? { name: requestedToolName, args: requestedToolArgs } : undefined
    );

    if (constraintEval.isBlocked) {
      return {
        decision: 'BLOCKED',
        constraintEvaluation: constraintEval,
        latencyMs: Date.now() - startTime
      };
    }

    // 2. Explicit tool invocation
    if (requestedToolName && this.toolRegistry.hasTool(requestedToolName)) {
      return {
        decision: 'EXECUTE_TOOL',
        toolName: requestedToolName,
        toolArgs: requestedToolArgs,
        constraintEvaluation: constraintEval,
        latencyMs: Date.now() - startTime
      };
    }

    // 3. Symbolic Inference
    const deductions = this.inferenceEngine.infer(input, facts);
    const topDeduction = deductions.find(d => d.actionTool && this.toolRegistry.hasTool(d.actionTool));

    if (topDeduction && topDeduction.actionTool) {
      return {
        decision: 'EXECUTE_TOOL',
        toolName: topDeduction.actionTool,
        toolArgs: { input },
        deductions,
        constraintEvaluation: constraintEval,
        latencyMs: Date.now() - startTime
      };
    }

    if (deductions.length > 0) {
      return {
        decision: 'RESPOND_FACT',
        factResponse: deductions[0].deduction,
        deductions,
        constraintEvaluation: constraintEval,
        latencyMs: Date.now() - startTime
      };
    }

    // 4. Default Fallback
    return {
      decision: 'FALLBACK_LLM',
      constraintEvaluation: constraintEval,
      latencyMs: Date.now() - startTime
    };
  }
}
