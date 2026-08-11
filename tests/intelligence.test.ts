import { describe, it, expect } from 'vitest';
import {
  ConstraintEngine,
  ContextModel,
  InferenceEngine,
  DecisionEngine,
  ToolRegistry,
  TeachingBridge,
  SymbolicLoop
} from '../src/index';

describe('Intelligence & Constraints Layer - Symbolic Brain & Deterministic Rules', () => {

  // -------------------------------------------------------------------
  // 1. Constraint Engine (High Performance, Regex, & Tool Deny)
  // -------------------------------------------------------------------
  describe('ConstraintEngine', () => {
    it('evaluates string literal, REGEX, and DENY_TOOL rules under 10ms', () => {
      const engine = new ConstraintEngine();

      engine.addRule({
        id: 'r_literal',
        expression: 'drop table',
        severity: 'block',
        reason: 'SQL drop table is strictly forbidden'
      });

      engine.addRule({
        id: 'r_regex',
        expression: 'REGEX:^rm\\s+-rf',
        severity: 'block',
        reason: 'Recursive deletion command is forbidden'
      });

      engine.addRule({
        id: 'r_tool_deny',
        expression: 'DENY_TOOL:eval',
        severity: 'block',
        reason: 'eval tool execution is disabled'
      });

      // Literal match test
      const res1 = engine.evaluate('Please drop table users');
      expect(res1.isBlocked).toBe(true);
      expect(res1.violatedRule?.id).toBe('r_literal');
      expect(res1.latencyMs).toBeLessThan(10);

      // Regex match test
      const res2 = engine.evaluate('rm -rf /app');
      expect(res2.isBlocked).toBe(true);
      expect(res2.violatedRule?.id).toBe('r_regex');

      // Tool deny match test
      const res3 = engine.evaluate('Execute command', { name: 'eval', args: {} });
      expect(res3.isBlocked).toBe(true);
      expect(res3.violatedRule?.id).toBe('r_tool_deny');

      // Clean input test
      const res4 = engine.evaluate('Hello world', { name: 'calc', args: { expr: '1+1' } });
      expect(res4.isBlocked).toBe(false);
    });

    it('collects warning severities without blocking execution', () => {
      const engine = new ConstraintEngine();
      engine.addRule({
        id: 'r_warn',
        expression: 'deprecated',
        severity: 'warn',
        reason: 'Usage of deprecated syntax'
      });

      const res = engine.evaluate('This uses deprecated features');
      expect(res.isBlocked).toBe(false);
      expect(res.warnings.length).toBe(1);
      expect(res.warnings[0]).toContain('Usage of deprecated syntax');
    });
  });

  // -------------------------------------------------------------------
  // 2. Context Model & Window Pruning
  // -------------------------------------------------------------------
  describe('ContextModel', () => {
    it('appends messages and prunes oldest user messages when bounds exceeded', () => {
      const model = new ContextModel({ maxMessages: 3, maxEstimatedTokens: 500 });

      model.append('system', 'System prompt');
      model.append('user', 'Message 1');
      model.append('assistant', 'Reply 1');
      model.append('user', 'Message 2');

      const messages = model.getMessages();
      expect(messages.length).toBe(3);
      // System message preserved, Message 1 pruned
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].role).toBe('user');
    });
  });

  // -------------------------------------------------------------------
  // 3. Symbolic Inference Engine
  // -------------------------------------------------------------------
  describe('InferenceEngine', () => {
    it('infers logical deductions and tool associations deterministically', () => {
      const engine = new InferenceEngine();

      engine.addRule({
        id: 'inf_calc',
        ifPattern: 'calculate',
        thenDeduction: 'Perform mathematical computation',
        actionTool: 'calc'
      });

      const deductions = engine.infer('Please calculate total revenue', ['Nawat runs on Cloud Run']);

      expect(deductions.length).toBeGreaterThan(0);
      expect(deductions[0].matchedRuleId).toBe('inf_calc');
      expect(deductions[0].actionTool).toBe('calc');
    });
  });

  // -------------------------------------------------------------------
  // 4. Unified Decision Engine
  // -------------------------------------------------------------------
  describe('DecisionEngine Matrix', () => {
    it('returns BLOCKED when constraint is violated', () => {
      const constraintEngine = new ConstraintEngine();
      const inferenceEngine = new InferenceEngine();
      const toolRegistry = new ToolRegistry();

      constraintEngine.addRule({
        id: 'block_sql',
        expression: 'DELETE FROM',
        severity: 'block',
        reason: 'SQL deletion disabled'
      });

      const decisionEngine = new DecisionEngine(constraintEngine, inferenceEngine, toolRegistry);
      const res = decisionEngine.decide('DELETE FROM logs;');

      expect(res.decision).toBe('BLOCKED');
      expect(res.latencyMs).toBeLessThan(10);
    });

    it('returns EXECUTE_TOOL when explicit tool or inferred tool matches', () => {
      const constraintEngine = new ConstraintEngine();
      const inferenceEngine = new InferenceEngine();
      const toolRegistry = new ToolRegistry();

      const decisionEngine = new DecisionEngine(constraintEngine, inferenceEngine, toolRegistry);
      const res = decisionEngine.decide('Calculate expr', 'calc', { expr: '10 + 20' });

      expect(res.decision).toBe('EXECUTE_TOOL');
      expect(res.toolName).toBe('calc');
    });

    it('returns RESPOND_FACT when input matches learned facts', () => {
      const constraintEngine = new ConstraintEngine();
      const inferenceEngine = new InferenceEngine();
      const toolRegistry = new ToolRegistry();

      const decisionEngine = new DecisionEngine(constraintEngine, inferenceEngine, toolRegistry);
      const res = decisionEngine.decide('Cloud Run', undefined, {}, ['Nawat runs on Cloud Run']);

      expect(res.decision).toBe('RESPOND_FACT');
      expect(res.factResponse).toBe('Nawat runs on Cloud Run');
    });
  });

  // -------------------------------------------------------------------
  // 5. SymbolicLoop End-to-End Intelligence Integration
  // -------------------------------------------------------------------
  describe('SymbolicLoop Intelligence Integration', () => {
    it('evaluates taught constraints via Decision Engine seamlessly', async () => {
      const toolRegistry = new ToolRegistry();
      const bridge = new TeachingBridge();

      await bridge.learn({
        sessionId: 's_intel_1',
        materials: [
          { id: 'c_regex_1', type: 'constraint', content: 'REGEX:^sudo\\s+', priority: 'high' }
        ]
      });

      const loop = new SymbolicLoop(toolRegistry, bridge);
      const stepRes = await loop.step('sudo systemctl restart');

      expect(stepRes.isOk).toBe(true);
      if (stepRes.isOk) {
        expect(stepRes.value.status).toBe('blocked');
      }
    });
  });
});
