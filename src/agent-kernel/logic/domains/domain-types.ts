import { ConstraintRule } from '../../intelligence/constraint-engine';
import { InferenceRule } from '../../intelligence/inference-engine';

export type DomainName = 'code' | 'reasoning' | 'scraping' | string;

export interface DomainProfile {
  name: DomainName;
  description: string;
  defaultConstraints: ConstraintRule[];
  defaultInferenceRules: InferenceRule[];
  allowedTools: string[];
  maxExecutionTimeMs: number;
}

export interface DomainPolicy {
  domain: DomainName;
  version: number;
  compiledAt: number;
  constraints: ConstraintRule[];
  inferenceRules: InferenceRule[];
  toolAllowlist: Set<string>;
}
