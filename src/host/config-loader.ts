import fs from 'fs';
import { type ProfileName } from './profiles';

export interface HostConfigFile {
  profile?: ProfileName;
  enableAgentKernel?: boolean;
  enableHermes?: boolean;
  enableEditor?: boolean;
  enableLinuxHost?: boolean;
  vfsRoot?: string;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

const ALLOWED_CONFIG_FIELDS = new Set([
  'profile',
  'enableAgentKernel',
  'enableHermes',
  'enableEditor',
  'enableLinuxHost',
  'vfsRoot',
  'logLevel'
]);

export function loadConfigFile(configPath: string): HostConfigFile {
  if (!fs.existsSync(configPath)) {
    const err = new Error(`ENOENT: no such file or directory, open '${configPath}'`);
    (err as any).code = 'ENOENT';
    throw err;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('EINVAL: config is not valid JSON');
    (err as any).code = 'EINVAL';
    throw err;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const err = new Error('EINVAL: config must be a JSON object');
    (err as any).code = 'EINVAL';
    throw err;
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_CONFIG_FIELDS.has(key)) {
      const err = new Error(`EINVAL: unknown config field: ${key}`);
      (err as any).code = 'EINVAL';
      throw err;
    }
  }

  return parsed as HostConfigFile;
}
