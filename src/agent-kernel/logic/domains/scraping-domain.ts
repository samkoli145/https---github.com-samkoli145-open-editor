import { DomainProfile } from './domain-types';

export const SCRAPING_DOMAIN_PROFILE: DomainProfile = {
  name: 'scraping',
  description: 'Specialized domain kernel for web scraping, rate limiting, and DOM extraction.',
  defaultConstraints: [
    {
      id: 'scraping_no_internal_ip',
      expression: 'REGEX:(127\\.0\\.0\\.1|localhost|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+)',
      severity: 'block',
      reason: 'SSRF Prevention: Scraping internal network IPs is forbidden'
    }
  ],
  defaultInferenceRules: [
    {
      id: 'scraping_fetch_page',
      ifPattern: 'http',
      thenDeduction: 'Fetch target URL with rate-limiting guard',
      actionTool: 'echo'
    }
  ],
  allowedTools: ['echo', 'now'],
  maxExecutionTimeMs: 20000
};
