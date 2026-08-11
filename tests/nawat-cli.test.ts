import { describe, it, expect } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E CLI (فجوة ل): واجهة `bin/nawat.ts` الحقيقية تُشغَّل كعملية — help/profiles/status.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI = 'node_modules/.bin/tsx';

function runCli(args: string[], opts: ExecFileSyncOptions = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(CLI, ['bin/nawat.ts', ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      ...opts
    });
    return { stdout: String(stdout), status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString() ?? '', status: err.status ?? -1 };
  }
}

describe('Nawat CLI (bin/nawat.ts)', () => {
  it('prints usage and exits 0 for `help`', () => {
    const { stdout, status } = runCli(['help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Nawat Kernel Host CLI');
    expect(stdout).toContain('nawat status');
    expect(stdout).toContain('nawat profiles');
  });

  it('accepts `--help` and `-h` too', () => {
    for (const flag of ['--help', '-h']) {
      const { stdout, status } = runCli([flag]);
      expect(status).toBe(0);
      expect(stdout).toContain('Usage:');
    }
  });

  it('lists available profiles and exits 0', () => {
    const { stdout, status } = runCli(['profiles']);
    expect(status).toBe(0);
    expect(stdout).toContain('Available Profiles');
    for (const expected of ['editor', 'agent', 'hermes']) {
      expect(stdout).toContain(expected);
    }
  });

  it('boots the kernel and reports status metrics (exit 0)', () => {
    const { stdout, status } = runCli(['status']);
    expect(status).toBe(0);
    expect(stdout).toContain('Boot success');
    expect(stdout).toContain('signalingLatencyMs');
    const metrics = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(typeof metrics.bootTimeMs).toBe('number');
    expect(metrics.signalingLatencyMs).toBeLessThanOrEqual(10);
  });
});
