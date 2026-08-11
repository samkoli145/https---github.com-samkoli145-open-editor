import { Result, ok, err } from '../../kernel/core/result';
import { ToolRegistry } from '../tools';
import { TeachingBridge } from './teaching-bridge';
import { DecisionEngine } from '../intelligence/decision-engine';

export interface LoopStepOutput {
  status: 'success' | 'blocked' | 'error';
  phase: 'observe' | 'think' | 'act' | 'output' | 'rescue';
  result?: any;
  reason?: string;
  latencyMs: number;
  trace: string[];
}

export class SymbolicLoop {
  private toolRegistry: ToolRegistry;
  private bridge: TeachingBridge;
  public readonly decisionEngine: DecisionEngine;

  constructor(toolRegistry: ToolRegistry, bridge: TeachingBridge) {
    this.toolRegistry = toolRegistry;
    this.bridge = bridge;
    this.decisionEngine = new DecisionEngine(
      this.bridge.constraintEngine,
      this.bridge.inferenceEngine,
      this.toolRegistry
    );
  }

  public async step(input: string, toolName?: string, toolArgs: any = {}): Promise<Result<LoopStepOutput, Error>> {
    const startTime = Date.now();
    const trace: string[] = [];

    try {
      // 1. OBSERVE & Gather facts
      trace.push('OBSERVE: Gathering system facts & constraints');
      const facts = this.bridge.getKnowledge('fact');
      const constraints = this.bridge.getActiveConstraints();

      // Ensure active constraints from bridge are checked
      for (const c of constraints) {
        if (c && input.includes(c)) {
          return ok({
            status: 'blocked',
            phase: 'rescue',
            reason: `Constraint violated: '${c}' is forbidden in input`,
            latencyMs: Date.now() - startTime,
            trace
          });
        }
      }

      // 2. DECIDE via DecisionEngine
      trace.push('THINK: Evaluating Decision Engine');
      const decisionResult = this.decisionEngine.decide(input, toolName, toolArgs, facts);

      if (decisionResult.decision === 'BLOCKED') {
        const violatedReason = decisionResult.constraintEvaluation?.violatedRule?.reason || 'Constraint violated';
        return ok({
          status: 'blocked',
          phase: 'rescue',
          reason: violatedReason,
          latencyMs: Date.now() - startTime,
          trace
        });
      }

      // 3. ACT
      let actionResult: any = `Processed input: '${input}'`;

      if (decisionResult.decision === 'EXECUTE_TOOL' && decisionResult.toolName) {
        trace.push(`ACT: Executing tool '${decisionResult.toolName}'`);
        const toolRes = await this.toolRegistry.executeTool(decisionResult.toolName, decisionResult.toolArgs || {});
        if (toolRes.isErr) {
          return err(toolRes.error);
        }
        actionResult = toolRes.value;
      } else if (decisionResult.decision === 'RESPOND_FACT') {
        trace.push(`ACT: Returning matched fact`);
        actionResult = decisionResult.factResponse;
      }

      // 4. OUTPUT
      trace.push('OUTPUT: Step complete');
      return ok({
        status: 'success',
        phase: 'output',
        result: actionResult,
        latencyMs: Date.now() - startTime,
        trace
      });
    } catch (e: any) {
      return err(new Error(`EEXEC_LOOP: Step execution error: ${e?.message || String(e)}`));
    }
  }
}
