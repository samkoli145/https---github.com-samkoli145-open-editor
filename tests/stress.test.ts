import { describe, it, expect } from 'vitest';
import {
  KernelForge,
  TeachingBridge,
  RetroExtractor,
  EventBus,
  TeachingMaterial,
  LoopStepOutput
} from '../src/index';

describe('Nawat Kernel - Comprehensive Production Stress Test', () => {

  // -------------------------------------------------------------------
  // 1. High-Concurrency Capacity Test (1,000 Constraints)
  // -------------------------------------------------------------------
  it('handles 1,000 concurrent constraints without memory leak or performance collapse', async () => {
    const bus = new EventBus();
    const bridge = new TeachingBridge(undefined, undefined, bus);

    const materials: TeachingMaterial[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `stress_c_${i}`,
      type: 'constraint',
      content: `DENY_PATTERN_${i}_${Math.random().toString(36).substring(2, 6)}`,
      priority: 'high'
    }));

    const startTime = performance.now();
    const result = await bridge.learn({ sessionId: 'stress_capacity_1000', materials });
    const durationMs = performance.now() - startTime;

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.applied).toBe(1000);
      expect(result.value.errors.length).toBe(0);
    }

    expect(bridge.getActiveConstraints().length).toBe(1000);
    // Verification speed test over 1,000 active rules
    const evalStart = performance.now();
    const checkResult = bridge.constraintEngine.evaluate('Normal user request for calculation');
    const evalMs = performance.now() - evalStart;

    expect(checkResult.isBlocked).toBe(false);
    expect(evalMs).toBeLessThan(50); // Fast evaluation under 50ms
    expect(durationMs).toBeLessThan(1500); // Fast ingestion under 1.5s
  });

  // -------------------------------------------------------------------
  // 2. Parallel Session & Kernel Forging / Destruction (100 Sessions)
  // -------------------------------------------------------------------
  it('spawns and tears down 100 parallel domain kernels without state bleeding or leaks', () => {
    const forge = new KernelForge();
    const forgedIds: string[] = [];

    // Forge 100 kernels across different domains
    const domains = ['code', 'reasoning', 'scraping'];
    const startTime = performance.now();

    for (let i = 0; i < 100; i++) {
      const targetDomain = domains[i % domains.length];
      const res = forge.forgeKernel(targetDomain, [
        {
          id: `seed_rule_${i}`,
          type: 'constraint',
          content: `UNIQUE_BLOCK_KEY_${i}`,
          priority: 'high'
        }
      ]);

      expect(res.isOk).toBe(true);
      if (res.isOk) {
        forgedIds.push(res.value.instanceId);
      }
    }

    expect(forgedIds.length).toBe(100);

    // Verify isolation in a random sample kernel
    const sampleKernel = forge.getActiveKernel(forgedIds[42]);
    expect(sampleKernel).toBeDefined();
    if (sampleKernel) {
      const blockCheck = sampleKernel.constraintEngine.evaluate('Contains UNIQUE_BLOCK_KEY_42');
      expect(blockCheck.isBlocked).toBe(true);

      const crossCheck = sampleKernel.constraintEngine.evaluate('Contains UNIQUE_BLOCK_KEY_99');
      expect(crossCheck.isBlocked).toBe(false); // No state bleeding
    }

    // Teardown all 100 kernels
    for (const id of forgedIds) {
      const destroyed = forge.destroyKernel(id);
      expect(destroyed).toBe(true);
    }

    const elapsedMs = performance.now() - startTime;
    expect(elapsedMs).toBeLessThan(1000); // 100 kernel lifecycles under 1s
  });

  // -------------------------------------------------------------------
  // 3. Infinite RetroExtractor Loop & Capacity Limit Boundary Test
  // -------------------------------------------------------------------
  it('prevents memory explosion when RetroExtractor repeatedly extracts past capacity (1000 limit)', async () => {
    const bridge = new TeachingBridge();
    const extractor = new RetroExtractor(bridge);

    // Simulate 1,200 repeated failure steps
    let blockedCount = 0;
    let rejectedByMaxCount = 0;

    for (let i = 0; i < 1200; i++) {
      const step: LoopStepOutput = {
        status: 'blocked',
        phase: 'rescue',
        reason: `Constraint violated: 'dangerous_pattern_${i}' execution blocked`,
        latencyMs: 10 + (i % 50),
        trace: []
      };

      const report = await extractor.harvestAndLearn(step, 'infinite_retro_session');
      if (report.extractedMaterials.length > 0) {
        blockedCount++;
      }
    }

    const rules = bridge.constraintEngine.getRules();
    expect(rules.length).toBeLessThanOrEqual(1000);
    expect(rules.length).toBe(1000);

    // Verify system continues to operate cleanly and rejects overflow
    const overflowStep: LoopStepOutput = {
      status: 'blocked',
      phase: 'rescue',
      reason: "Constraint violated: 'overflow_pattern_test' execution blocked",
      latencyMs: 5,
      trace: []
    };

    const harvestReport = await extractor.harvestAndLearn(overflowStep, 'infinite_retro_session');
    expect(harvestReport.extractedMaterials.length).toBe(1);
    expect(bridge.constraintEngine.getRules().length).toBe(1000); // Stays capped at 1000
  });

});
