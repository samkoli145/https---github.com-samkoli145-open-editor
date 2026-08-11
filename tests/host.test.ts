import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import {
  Bootloader,
  bootNawat,
  PROFILES,
  NawatRuntime,
  VirtualFileSystem,
  loadConfigFile,
  HermesKernel,
  ToolRegistry,
  CommandRegistry,
  SessionManager,
  ResourceQuotaGuard
} from '../src/index';

describe('Host Layer & Bootloader (محمل الإقلاع والطبقة المستضيفة)', () => {
  // -------------------------------------------------------------
  // 🔴 P0 — Failure Cases & Profile Isolation & Config Validation
  // -------------------------------------------------------------

  describe('Bootloader Lifecycle Failure', () => {
    it('should cleanup VFS when kernel boot fails', async () => {
      const bootloader = new Bootloader({
        kernelOptions: { invalid: true }
      });

      await expect(bootloader.boot()).rejects.toThrow('EINVAL');
      expect(bootloader.vfs.isDisposed).toBe(true);
      expect(bootloader.state).toBe('failed');
    });

    it('should handle shutdown during pending syscall', async () => {
      const bootloader = new Bootloader({ profile: 'agent' });
      const runtime = await bootloader.boot();

      const pendingSyscall = runtime.executeSyscall('agent.llm.chat', { msg: 'test' });
      const shutdownPromise = bootloader.shutdown({ timeoutMs: 1000 });

      await expect(shutdownPromise).resolves.toBeUndefined();
      await expect(pendingSyscall).rejects.toThrow('ECANCELED');
      expect(bootloader.state).toBe('stopped');
    });
  });

  describe('Profile Isolation', () => {
    it('headless profile should NOT load agent-kernel', async () => {
      const bootloader = new Bootloader({ profile: 'headless' });
      const runtime = await bootloader.boot();

      expect(bootloader.agentKernel).toBeUndefined();
      await expect(
        runtime.executeCommand('agent.llm.chat', {})
      ).rejects.toThrow('ENOSYS');

      await bootloader.shutdown();
    });

    it('agent profile should NOT load hermes', async () => {
      const bootloader = new Bootloader({ profile: 'agent' });
      const runtime = await bootloader.boot();

      expect(bootloader.agentKernel).toBeDefined();
      expect(bootloader.hermes).toBeUndefined();
      await expect(
        runtime.executeCommand('hermes.learn', {})
      ).rejects.toThrow('ENOSYS');

      await bootloader.shutdown();
    });

    it('editor profile should load ALL layers', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      await bootloader.boot();

      expect(bootloader.agentKernel).toBeDefined();
      expect(bootloader.hermes).toBeDefined();
      expect(bootloader.editor).toBeDefined();

      await bootloader.shutdown();
    });
  });

  describe('Real Kernel Binding (integration)', () => {
    it('editor profile binds a real HermesKernel (not a mock)', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      const runtime = await bootloader.boot();

      expect(bootloader.hermes).toBeDefined();
      expect(bootloader.hermes!.kernel).toBeInstanceOf(HermesKernel);

      const serveRes = await bootloader.hermes!.serve('hello', 'echo', { message: 'real-hermes' });
      expect(serveRes.isOk).toBe(true);
      if (serveRes.isOk) {
        expect(serveRes.value.result).toBe('real-hermes');
      }

      const learnRes = await runtime.executeCommand('hermes.learn', { topic: 'intro-to-security' });
      expect(learnRes.output).toBe('Hermes learned: intro-to-security');

      await bootloader.shutdown();
    });

    it('agent profile binds a real LLM-based agent kernel (not a mock)', async () => {
      const bootloader = new Bootloader({ profile: 'agent' });
      const runtime = await bootloader.boot();

      expect(bootloader.agentKernel).toBeDefined();
      expect(bootloader.agentKernel!.llm).toBeDefined();

      const chatOut = await bootloader.agentKernel!.chat('hello-agent');
      expect(typeof chatOut).toBe('string');
      expect(chatOut.length).toBeGreaterThan(0);

      const cmdRes = await runtime.executeCommand('agent.llm.chat', { msg: 'how are you' });
      expect(cmdRes.output).toBeTruthy();

      await bootloader.shutdown();
    });
  });

  describe('Merged Integration (syscall dispatch / tool-command bridge / session quota / VFS storage)', () => {
    it('executeSyscall dispatches a real registered command and emits syscall:executed', async () => {
      const bootloader = new Bootloader({ profile: 'agent' });
      const runtime = await bootloader.boot();

      const res = await runtime.executeSyscall('agent.llm.chat', { msg: 'syscall-hi' });
      expect(res.output).toBeTruthy();

      const events = runtime.kernel.getContext().events.recent();
      expect(events.some(e => e.name === 'syscall:executed')).toBe(true);

      await bootloader.shutdown();
    });

    it('cancels a long-running syscall on shutdown without unhandled rejection', async () => {
      const bootloader = new Bootloader({ profile: 'agent' });
      const runtime = await bootloader.boot();

      runtime.kernel.getContext().commands.register({
        id: 'slow.cmd',
        title: { ar: 'بطيء', en: 'Slow' },
        category: { ar: 'مؤقت', en: 'Temp' },
        description: { ar: '', en: '' },
        handler: () => new Promise(res => setTimeout(res, 2000))
      });

      const pending = runtime.executeSyscall('slow.cmd', {});
      const errorPromise = pending.then(() => null, (err: any) => err);

      await bootloader.shutdown({ timeoutMs: 1000 });

      const err = await errorPromise;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch('ECANCELED');

      await new Promise(res => setTimeout(res, 20));
    });

    it('registers tools as kernel commands via ToolRegistry<->CommandRegistry bridge', async () => {
      const commands = new CommandRegistry();
      const tools = new ToolRegistry(commands);

      expect(commands.has('tool.echo')).toBe(true);
      expect(commands.has('tool.now')).toBe(true);

      const res = await commands.execute('tool.echo', 'bridge-ok');
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        const inner: any = res.value;
        expect(inner.isOk).toBe(true);
        expect(inner.value).toBe('bridge-ok');
      }
    });

    it('session executeRequest enforces ResourceQuotaGuard and rejects on excess', async () => {
      const guard = new ResourceQuotaGuard();
      guard.setQuota('agent-x', { maxSyscallsPerMinute: 2 });
      const manager = new SessionManager(undefined, guard);
      const created = manager.createSession('sess_q', 'agent-x');
      expect(created.isOk).toBe(true);
      if (!created.isOk) throw created.error;
      const session = created.value;

      expect(session.executeRequest('a').isOk).toBe(true);
      expect(session.executeRequest('b').isOk).toBe(true);

      const third = session.executeRequest('c');
      expect(third.isErr).toBe(true);
      if (third.isErr) {
        expect(third.error.message).toContain('EQUOTA_EXCEEDED');
      }
    });

    it('VFS persists file writes through SafeStorageEngine (read/exists/delete)', async () => {
      const vfs = new VirtualFileSystem('/vfs-test');
      vfs.mount();

      const writeRes = await vfs.writeFile('notes/hello.txt', 'مرحبا');
      expect(writeRes.isOk).toBe(true);
      expect(await vfs.exists('notes/hello.txt')).toBe(true);

      const readRes = await vfs.readFile('notes/hello.txt');
      expect(readRes.isOk).toBe(true);
      if (readRes.isOk) expect(readRes.value).toBe('مرحبا');

      const delRes = await vfs.deleteFile('notes/hello.txt');
      expect(delRes.isOk).toBe(true);
      expect(await vfs.exists('notes/hello.txt')).toBe(false);

      vfs.dispose();
    });
  });

  describe('REST API Lifecycle Safety', () => {
    function createTestServer(runtimeProvider: () => NawatRuntime | undefined) {
      const app = express();
      app.use('/api', (req, res, next) => {
        const rt = runtimeProvider();
        if (!rt || rt.getState() !== 'running') {
          return res.status(503).json({ error: 'Kernel not ready' });
        }
        next();
      });
      app.get('/api/host/status', (req, res) => {
        res.json({ status: 'ok', state: runtimeProvider()?.getState() });
      });
      return app;
    }

    it('should reject requests before boot', async () => {
      let currentRuntime: NawatRuntime | undefined;
      const app = createTestServer(() => currentRuntime);

      const server = app.listen(0);
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/host/status`);
        expect(res.status).toBe(503);
        const data = await res.json();
        expect(data).toEqual({ error: 'Kernel not ready' });
      } finally {
        server.close();
      }
    });

    it('should reject requests after shutdown', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      const runtime = await bootloader.boot();

      const app = createTestServer(() => runtime);
      const server = app.listen(0);
      const port = (server.address() as any).port;

      try {
        await bootloader.shutdown();
        const res = await fetch(`http://127.0.0.1:${port}/api/host/status`);
        expect(res.status).toBe(503);
      } finally {
        server.close();
      }
    });

    it('should handle concurrent REST requests', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      const runtime = await bootloader.boot();

      const app = createTestServer(() => runtime);
      const server = app.listen(0);
      const port = (server.address() as any).port;

      try {
        const requests = Array(10)
          .fill(null)
          .map(() => fetch(`http://127.0.0.1:${port}/api/host/status`));

        const responses = await Promise.all(requests);
        expect(responses.every((r) => r.status === 200)).toBe(true);
      } finally {
        server.close();
        await bootloader.shutdown();
      }
    });
  });

  describe('Configuration Validation', () => {
    const tmpDir = path.join(process.cwd(), '.tmp_test_config');

    beforeAll(() => {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should reject missing config file', async () => {
      const missingPath = path.join(tmpDir, 'nonexistent_config.json');
      const bootloader = new Bootloader({ configPath: missingPath });
      await expect(bootloader.boot()).rejects.toThrow('ENOENT');

      const res = await bootNawat({ configPath: missingPath });
      expect(res.isOk).toBe(false);
      if (!res.isOk) {
        expect(res.error.message).toContain('ENOENT');
      }
    });

    it('should reject invalid JSON config', async () => {
      const badJsonPath = path.join(tmpDir, 'bad_json.json');
      fs.writeFileSync(badJsonPath, '{ invalid json syntax }');

      const bootloader = new Bootloader({ configPath: badJsonPath });
      await expect(bootloader.boot()).rejects.toThrow('EINVAL: config is not valid JSON');

      const res = await bootNawat({ configPath: badJsonPath });
      expect(res.isOk).toBe(false);
      if (!res.isOk) {
        expect(res.error.message).toContain('EINVAL: config is not valid JSON');
      }
    });

    it('should reject config with unknown fields', async () => {
      const unknownFieldsPath = path.join(tmpDir, 'unknown_fields.json');
      fs.writeFileSync(
        unknownFieldsPath,
        JSON.stringify({ profile: 'editor', unknownField: 'unexpected' })
      );

      const bootloader = new Bootloader({ configPath: unknownFieldsPath });
      await expect(bootloader.boot()).rejects.toThrow('EINVAL: unknown config field: unknownField');

      const res = await bootNawat({ configPath: unknownFieldsPath });
      expect(res.isOk).toBe(false);
      if (!res.isOk) {
        expect(res.error.message).toContain('EINVAL: unknown config field: unknownField');
      }
    });
  });

  // -------------------------------------------------------------
  // 🟠 P1 — Idempotency & State Machine & Resource Cleanup
  // -------------------------------------------------------------

  describe('Idempotency', () => {
    it('boot() should be idempotent', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      await bootloader.boot();
      await bootloader.boot(); // Second call should not throw
      expect(bootloader.state).toBe('running');
      await bootloader.shutdown();
    });

    it('shutdown() should be idempotent', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      await bootloader.boot();
      await bootloader.shutdown();
      await bootloader.shutdown(); // Second call should not throw
      expect(bootloader.state).toBe('stopped');
    });
  });

  describe('State Machine', () => {
    it('should enforce valid state transitions', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      expect(bootloader.state).toBe('initialized');

      await bootloader.loadConfig();
      expect(bootloader.state).toBe('config-loaded');

      await bootloader.mountVFS();
      expect(bootloader.state).toBe('vfs-mounted');

      // Attempting duplicate/invalid transition should throw
      await expect(bootloader.loadConfig()).rejects.toThrow(
        'Invalid state transition: vfs-mounted -> config-loaded'
      );
      await bootloader.shutdown();
    });
  });

  describe('Resource Cleanup', () => {
    it('should cleanup VFS when kernel initialization fails', async () => {
      const bootloader = new Bootloader({
        profile: 'editor',
        kernelOptions: { invalid: true }
      });

      await bootloader.mountVFS();
      expect(bootloader.vfs.isMounted).toBe(true);

      await expect(bootloader.initializeKernel()).rejects.toThrow();
      expect(bootloader.vfs.isMounted).toBe(false);
      expect(bootloader.vfs.isDisposed).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // 🟡 P2 — Performance & Memory Safety
  // -------------------------------------------------------------

  describe('Performance Budget', () => {
    it('boot time should be < 500ms', async () => {
      const start = Date.now();
      const bootloader = new Bootloader({ profile: 'editor' });
      await bootloader.boot();
      const bootTime = Date.now() - start;

      expect(bootTime).toBeLessThan(500);
      await bootloader.shutdown();
    });

    it('shutdown time should be < 200ms', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      await bootloader.boot();

      const start = Date.now();
      await bootloader.shutdown();
      const shutdownTime = Date.now() - start;

      expect(shutdownTime).toBeLessThan(200);
    });
  });

  describe('Memory Safety', () => {
    it('should not leak memory after boot/shutdown cycle', async () => {
      if (global.gc) global.gc();
      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < 10; i++) {
        const bootloader = new Bootloader({ profile: 'editor' });
        await bootloader.boot();
        await bootloader.shutdown();
      }

      if (global.gc) global.gc();
      const finalMemory = process.memoryUsage().heapUsed;
      const growth = (finalMemory - initialMemory) / initialMemory;

      expect(growth).toBeLessThan(0.5);
    });
  });

  // -------------------------------------------------------------
  // 🔵 P3 — Chaos Engineering & Force Termination
  // -------------------------------------------------------------

  describe('Chaos Engineering', () => {
    it('should handle force kill during running state', async () => {
      const bootloader = new Bootloader({ profile: 'editor' });
      const runtime = await bootloader.boot();

      const pendingSyscall = runtime.executeSyscall('agent.llm.chat', { msg: 'test' });
      bootloader.forceKill();

      await expect(pendingSyscall).rejects.toThrow('EKILLED: Process forcibly killed');
      expect(bootloader.vfs.isDisposed).toBe(true);
      expect(bootloader.state).toBe('failed');
    });
  });
});
