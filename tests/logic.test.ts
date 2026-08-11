import { describe, it, expect } from 'vitest';
import {
  KernelForge,
  DomainCompiler,
  RetroExtractor,
  ProgramDistiller,
  CODE_DOMAIN_PROFILE,
  REASONING_DOMAIN_PROFILE,
  SCRAPING_DOMAIN_PROFILE,
  TeachingMaterial,
  LoopStepOutput
} from '../src/index';

describe('Logic DNA Layer - Self-Evolution & Domain Kernels', () => {

  // -------------------------------------------------------------------
  // 1. Kernel Forge Factory & Domain Profiles
  // -------------------------------------------------------------------
  describe('KernelForge Factory', () => {
    it('provides built-in domain profiles (code, reasoning, scraping)', () => {
      const forge = new KernelForge();
      const profiles = forge.listProfiles();

      expect(profiles.length).toBeGreaterThanOrEqual(3);
      expect(profiles.some(p => p.name === 'code')).toBe(true);
      expect(profiles.some(p => p.name === 'reasoning')).toBe(true);
      expect(profiles.some(p => p.name === 'scraping')).toBe(true);
    });

    it('forges a specialized Code domain kernel instance', () => {
      const forge = new KernelForge();
      const instanceRes = forge.forgeKernel('code');

      expect(instanceRes.isOk).toBe(true);
      if (instanceRes.isOk) {
        const instance = instanceRes.value;
        expect(instance.domain).toBe('code');

        // Verify default code constraints (e.g. DENY_TOOL:eval)
        const evalCheck = instance.constraintEngine.evaluate('Execute code', { name: 'eval', args: {} });
        expect(evalCheck.isBlocked).toBe(true);
      }
    });

    it('forges a Scraping domain kernel with SSRF prevention rules', () => {
      const forge = new KernelForge();
      const instanceRes = forge.forgeKernel('scraping');

      expect(instanceRes.isOk).toBe(true);
      if (instanceRes.isOk) {
        const instance = instanceRes.value;
        const ssrfCheck = instance.constraintEngine.evaluate('Scrape http://127.0.0.1/admin');
        expect(ssrfCheck.isBlocked).toBe(true);
        expect(ssrfCheck.violatedRule?.reason).toContain('SSRF Prevention');
      }
    });

    it('manages kernel lifecycle with getActiveKernel and destroyKernel teardown', () => {
      const forge = new KernelForge();
      const instanceRes = forge.forgeKernel('code');
      expect(instanceRes.isOk).toBe(true);
      if (instanceRes.isOk) {
        const instance = instanceRes.value;
        const active = forge.getActiveKernel(instance.instanceId);
        expect(active).toBeDefined();

        const destroyed = forge.destroyKernel(instance.instanceId);
        expect(destroyed).toBe(true);
        expect(forge.getActiveKernel(instance.instanceId)).toBeUndefined();
        expect(instance.constraintEngine.getRules().length).toBe(0);
      }
    });

    it('forges domain kernel seeded with raw teaching materials', () => {
      const forge = new KernelForge();
      const seedMaterials: TeachingMaterial[] = [
        {
          id: 'seed_c1',
          type: 'constraint',
          content: 'DENY_TOOL:dangerous_tool',
          priority: 'high'
        }
      ];

      const instanceRes = forge.forgeKernel('code', seedMaterials);
      expect(instanceRes.isOk).toBe(true);
      if (instanceRes.isOk) {
        const instance = instanceRes.value;
        const check = instance.constraintEngine.evaluate('use tool', { name: 'dangerous_tool', args: {} });
        expect(check.isBlocked).toBe(true);
        expect(instance.currentPolicy.version).toBe(2);
      }
    });
  });

  // -------------------------------------------------------------------
  // 2. Domain Compiler
  // -------------------------------------------------------------------
  describe('DomainCompiler', () => {
    it('compiles raw Hermes materials into a structured DomainPolicy', () => {
      const compiler = new DomainCompiler();
      const rawMaterials: TeachingMaterial[] = [
        {
          id: 'mat_c1',
          type: 'constraint',
          content: 'rm -rf',
          priority: 'high'
        },
        {
          id: 'mat_f1',
          type: 'fact',
          content: 'TypeScript produces clean JS',
          priority: 'normal',
          metadata: { actionTool: 'echo' }
        }
      ];

      const policy = compiler.compile('code', rawMaterials, 1);

      expect(policy.domain).toBe('code');
      expect(policy.version).toBe(2);
      expect(policy.constraints.length).toBe(1);
      expect(policy.constraints[0].expression).toBe('rm -rf');
      expect(policy.toolAllowlist.has('echo')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // 3. Retro Extractor (Harvesting Lessons from Traces)
  // -------------------------------------------------------------------
  describe('RetroExtractor', () => {
    it('harvests blocked constraints from step traces into candidate materials', () => {
      const extractor = new RetroExtractor();
      const mockBlockedStep: LoopStepOutput = {
        status: 'blocked',
        phase: 'rescue',
        reason: 'Constraint violated: drop table is forbidden',
        latencyMs: 8,
        trace: ['ALWAYS: Checking active constraints']
      };

      const report = extractor.harvestFromStep(mockBlockedStep);

      expect(report.extractedMaterials.length).toBeGreaterThan(0);
      expect(report.extractedMaterials[0].type).toBe('constraint');
      expect(report.extractedMaterials[0].content).toContain('drop table');
    });

    it('harvests and automatically feeds learned constraints to TeachingBridge', async () => {
      const { TeachingBridge, EventBus } = await import('../src/index');
      const bus = new EventBus();
      const bridge = new TeachingBridge(undefined, undefined, bus);
      const extractor = new RetroExtractor(bridge);

      let eventFired = false;
      bus.on('constraint:learned', () => {
        eventFired = true;
      }, []);

      const mockBlockedStep: LoopStepOutput = {
        status: 'blocked',
        phase: 'rescue',
        reason: 'UNAUTHORIZED_ACCESS',
        latencyMs: 5,
        trace: []
      };

      await extractor.harvestAndLearn(mockBlockedStep);

      expect(bridge.getActiveConstraints()).toContain('UNAUTHORIZED_ACCESS');
      expect(eventFired).toBe(true);

      const check = bridge.constraintEngine.evaluate('User input with UNAUTHORIZED_ACCESS inside');
      expect(check.isBlocked).toBe(true);
    });

    it('extracts precise patterns from blocked step reasons rather than over-broad sentences', () => {
      const extractor = new RetroExtractor();
      const pattern = extractor.extractPatternFromReason("Constraint violated: 'drop table' is forbidden in SQL query");
      expect(pattern).toBe('drop table');

      const mockBlockedStep: LoopStepOutput = {
        status: 'blocked',
        phase: 'rescue',
        reason: "Constraint violated: 'rm -rf' execution blocked",
        latencyMs: 12,
        trace: []
      };

      const report = extractor.harvestFromStep(mockBlockedStep);
      expect(report.extractedMaterials[0].content).toBe('rm -rf');
    });

    it('flags high latency as metric without polluting constraint rules', async () => {
      const { TeachingBridge } = await import('../src/index');
      const bridge = new TeachingBridge();
      const extractor = new RetroExtractor(bridge);

      const mockSlowStep: LoopStepOutput = {
        status: 'success',
        phase: 'output',
        result: 'Slow result',
        latencyMs: 150,
        trace: []
      };

      await extractor.harvestAndLearn(mockSlowStep);

      // Verify it went to metric knowledge store, not constraint engine
      expect(bridge.getKnowledge('metric').length).toBe(1);
      expect(bridge.getKnowledge('metric')[0]).toContain('latency_audit:150ms');

      // Verify legitimate inputs are NOT blocked
      const check = bridge.constraintEngine.evaluate('Normal user query');
      expect(check.isBlocked).toBe(false);
    });

    it('enforces maximum capacity limits in TeachingBridge', async () => {
      const { TeachingBridge } = await import('../src/index');
      const bridge = new TeachingBridge();

      // Attempt to learn 1005 constraints
      const materials: TeachingMaterial[] = Array.from({ length: 1005 }, (_, i) => ({
        id: `c_${i}`,
        type: 'constraint',
        content: `pattern_${i}`,
        priority: 'high'
      }));

      const result = await bridge.learn({ sessionId: 'capacity_test', materials });
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value.applied).toBe(1000);
        expect(result.value.errors.length).toBe(5);
        expect(result.value.errors[0].error).toContain('EMAX');
      }
    });
  });

  // -------------------------------------------------------------------
  // 4. Program Distiller (Macro Tool Recipes)
  // -------------------------------------------------------------------
  describe('ProgramDistiller', () => {
    it('registers and retrieves multi-step tool macro recipes', () => {
      const distiller = new ProgramDistiller();
      const macro = distiller.registerMacro('fetch_and_parse', [
        { toolName: 'echo', argsTemplate: { msg: 'Fetch page' } },
        { toolName: 'calc', argsTemplate: { expr: '100 / 2' } }
      ]);

      expect(macro.name).toBe('fetch_and_parse');
      expect(macro.steps.length).toBe(2);

      const retrieved = distiller.getMacro(macro.id);
      expect(retrieved?.usageCount).toBe(1);
    });
  });
});
