import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E أسود حقيقي (فجوة ل): يُقلع `server.ts` الفعلي في عملية فرعية (لا mirror
// في العملية) ويُختبَر عبر HTTP: مصادقة · أوامر · أرش معزول · هيرمس · فحص مشروع
// بخط أساس دائم SHA-256 · تدقيق. يتم بعد اعتماد نسخة archive الأساس.
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const API_KEY = 'e2e-blackbox-key-1234';
const PORT = 33000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc: ChildProcess;
let serverLog = '';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'nawat-blackbox-'));
const fixture = join(fixtureRoot, 'fixture');
const cleanContent = 'print("clean baseline")\n';
const oldMainContent = 'print("old baseline")\n';
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
});

afterAll(async () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Nawat Black-Box E2E — real server.ts (auth & kernel)', () => {
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

  it('accepts the pinned key and reports host status (200)', async () => {
    const res = await api('/api/host');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimeState).toBe('running');
  });
});

describe('Nawat Black-Box E2E — §5-ي hardening (register/emit تعتمد المصادقة + تدقيق إلزامي)', () => {
  it('rejects /api/commands/register without X-API-Key (401)', async () => {
    const res = await api('/api/commands/register', {
      method: 'POST',
      key: null,
      body: { id: 'x', titleAr: 'أ', titleEn: 'x' }
    });
    expect(res.status).toBe(401);
  });

  it('records commands.register + extensions.activate + events.emit in the audit log', async () => {
    const reg = await api('/api/commands/register', {
      method: 'POST',
      body: { id: 'audit.cmd', titleAr: 'تدقيق', titleEn: 'audit' }
    });
    expect(reg.status).toBe(200);

    const ext = await api('/api/extensions/activate', {
      method: 'POST',
      body: { id: 'audit.ext', nameAr: 'ت', nameEn: 'e' }
    });
    expect(ext.status).toBe(200);

    const emit = await api('/api/events/emit', {
      method: 'POST',
      body: { name: 'audit.evt', payload: { note: 'probe' } }
    });
    expect(emit.status).toBe(200);

    const res = await api('/api/audit');
    expect(res.status).toBe(200);
    const body = await res.json();
    const actions = body.records.map((r: any) => r.action);
    expect(actions).toContain('commands.register');
    expect(actions).toContain('extensions.activate');
    expect(actions).toContain('events.emit');
  });
});

describe('Nawat Black-Box E2E — commands & isolated arch execution', () => {
  it('executes the built-in system.echo command', async () => {
    const res = await api('/api/commands/execute', { method: 'POST', body: { id: 'system.echo', payload: 'bb-payload' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.value).toContain('bb-payload');
  });

  it('executes an allowlisted command inside the execution root', async () => {
    const res = await api('/api/arch/execute', { method: 'POST', body: { commandLine: 'echo bb-arch-ok', agentId: 'bb' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('allowed');
    expect(body.status).toBe('success');
    expect(body.stdout).toContain('bb-arch-ok');
  });

  it('blocks absolute escapes outside the exec root', async () => {
    const res = await api('/api/arch/execute', { method: 'POST', body: { commandLine: 'cat /etc/hostname', agentId: 'bb' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('denied');
    expect(body.status).toBe('blocked');
    expect(body.reason).toMatch(/outside the execution root/);
  });

  it('blocks relative `..` traversal escapes outside the exec root', async () => {
    const res = await api('/api/arch/execute', { method: 'POST', body: { commandLine: 'cat ../../../../etc/hostname', agentId: 'bb' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('denied');
    expect(body.reason).toMatch(/outside the execution root/);
  });
});

describe('Nawat Black-Box E2E — hermes serve/train & chat completions', () => {
  it('serves a Hermes request', async () => {
    const res = await api('/api/hermes/serve', { method: 'POST', body: { input: 'bb hermes request' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('trains Hermes and records audit', async () => {
    const res = await api('/api/hermes/train', { method: 'POST', body: { topic: 'bb', title: 'BB Fact', content: 'fact' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns an OpenAI-compatible chat completion shape', async () => {
    const res = await api('/api/v1/chat/completions', {
      method: 'POST',
      body: { model: 'hermes-3-llama-3.1-8b', messages: [{ role: 'user', content: 'hello bb' }] }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0].message.content).toBeTruthy();
  });
});

describe('Nawat Black-Box E2E — project scan with persistent SHA-256 baseline (ص/ف) & audit', () => {
  it('rejects scanning a root outside the allowed scan roots (403)', async () => {
    const res = await api('/api/projects/scan', { method: 'POST', body: { root: '/etc' } });
    expect(res.status).toBe(403);
  });

  it('detects hidden/executable/backdoor/escape/planted/tampered against a registered baseline', async () => {
    const res = await api('/api/projects/scan', {
      method: 'POST',
      body: {
        root: fixture,
        registered: [
          { path: 'src/main.py', checksum: sha256(oldMainContent) },
          { path: 'src/clean.py', checksum: sha256(cleanContent) }
        ]
      }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
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

  it('persists the baseline and detects tampering in a later scan without registered list', async () => {
    // أعد كتابة clean.py بمحتوى مختلف بعد الخط الأساس
    writeFileSync(join(fixture, 'src', 'clean.py'), '# changed after baseline\n');
    const res = await api('/api/projects/scan', { method: 'POST', body: { root: fixture } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.tampered).toBeGreaterThanOrEqual(1);
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

describe('Nawat Black-Box E2E — orchestrator kernel & tool discovery (العقل الموجّه)', () => {
  it('lists discovered tools behind auth (200 + tools array)', async () => {
    const res = await api('/api/editor/tools');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    const ids = body.tools.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['vscode', 'neovim', 'opencode']));
  });

  it('rejects /api/editor/tools without X-API-Key (401)', async () => {
    const res = await api('/api/editor/tools', { key: null });
    expect(res.status).toBe(401);
  });

  it('dispatches an inspect intent and reports the chosen tool', async () => {
    const res = await api('/api/orchestrator/dispatch', {
      method: 'POST',
      body: { intent: 'inspect', path: 'server.ts' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('dispatched');
    expect(body.toolUsed).toBeTruthy();
  });

  it('dispatches an exec intent through the arch security gates (200)', async () => {
    const res = await api('/api/orchestrator/dispatch', {
      method: 'POST',
      body: { intent: 'exec', command: 'echo bb-orch-ok' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.toolUsed).toBe('Bash Terminal Agent');
    expect(body.output).toContain('bb-orch-ok');
  });

  it('blocks an exec intent escaping the execution root (400)', async () => {
    const res = await api('/api/orchestrator/dispatch', {
      method: 'POST',
      body: { intent: 'exec', command: 'cat /etc/hostname' }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outside the execution root/);
  });

  it('rejects exec via a shell (bash not allowlisted) (400)', async () => {
    const res = await api('/api/orchestrator/dispatch', {
      method: 'POST',
      body: { intent: 'exec', command: 'bash -c "id"' }
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('allowlist');
  });

  it('returns LSP diagnostics for a TypeScript file (200)', async () => {
    const res = await api('/api/lsp/diagnostics?path=file.ts');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect(body.diagnostics.length).toBeGreaterThan(0);
    expect(body.diagnostics[0].source).toBe('tsserver');
  });

  it('returns empty LSP diagnostics for unsupported files (200)', async () => {
    const res = await api('/api/lsp/diagnostics?path=README.md');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diagnostics).toEqual([]);
  });
});
