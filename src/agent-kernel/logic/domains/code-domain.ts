import { DomainProfile } from './domain-types';

export const CODE_DOMAIN_PROFILE: DomainProfile = {
  name: 'code',
  description: 'Specialized domain kernel for software engineering, code syntax, and type safety.',
  defaultConstraints: [
    {
      id: 'code_no_eval',
      expression: 'DENY_TOOL:eval',
      severity: 'block',
      reason: 'Dynamic eval execution is strictly disabled in code domain'
    },
    {
      id: 'code_no_unhandled_rejection',
      expression: 'REGEX:process\\.exit\\(',
      severity: 'warn',
      reason: 'Direct process.exit calls inside domain code are discouraged'
    }
  ],
  defaultInferenceRules: [
    {
      id: 'code_calc_infer',
      ifPattern: 'calculate',
      thenDeduction: 'Evaluate mathematical or logical code expression',
      actionTool: 'calc'
    }
  ],
  allowedTools: ['calc', 'echo', 'now'],
  maxExecutionTimeMs: 15000
};
