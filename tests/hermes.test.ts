import { describe, it, expect } from 'vitest';
import {
  HermesKernel,
  TeachingBridge,
  SymbolicLoop,
  PersonaRegistry,
  HermesAdapter,
  TeachingRequest,
  ToolRegistry
} from '../src/index';

describe('Hermes Layer - Idempotent Learning Loop & Symbolic Engine', () => {

  // -------------------------------------------------------------------
  // 1. Material Schema & Idempotent Teaching Bridge
  // -------------------------------------------------------------------
  describe('TeachingBridge Idempotency & Material Routing', () => {
    it('applies new materials and skips duplicate material IDs (Idempotency)', async () => {
      const bridge = new TeachingBridge();

      const req: TeachingRequest = {
        sessionId: 'sess_teach_1',
        materials: [
          {
            id: 'mat_rule_1',
            type: 'constraint',
            content: 'eval() is forbidden',
            priority: 'high'
          },
          {
            id: 'mat_fact_1',
            type: 'fact',
            content: 'Nawat Kernel runs on Cloud Run',
            priority: 'normal'
          }
        ]
      };

      // First run -> apply 2
      const res1 = await bridge.learn(req);
      expect(res1.isOk).toBe(true);
      if (res1.isOk) {
        expect(res1.value.applied).toBe(2);
        expect(res1.value.skipped).toBe(0);
      }

      // Second run with same request -> skip 2 (Ansible "ok" idempotency)
      const res2 = await bridge.learn(req);
      expect(res2.isOk).toBe(true);
      if (res2.isOk) {
        expect(res2.value.applied).toBe(0);
        expect(res2.value.skipped).toBe(2);
      }
    });

    it('forces overwrite when forceOverwrite flag is true', async () => {
      const bridge = new TeachingBridge();

      const req: TeachingRequest = {
        sessionId: 'sess_force',
        materials: [
          { id: 'm1', type: 'rule', content: 'No global mutable state', priority: 'high' }
        ]
      };

      await bridge.learn(req);

      const forceReq: TeachingRequest = {
        ...req,
        forceOverwrite: true
      };

      const res = await bridge.learn(forceReq);
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value.applied).toBe(1);
        expect(res.value.skipped).toBe(0);
      }
    });

    it('exports and imports learned state seamlessly', async () => {
      const bridge1 = new TeachingBridge();
      await bridge1.learn({
        sessionId: 's1',
        materials: [
          { id: 'mat_k1', type: 'skill', content: 'typescript-transpilation', priority: 'normal' }
        ]
      });

      const exported = bridge1.exportState();
      expect(exported.learnedIds).toContain('mat_k1');

      const bridge2 = new TeachingBridge();
      const importRes = bridge2.importState(exported);
      expect(importRes.isOk).toBe(true);
      expect(bridge2.isLearned('mat_k1')).toBe(true);
      expect(bridge2.getKnowledge('skill')).toContain('typescript-transpilation');
    });
  });

  // -------------------------------------------------------------------
  // 2. Symbolic Loop & Constraint Checking ("النواهي قبل الأوامر")
  // -------------------------------------------------------------------
  describe('SymbolicLoop (Observe-Think-Decide-Act-Output)', () => {
    it('executes symbolic step without continuous LLM', async () => {
      const tools = new ToolRegistry();
      const bridge = new TeachingBridge();
      const loop = new SymbolicLoop(tools, bridge);

      const stepRes = await loop.step('Calculate numbers', 'calc', { expr: '15 * 4' });
      expect(stepRes.isOk).toBe(true);
      if (stepRes.isOk) {
        expect(stepRes.value.status).toBe('success');
        expect(stepRes.value.result).toBe(60);
        expect(stepRes.value.latencyMs).toBeGreaterThanOrEqual(0);
        expect(stepRes.value.trace.length).toBeGreaterThan(0);
      }
    });

    it('blocks execution when input violates active constraint ("النواهي قبل الأوامر")', async () => {
      const tools = new ToolRegistry();
      const bridge = new TeachingBridge();

      // Learn forbidden constraint
      await bridge.learn({
        sessionId: 's_block',
        materials: [
          { id: 'c_forbidden', type: 'constraint', content: 'drop table', priority: 'high' }
        ]
      });

      const loop = new SymbolicLoop(tools, bridge);
      const stepRes = await loop.step('Please drop table users;');

      expect(stepRes.isOk).toBe(true);
      if (stepRes.isOk) {
        expect(stepRes.value.status).toBe('blocked');
        expect(stepRes.value.reason).toContain('Constraint violated');
      }
    });
  });

  // -------------------------------------------------------------------
  // 3. Persona System & Role Registry
  // -------------------------------------------------------------------
  describe('Persona System', () => {
    it('provides built-in personas (code-assistant, teacher, analyst)', () => {
      const registry = new PersonaRegistry();
      const personas = registry.listPersonas();

      expect(personas.length).toBeGreaterThanOrEqual(3);
      expect(registry.getPersona('code-assistant')?.role).toBe('developer');
      expect(registry.getPersona('teacher')?.role).toBe('educator');
      expect(registry.getPersona('analyst')?.role).toBe('analyst');
    });

    it('registers custom persona successfully', () => {
      const registry = new PersonaRegistry();
      const regRes = registry.registerPersona({
        id: 'security-auditor',
        name: 'Security Auditor',
        role: 'security',
        systemPrompt: 'Audit code for vulnerability and OWASP top 10',
        defaultRules: ['Check inputs', 'Enforce auth'],
        allowedTools: ['now']
      });

      expect(regRes.isOk).toBe(true);
      expect(registry.getPersona('security-auditor')?.name).toBe('Security Auditor');
    });
  });

  // -------------------------------------------------------------------
  // 4. Hermes Adapter (OpenAI Function Calling & Wire Format)
  // -------------------------------------------------------------------
  describe('Hermes Adapter Format', () => {
    it('formats OpenAI chat completion payload', () => {
      const formatted = HermesAdapter.formatOpenAIResponse('llama3.2', 'Hello from Hermes', 'stop');

      expect(formatted.object).toBe('chat.completion');
      expect(formatted.model).toBe('llama3.2');
      expect(formatted.choices[0].message.content).toBe('Hello from Hermes');
      expect(formatted.choices[0].finish_reason).toBe('stop');
    });
  });

  // -------------------------------------------------------------------
  // 5. HermesKernel Integration Flow (Learn -> Save -> Load -> Serve)
  // -------------------------------------------------------------------
  describe('HermesKernel E2E Lifecycle', () => {
    it('completes learn, serve, save, and load cycle across VFS/Storage', async () => {
      const kernel = new HermesKernel();

      // 1. Learn material
      const learnRes = await kernel.learn({
        sessionId: 'hermes_e2e',
        materials: [
          { id: 'm_e2e_1', type: 'rule', content: 'rm -rf', priority: 'high' },
          { id: 'm_e2e_2', type: 'fact', content: 'Hermes operates hermetically', priority: 'normal' }
        ]
      });
      expect(learnRes.isOk).toBe(true);

      // 2. Serve query
      const serveRes = await kernel.serve('Hello Hermes', 'echo', { message: 'Echo message' });
      expect(serveRes.isOk).toBe(true);
      if (serveRes.isOk) {
        expect(serveRes.value.result).toBe('Echo message');
      }

      // 3. Save checkpoint
      const saveRes = await kernel.save('hermes_e2e');
      expect(saveRes.isOk).toBe(true);

      // 4. Load into fresh kernel sharing same storage engine
      const freshKernel = new HermesKernel(undefined, kernel.storage);
      const loadRes = await freshKernel.load('hermes_e2e');
      expect(loadRes.isOk).toBe(true);

      // Verify loaded constraints block forbidden input
      const freshServeRes = await freshKernel.serve('rm -rf /app');
      expect(freshServeRes.isOk).toBe(true);
      if (freshServeRes.isOk) {
        expect(freshServeRes.value.status).toBe('blocked');
      }
    });
  });
});
