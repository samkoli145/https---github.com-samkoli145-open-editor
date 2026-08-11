import { describe, it, expect } from 'vitest';
import {
  AgentSyscall,
  AgentSyscallQueue,
  ToolRegistry,
  AgentRegistry,
  LLMCore,
  OllamaBackend,
  DeterministicBackend
} from '../src/agent-kernel/index';

describe('Agent Kernel - Syscalls, Tools, and Registry Layer', () => {
  // -------------------------------------------------------------------
  // 1. AgentSyscall & AgentSyscallQueue
  // -------------------------------------------------------------------
  describe('AgentSyscall & Queue Lifecycle', () => {
    it('creates syscall with defaults and auto-generated ID', () => {
      const syscall = new AgentSyscall({ name: 'agent.file.read', payload: { path: '/test' } });
      expect(syscall.id).toMatch(/^sys_/);
      expect(syscall.status).toBe('pending');
      expect(syscall.priority).toBe('normal');
      expect(syscall.category).toBe('system');
    });

    it('handles completion and awaitDone successfully', async () => {
      const syscall = new AgentSyscall({ name: 'agent.calc', payload: { expr: '2+2' } });
      syscall.markRunning();
      expect(syscall.status).toBe('running');

      syscall.markCompleted(4);
      expect(syscall.status).toBe('completed');
      expect(syscall.getLatencyMs()).toBeGreaterThanOrEqual(0);

      const res = await syscall.awaitDone();
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value).toBe(4);
      }
    });

    it('handles failure and awaitDone returning error', async () => {
      const syscall = new AgentSyscall({ name: 'agent.fail' });
      syscall.markRunning();
      syscall.markFailed('EPERM: Access denied');

      expect(syscall.status).toBe('failed');
      const res = await syscall.awaitDone();
      expect(res.isErr).toBe(true);
      if (res.isErr) {
        expect(res.error.message).toContain('Access denied');
      }
    });

    it('manages 4-tier priority queues correctly', () => {
      const queue = new AgentSyscallQueue();
      const sLow = new AgentSyscall({ name: 'low', priority: 'low' });
      const sHigh = new AgentSyscall({ name: 'high', priority: 'high' });
      const sBg = new AgentSyscall({ name: 'bg', priority: 'background' });
      const sNorm = new AgentSyscall({ name: 'norm', priority: 'normal' });

      queue.enqueue(sLow);
      queue.enqueue(sHigh);
      queue.enqueue(sBg);
      queue.enqueue(sNorm);

      expect(queue.getPendingCount()).toBe(4);

      expect(queue.dequeue()?.name).toBe('high');
      expect(queue.dequeue()?.name).toBe('norm');
      expect(queue.dequeue()?.name).toBe('low');
      expect(queue.dequeue()?.name).toBe('bg');
      expect(queue.getPendingCount()).toBe(0);
    });

    it('rejects pending syscalls on queue purge (T5 Requirement)', async () => {
      const queue = new AgentSyscallQueue();
      const s1 = new AgentSyscall({ name: 'sys1' });
      const s2 = new AgentSyscall({ name: 'sys2', priority: 'high' });

      // Attach promise handlers to prevent V8 unhandled rejection alerts
      const p1 = s1.awaitDone();
      const p2 = s2.awaitDone();

      queue.enqueue(s1);
      queue.enqueue(s2);

      const rejectCount = queue.rejectPending(new Error('EKILLED: Force killed'));
      expect(rejectCount).toBe(2);
      expect(queue.getPendingCount()).toBe(0);

      const res1 = await p1;
      expect(res1.isErr).toBe(true);
      if (res1.isErr) {
        expect(res1.error.message).toContain('Force killed');
      }

      const res2 = await p2;
      expect(res2.isErr).toBe(true);
      if (res2.isErr) {
        expect(res2.error.message).toContain('Force killed');
      }
    });
  });

  // -------------------------------------------------------------------
  // 2. ToolRegistry & Built-in Tools
  // -------------------------------------------------------------------
  describe('ToolRegistry & Permission Controls', () => {
    it('executes built-in echo tool', async () => {
      const registry = new ToolRegistry();
      const res = await registry.executeTool('echo', { message: 'Hello World' });
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value).toBe('Hello World');
      }
    });

    it('executes built-in calc tool safely', async () => {
      const registry = new ToolRegistry();
      const res = await registry.executeTool('calc', { expr: '(10 + 20) * 3' });
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value).toBe(90);
      }
    });

    it('rejects forbidden expressions in calc tool', async () => {
      const registry = new ToolRegistry();
      const res = await registry.executeTool('calc', { expr: 'process.exit()' });
      expect(res.isErr).toBe(true);
      if (res.isErr) {
        expect(res.error.message).toContain('EEXEC');
      }
    });

    it('executes built-in now tool', async () => {
      const registry = new ToolRegistry();
      const res = await registry.executeTool('now');
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value.timestamp).toBeGreaterThan(0);
        expect(typeof res.value.iso).toBe('string');
      }
    });

    it('enforces custom tool registration, ownership, and permissions', async () => {
      const registry = new ToolRegistry();

      const regRes = registry.registerTool({
        name: 'secret.vault',
        description: 'Access top secret data',
        owner: 'agent-1',
        requiredPermission: 'read:vault',
        handler: async (args) => `Decrypted: ${args.key}`
      });
      expect(regRes.isOk).toBe(true);

      // Attempt without permission
      const noPermRes = await registry.executeTool('secret.vault', { key: '123' });
      expect(noPermRes.isErr).toBe(true);
      if (noPermRes.isErr) {
        expect(noPermRes.error.message).toContain('EPERM');
      }

      // Attempt with permission
      const permRes = await registry.executeTool('secret.vault', { key: '123' }, {
        permissions: new Set(['read:vault'])
      });
      expect(permRes.isOk).toBe(true);
      if (permRes.isOk) {
        expect(permRes.value).toBe('Decrypted: 123');
      }
    });

    it('prevents unauthorized unregister or re-registration by different owner', () => {
      const registry = new ToolRegistry();
      registry.registerTool({
        name: 'protected.tool',
        description: 'Protected',
        owner: 'alice',
        handler: () => 'ok'
      });

      // Different owner registration fails
      const reReg = registry.registerTool({
        name: 'protected.tool',
        description: 'Hijack',
        owner: 'bob',
        handler: () => 'bad'
      });
      expect(reReg.isErr).toBe(true);

      // Different owner unregistration fails
      const unreg = registry.unregisterTool('protected.tool', 'bob');
      expect(unreg.isErr).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // 3. AgentRegistry
  // -------------------------------------------------------------------
  describe('AgentRegistry State Management & Serialization', () => {
    it('registers and manages agent state transitions', () => {
      const reg = new AgentRegistry();

      const res = reg.registerAgent({ id: 'ag-1', name: 'Analyst', role: 'finance' });
      expect(res.isOk).toBe(true);
      expect(reg.getAgent('ag-1')?.state).toBe('idle');

      reg.setState('ag-1', 'busy');
      expect(reg.getAgent('ag-1')?.state).toBe('busy');

      reg.markError('ag-1', 'OutOfMemoryError');
      expect(reg.getAgent('ag-1')?.state).toBe('error');
      expect(reg.getAgent('ag-1')?.lastError).toBe('OutOfMemoryError');
    });

    it('exports and imports agent registry state correctly', () => {
      const reg1 = new AgentRegistry();
      reg1.registerAgent({ id: 'ag-1', name: 'Agent 1', metadata: { zone: 'us-east' } });
      reg1.setState('ag-1', 'active');

      const exported = reg1.exportAll();
      expect(exported['ag-1'].name).toBe('Agent 1');
      expect(exported['ag-1'].state).toBe('active');

      const reg2 = new AgentRegistry();
      const importRes = reg2.importAll(exported);
      expect(importRes.isOk).toBe(true);
      expect(reg2.getAgent('ag-1')?.name).toBe('Agent 1');
      expect(reg2.getAgent('ag-1')?.metadata.zone).toBe('us-east');
    });
  });

  // -------------------------------------------------------------------
  // 4. LLM Core - Model Attribution (M2 Requirement)
  // -------------------------------------------------------------------
  describe('LLM Core - Model Attribution', () => {
    it('should return actual model name in LLMReply (OllamaBackend)', async () => {
      const backend = new OllamaBackend({ model: 'llama3.2' });
      const core = new LLMCore({ backends: [backend] });
      const result = await core.chat([{ role: 'user', content: 'test' }]);
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value.model).toBe('llama3.2');
      }
    });

    it('should return actual model name in LLMReply (Hermetic DeterministicBackend)', async () => {
      const backend = new DeterministicBackend({ name: 'mock-backend', model: 'deterministic-v1' });
      const core = new LLMCore({ backends: [backend] });
      const result = await core.chat([{ role: 'user', content: 'test' }]);
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value.model).toBe('deterministic-v1');
      }
    });
  });
});
