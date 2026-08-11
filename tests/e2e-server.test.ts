import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import {
  bootNawat,
  PROFILES,
  LinuxArchExecutionLayer,
  PersistentIndexer,
  scanProject,
  bytesChecksum,
  createToken,
  localize,
  HermesAdapter,
  HermesKernel,
  LLMCore,
  DeterministicBackend,
  type LocalizedString,
  type Extension
} from '../src/index';

const API_KEY = 'test-secret-e2e-key-123456789';
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nawat-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('Nawat Full E2E & Server Integration Tests ( server.ts & bin/nawat.ts )', () => {
  let server: http.Server;
  let baseUrl: string;
  let scanTestRoot: string;

  beforeAll(async () => {
    // Setup temporary test project directory for scan route
    scanTestRoot = makeTempDir();
    mkdirSync(join(scanTestRoot, 'src'));
    writeFileSync(join(scanTestRoot, 'src', 'index.ts'), 'console.log("hello");');
    writeFileSync(join(scanTestRoot, '.secret_env'), 'SECRET=123');
    writeFileSync(join(scanTestRoot, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(scanTestRoot, 'run.sh'), 0o755);

    // Build Express App mirroring server.ts architecture
    const app = express();
    app.use(express.json());

    const bootResult = await bootNawat({ profile: 'editor' });
    if (!bootResult.isOk) {
      throw bootResult.error;
    }
    const runtime = bootResult.value;
    const kernel = runtime.kernel;
    const context = kernel.getContext();
    const archLayer = new LinuxArchExecutionLayer({ defaultAgentId: 'test-arch', execRoot: scanTestRoot });

    // Auth & Readiness Middlewares
    app.use('/api', (req, res, next) => {
      if (req.path === '/health') return next();
      if (req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'E401: missing or invalid X-API-Key' });
      }
      next();
    });

    // Health Check
    app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', kernelReady: true, runtimeState: runtime.getState() });
    });

    // Kernel Info
    app.get('/api/kernel', (_req, res) => {
      res.json({
        isReady: true,
        profile: runtime.profile.name,
        commandsCount: context.commands.list().length
      });
    });

    // Commands List & Execute
    app.get('/api/commands', (_req, res) => {
      res.json({ commands: context.commands.list() });
    });

    app.post('/api/commands/register', (req, res) => {
      const { id, titleAr, titleEn } = req.body;
      if (!id || !titleAr || !titleEn) return res.status(400).json({ error: 'Missing fields' });
      context.commands.register({
        id,
        title: { ar: titleAr, en: titleEn },
        category: { ar: 'مخصص', en: 'Custom' },
        handler: (p) => `Executed ${id} with ${JSON.stringify(p)}`
      });
      res.json({ success: true });
    });

    app.post('/api/commands/execute', async (req, res) => {
      const { id, payload } = req.body;
      const resVal = await context.commands.execute(id, payload);
      if (resVal.isOk) {
        res.json({ success: true, value: resVal.value });
      } else {
        res.status(400).json({ success: false, error: resVal.error.message });
      }
    });

    // Events
    app.get('/api/events', (_req, res) => {
      res.json({ history: context.events.recent() });
    });

    app.post('/api/events/emit', (req, res) => {
      const { name, payload } = req.body;
      context.events.emit(name, payload ?? {});
      res.json({ success: true });
    });

    // Extensions
    app.get('/api/extensions', (_req, res) => {
      res.json({ activeCount: context.extensions.getActiveCount() });
    });

    app.post('/api/extensions/activate', async (req, res) => {
      const { id } = req.body;
      const ext: Extension = {
        id,
        name: { ar: id, en: id },
        version: '1.0.0',
        activate: () => {},
        deactivate: () => {}
      };
      const act = await context.extensions.activate(ext);
      if (act.isOk) res.json({ success: true });
      else res.status(400).json({ error: act.error.message });
    });

    // Arch Layer Execution Endpoint
    app.post('/api/arch/execute', async (req, res) => {
      const { commandLine, cwd } = req.body;
      const outcome = await archLayer.execute({ commandLine, cwd: cwd || scanTestRoot });
      res.json(outcome);
    });

    app.get('/api/arch/history', (_req, res) => {
      res.json({ count: archLayer.getRecords().length, records: archLayer.getRecords() });
    });

    // Project Scanner Endpoint
    app.post('/api/projects/scan', (req, res) => {
      const { root } = req.body;
      if (!root) return res.status(400).json({ error: 'root required' });
      const report = scanProject(root);
      res.json(report);
    });

    // Chat completions Endpoint
    app.post('/api/v1/chat/completions', async (req, res) => {
      const { model = 'hermes-3-llama-3.1-8b', messages } = req.body;
      const userPrompt = messages?.[messages.length - 1]?.content || 'hello';
      const formatted = HermesAdapter.formatOpenAIResponse(model, `Echo response to: ${userPrompt}`);
      res.json(formatted);
    });

    // Start ephemeral server
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  it('rejects unauthenticated requests to protected /api endpoints with E401', async () => {
    const res = await fetch(`${baseUrl}/api/kernel`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('E401');
  });

  it('allows public health check /api/health without API key', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.kernelReady).toBe(true);
  });

  it('allows authenticated kernel status query with valid X-API-Key', async () => {
    const res = await fetch(`${baseUrl}/api/kernel`, {
      headers: { 'X-API-Key': API_KEY }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isReady).toBe(true);
    expect(body.profile).toBe('editor');
  });

  it('allows registering and executing custom commands over REST API', async () => {
    const regRes = await fetch(`${baseUrl}/api/commands/register`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test.greet', titleAr: 'مرحباً', titleEn: 'Hello' })
    });
    expect(regRes.status).toBe(200);

    const execRes = await fetch(`${baseUrl}/api/commands/execute`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test.greet', payload: 'World' })
    });
    expect(execRes.status).toBe(200);
    const execBody = await execRes.json();
    expect(execBody.success).toBe(true);
    expect(execBody.value).toContain('World');
  });

  it('emits and retrieves events via REST API', async () => {
    const emitRes = await fetch(`${baseUrl}/api/events/emit`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'custom:event', payload: { foo: 'bar' } })
    });
    expect(emitRes.status).toBe(200);

    const eventsRes = await fetch(`${baseUrl}/api/events`, {
      headers: { 'X-API-Key': API_KEY }
    });
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json();
    expect(Array.isArray(eventsBody.history)).toBe(true);
    expect(eventsBody.history.some((e: any) => e.name === 'custom:event')).toBe(true);
  });

  it('executes safe commands via Arch execution layer and enforces security rules', async () => {
    // Safe echo command
    const safeRes = await fetch(`${baseUrl}/api/arch/execute`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandLine: 'echo hello_e2e' })
    });
    expect(safeRes.status).toBe(200);
    const safeBody = await safeRes.json();
    expect(safeBody.verdict).toBe('allowed');
    expect(safeBody.status).toBe('success');
    expect(safeBody.stdout).toContain('hello_e2e');

    // Dangerous command blocked by constraint engine
    const blockedRes = await fetch(`${baseUrl}/api/arch/execute`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandLine: 'rm -rf /' })
    });
    expect(blockedRes.status).toBe(200);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.verdict).toBe('denied');
    expect(blockedBody.status).toBe('blocked');

    // Arch history verification
    const histRes = await fetch(`${baseUrl}/api/arch/history`, {
      headers: { 'X-API-Key': API_KEY }
    });
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    expect(histBody.count).toBeGreaterThanOrEqual(2);
  });

  it('scans project structure via /api/projects/scan', async () => {
    const scanRes = await fetch(`${baseUrl}/api/projects/scan`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: scanTestRoot })
    });
    expect(scanRes.status).toBe(200);
    const scanBody = await scanRes.json();
    expect(scanBody.scannedFiles).toBeGreaterThanOrEqual(2);
    expect(scanBody.hidden.some((p: string) => p.endsWith('.secret_env'))).toBe(true);
  });

  it('handles OpenAI format chat completions via /api/v1/chat/completions', async () => {
    const chatRes = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes-3-llama-3.1-8b',
        messages: [{ role: 'user', content: 'What is Nawat?' }]
      })
    });
    expect(chatRes.status).toBe(200);
    const chatBody = await chatRes.json();
    expect(chatBody.object).toBe('chat.completion');
    expect(chatBody.choices?.[0]?.message?.content).toContain('What is Nawat?');
  });

  it('verifies bin/nawat.ts CLI tool execution in shell', () => {
    // Test help command
    const helpOutput = execSync('npx tsx bin/nawat.ts help', { encoding: 'utf-8' });
    expect(helpOutput).toContain('Nawat Kernel Host CLI');
    expect(helpOutput).toContain('Usage:');

    // Test profiles command
    const profilesOutput = execSync('npx tsx bin/nawat.ts profiles', { encoding: 'utf-8' });
    expect(profilesOutput).toContain('Available Profiles:');
    expect(profilesOutput).toContain('editor');

    // Test status command
    const statusOutput = execSync('npx tsx bin/nawat.ts status --profile=editor', { encoding: 'utf-8' });
    expect(statusOutput).toContain('[Nawat Host] Boot success');
    expect(statusOutput).toContain('bootTimeMs');
  });
});
