import { Result, ok, err } from '../../kernel/core/result';
import { DomainName, DomainProfile, DomainPolicy } from './domains/domain-types';
import { CODE_DOMAIN_PROFILE } from './domains/code-domain';
import { REASONING_DOMAIN_PROFILE } from './domains/reasoning-domain';
import { SCRAPING_DOMAIN_PROFILE } from './domains/scraping-domain';
import { ConstraintEngine } from '../intelligence/constraint-engine';
import { InferenceEngine } from '../intelligence/inference-engine';
import { ToolRegistry } from '../tools';
import { DecisionEngine } from '../intelligence/decision-engine';
import { DomainCompiler } from './compiler';
import { TeachingMaterial } from '../hermes/material-schema';

export class DomainKernelInstance {
  public readonly domain: DomainName;
  public readonly profile: DomainProfile;
  public readonly constraintEngine: ConstraintEngine;
  public readonly inferenceEngine: InferenceEngine;
  public readonly toolRegistry: ToolRegistry;
  public readonly decisionEngine: DecisionEngine;
  public currentPolicy: DomainPolicy;

  constructor(profile: DomainProfile, toolRegistry?: ToolRegistry) {
    this.domain = profile.name;
    this.profile = profile;
    this.constraintEngine = new ConstraintEngine();
    this.inferenceEngine = new InferenceEngine();
    this.toolRegistry = toolRegistry || new ToolRegistry();

    // Register profile constraints
    profile.defaultConstraints.forEach(c => this.constraintEngine.addRule(c));
    // Register profile inference rules
    profile.defaultInferenceRules.forEach(r => this.inferenceEngine.addRule(r));

    this.decisionEngine = new DecisionEngine(this.constraintEngine, this.inferenceEngine, this.toolRegistry);

    this.currentPolicy = {
      domain: profile.name,
      version: 1,
      compiledAt: Date.now(),
      constraints: [...profile.defaultConstraints],
      inferenceRules: [...profile.defaultInferenceRules],
      toolAllowlist: new Set(profile.allowedTools)
    };
  }

  public applyCompiledPolicy(policy: DomainPolicy): void {
    policy.constraints.forEach(c => this.constraintEngine.addRule(c));
    policy.inferenceRules.forEach(r => this.inferenceEngine.addRule(r));
    policy.toolAllowlist.forEach(t => this.currentPolicy.toolAllowlist.add(t));
    this.currentPolicy.version = policy.version;
  }

  public teardown(): void {
    this.constraintEngine.clear();
    this.inferenceEngine.clear();
    this.currentPolicy = {
      domain: this.domain,
      version: 0,
      compiledAt: Date.now(),
      constraints: [],
      inferenceRules: [],
      toolAllowlist: new Set()
    };
  }
}

/**
 * Kernel Forge.
 * Dynamic factory for forging domain kernels seeded with specific rules, facts, and tools.
 */
export class KernelForge {
  private profiles = new Map<DomainName, DomainProfile>();
  private activeKernels = new Map<string, DomainKernelInstance>();
  private compiler = new DomainCompiler();

  constructor() {
    this.registerBuiltInProfiles();
  }

  public registerProfile(profile: DomainProfile): void {
    this.profiles.set(profile.name, profile);
  }

  public forgeKernel(domainName: DomainName, seedMaterials: TeachingMaterial[] = []): Result<DomainKernelInstance & { instanceId: string }, Error> {
    const profile = this.profiles.get(domainName);
    if (!profile) {
      return err(new Error(`ENOENT: Domain profile '${domainName}' not found in Kernel Forge`));
    }

    const instance = new DomainKernelInstance(profile);

    if (seedMaterials.length > 0) {
      const compiledPolicy = this.compiler.compile(domainName, seedMaterials, instance.currentPolicy.version);
      instance.applyCompiledPolicy(compiledPolicy);
    }

    const instanceId = `${domainName}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const resultInstance = Object.assign(instance, { instanceId });
    this.activeKernels.set(instanceId, resultInstance);

    return ok(resultInstance);
  }

  public getActiveKernel(instanceId: string): DomainKernelInstance | undefined {
    return this.activeKernels.get(instanceId);
  }

  public destroyKernel(instanceId: string): boolean {
    const instance = this.activeKernels.get(instanceId);
    if (instance) {
      instance.teardown();
      this.activeKernels.delete(instanceId);
      return true;
    }
    return false;
  }

  public listProfiles(): DomainProfile[] {
    return Array.from(this.profiles.values());
  }

  private registerBuiltInProfiles(): void {
    this.registerProfile(CODE_DOMAIN_PROFILE);
    this.registerProfile(REASONING_DOMAIN_PROFILE);
    this.registerProfile(SCRAPING_DOMAIN_PROFILE);
  }
}
