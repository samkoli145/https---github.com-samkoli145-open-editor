import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E (فجوة ل): الخادم الحقيقي يُقلع في عملية فرعية ويُختبَر عبر HTTP — مصادقة،
// فحص مشروع، تنفيذ أرش معزول، أوامر نواة، Hermes، تدقيق. لا يُستدعى أي كود
// داخلي مباشرة (اختبار أسود على الشبكة فقط).
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const API_KEY = 'e2e-test-key-1234';
const PORT = 32000 + Math.floor(Math.random() * 25000);
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc: ChildProcess;
let serverLog = '';
let ready = false;

const fixtureRoot = mkdtempSync(join(tmpdir(), 'nawat-e2e-'));
const fixture = join(fixtureRoot, 'fixture');
const cleanContent = 'print("clean baseline")\n';
const tamperedContent = 'print("tampered now")\n';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function waitForServer(timeoutMs = 40000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { headers: { 'X-API-Key': API_KEY } });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready. log:\n${serverLog}`);
}

function api(path: string, opts: { method?: string; body?: unknown; key?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers['X-API-Key'] = opts.key ?? API_KEY;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
}

beforeAll(async () => {
  // مشروع تجريبي يحتوي: مسجّل سليم، مسجّل ببصمة خاطئة (معبث)، مزروع (غير مسجّل)،
  // مخفي، قابل للتنفيذ، setuid (backdoor)، رابط خارج الجذر (هروب).
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'main.py'), tamperedContent);
  writeFileSync(join(fixture, 'src', 'clean.py'), cleanContent);
  writeFileSync(join(fixture, 'src', 'evil.py'), 'print("planted")\n');
  writeFileSync(join(fixture, '.hidden.txt'), 'do not show\n');
  writeFileSync(join(fixture, 'run.sh'), '#!/usr/bin/env python3\nprint("runner")\n');
  chmodSync(join(fixture, 'run.sh'), 0o755);
  writeFileSync(join(fixture, 'evil-setuid.sh'), '#!/bin/sh\necho root\n');
  chmodSync(join(fixture, 'evil-setuid.sh'), 0o4755);
  symlinkSync('/etc/hostname', join(fixture, 'link-to-etc'));

  serverProc = spawn('node_modules/.bin/tsx', ['server.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NAWAT_API_KEY: API_KEY,
      NAWAT_HOST: '127.0.0.1',
      PORT: String(PORT),
      NAWAT_SCAN_ROOTS: fixtureRoot
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout?.on('data', (d) => { serverLog += d.toString(); });
  serverProc.stderr?.on('data', (d) => { serverLog += d.toString(); });
  serverProc.on('exit', (code) => { serverLog += `\n[server exited code=${code}]`; });

  await waitForServer();
  ready = true;
});

afterAll(async () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Nawat E2E Server — authentication & kernel surface', () => {
  it('rejects /api without X-API-Key (401)', async () => {
    const res = await api('/api/host', { key: null });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('X-API-Key');
  });

  it('rejects /api with a wrong X-API-Key (401)', async () => {
    const res = await api('/api/host', { key: 'wrong-key' });
    expect(res.status).toBe(401);
  });

  it('accepts the pinned API key and reports host status (200)', async () => {
    const res = await api('/api/host');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimeState).toBe('running');
    expect(body.profile.name).toBeTruthy();
  });

  it('boots with the editor profile and exposes kernel status', async () => {
    const res = await api('/api/kernel');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBe('editor');
    expect(body.commandsCount).toBeGreaterThan(0);
  });
});

describe('Nawat E2E Server — commands', () => {
  it('executes the built-in system.echo command', async () => {
    const res = await api('/api/commands/execute', { method: 'POST', body: { id: 'system.echo', payload: 'e2e-payload' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.value).toContain('e2e-payload');
  });

  it('lists registered commands via GET /api/commands', async () => {
    const res = await api('/api/commands');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.commands)).toBe(true);
    expect(body.commands.some((c: any) => c.id === 'system.echo')).toBe(true);
  });
});

describe('Nawat E2E Server — isolated arch execution', () => {
  it('executes an allowlisted command inside the execution root', async () => {
    const res = await api('/api/arch/execute', {
      method: 'POST',
      body: { commandLine: 'echo e2e-arch-ok', agentId: 'e2e' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('allowed');
    expect(body.status).toBe('success');
    expect(body.stdout).toContain('e2e-arch-ok');
  });

  it('blocks path traversal / absolute escapes outside the exec root', async () => {
    const res = await api('/api/arch/execute', {
      method: 'POST',
      body: { commandLine: 'cat /etc/hostname', agentId: 'e2e' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('denied');
    expect(body.status).toBe('blocked');
    expect(body.reason).toMatch(/outside the execution root/);
  });

  it('surfaces arch status with syscall counters', async () => {
    const res = await api('/api/arch/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.syscallCount).toBe('number');
  });
});

describe('Nawat E2E Server — Hermes serve/train & chat completions', () => {
  it('serves a Hermes request', async () => {
    const res = await api('/api/hermes/serve', { method: 'POST', body: { input: 'e2e hermes request' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('trains Hermes with a fact and records audit', async () => {
    const res = await api('/api/hermes/train', { method: 'POST', body: { topic: 'e2e', title: 'E2E Fact', content: 'fact content' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns an OpenAI-compatible chat completion shape', async () => {
    const res = await api('/api/v1/chat/completions', {
      method: 'POST',
      body: { model: 'hermes-3-llama-3.1-8b', messages: [{ role: 'user', content: 'hello e2e' }] }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBeTruthy();
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0].message.content).toBeTruthy();
  });
});

describe('Nawat E2E Server — project scan (baseline + SHA-256) & audit', () => {
  it('rejects scanning a root outside the allowed scan roots (403)', async () => {
    const res = await api('/api/projects/scan', { method: 'POST', body: { root: '/etc' } });
    expect(res.status).toBe(403);
  });

  it('scans the fixture project and detects hidden/executable/backdoor/escape/planted/tampered', async () => {
    const res = await api('/api/projects/scan', {
      method: 'POST',
      body: {
        root: fixture,
        registered: [
          { path: 'src/main.py', checksum: sha256('print("old baseline")\n') },
          { path: 'src/clean.py', checksum: sha256(cleanContent) }
        ]
      }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe(fixture);
    expect(body.scannedFiles).toBeGreaterThan(0);
    expect(body.counts.tampered).toBeGreaterThanOrEqual(1);
    expect(body.counts.ok).toBeGreaterThanOrEqual(1);
    expect(body.counts.unregistered).toBeGreaterThanOrEqual(1);
    expect(body.counts.hidden).toBeGreaterThanOrEqual(1);
    expect(body.counts.backdoor).toBeGreaterThanOrEqual(1);
    expect(body.counts.outside_link).toBeGreaterThanOrEqual(1);
    expect(body.executables.some((e: any) => e.path.endsWith('run.sh'))).toBe(true);

    const tampered = body.findings.find((f: any) => f.kind === 'tampered');
    expect(tampered.detail).toContain('checksum mismatch');
  });

  it('records sensitive actions in the audit log', async () => {
    const res = await api('/api/audit');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    const actions = body.records.map((r: any) => r.action);
    expect(actions).toContain('projects.scan');
    expect(actions).toContain('projects.scan.denied');
    expect(actions).toContain('arch.execute');
  });
});
