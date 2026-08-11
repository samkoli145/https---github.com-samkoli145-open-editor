import { DomainProfile } from './domain-types';

export const REASONING_DOMAIN_PROFILE: DomainProfile = {
  name: 'reasoning',
  description: 'Specialized domain kernel for deductive reasoning, formal logic, and symbolic evaluation.',
  defaultConstraints: [
    {
      id: 'reasoning_fact_check',
      expression: 'REGEX:^contradiction:',
      severity: 'block',
      reason: 'Contradictory logical premises detected'
    }
  ],
  defaultInferenceRules: [
    {
      id: 'reasoning_deduce_truth',
      ifPattern: 'prove',
      thenDeduction: 'Apply resolution principle and verify logical premises',
      actionTool: 'echo'
    }
  ],
  allowedTools: ['calc', 'echo', 'now'],
  maxExecutionTimeMs: 10000
};
