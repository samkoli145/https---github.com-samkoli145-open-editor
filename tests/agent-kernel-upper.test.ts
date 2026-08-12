import { describe, it, expect } from 'vitest';
import { AgentKernel, Kernel, DeterministicBackend, AgentScheduler, ok } from '../src/index';

describe('النواة العليا المستقلة (AgentKernel) — طبقة خامسة', () => {
  it('يقلع ويوقف: boot/shutdown مع مكونات كاملة', async () => {
    const kernel = new AgentKernel({
      backends: [new DeterministicBackend({ defaultResponse: 'أهلًا' })],
    });
    expect(kernel.getState()).toBe('idle');
    const boot = await kernel.boot();
    expect(boot.isOk).toBe(true);
    if (boot.isOk) {
      expect(boot.value.tools).toBeGreaterThanOrEqual(3);
      expect(boot.value.llmModels).toBe(1);
    }
    expect(kernel.getState()).toBe('running');
    await kernel.shutdown();
    expect(kernel.getState()).toBe('stopped');
  });

  it('executeSyscall قبل الإقلاع يُرجع ENOTREADY', async () => {
    const kernel = new AgentKernel();
    const res = await kernel.executeSyscall('agent.llm.chat', { messages: [{ role: 'user', content: 'x' }] });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('ENOTREADY');
  });

  it('أمر مجهول يُرجع ENOSYS', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const res = await kernel.executeSyscall('agent.nope.run');
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('ENOSYS');
    await kernel.shutdown();
  });

  it('المسار المجدول: llm.chat عبر AgentScheduler ويعيد المحتوى والنموذج', async () => {
    const kernel = new AgentKernel({
      backends: [new DeterministicBackend({ defaultResponse: 'رد حتمي' })],
    });
    await kernel.boot();
    const res = await kernel.executeSyscall('agent.llm.chat', {
      messages: [{ role: 'user', content: 'مرحبًا' }],
    });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      const v = res.value as { content: string; model: string };
      expect(v.content).toBe('رد حتمي');
      expect(v.model).toBe('deterministic-v1');
    }
    const stats = kernel.scheduler.stats();
    expect(stats.totalCompleted).toBe(1);
    await kernel.shutdown();
  });

  it('المسار المجدول: tool.list وtool.call عبر بوابة الأدوات', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const list = await kernel.executeSyscall('agent.tool.list');
    expect(list.isOk).toBe(true);
    if (list.isOk) expect((list.value as { name: string }[]).some((t) => t.name === 'calc')).toBe(true);

    const call = await kernel.executeSyscall('agent.tool.call', { name: 'calc', args: { expr: '2 + 3' } });
    expect(call.isOk).toBe(true);
    if (call.isOk) expect(call.value).toBe(5);
    await kernel.shutdown();
  });

  it('بوابة الأدوات: رفض tool.call بأداة ممنوعة في سياسة الوكيل', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    kernel.access.setPolicy('agent-x', { allowAllTools: true, deniedTools: ['calc'] });
    const res = await kernel.executeSyscall('agent.tool.call', {
      agentName: 'agent-x',
      name: 'calc',
      args: { expr: '1 + 1' },
    });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('EPERM');
    await kernel.shutdown();
  });

  it('مسار الإدارة: registry.register/list/get عبر المسار السريع', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const reg = await kernel.executeSyscall('agent.registry.register', {
      params: { id: 'writer', name: 'كاتب', role: 'assistant' },
    });
    expect(reg.isOk).toBe(true);
    const list = await kernel.executeSyscall('agent.registry.list');
    expect(list.isOk).toBe(true);
    if (list.isOk) expect((list.value as { id: string }[]).some((a) => a.id === 'writer')).toBe(true);
    const get = await kernel.executeSyscall('agent.registry.get', { id: 'writer' });
    expect(get.isOk).toBe(true);
    if (get.isOk) expect((get.value as { role: string }).role).toBe('assistant');
    await kernel.shutdown();
  });

  it('بوابة الأوامر: رفض command في deny list من سياسة الوكيل', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    kernel.access.setPolicy('agent-y', { deniedCommands: ['agent.storage.list'] });
    const res = await kernel.executeSyscall('agent.storage.list', { agentName: 'agent-y' });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('EPERM');
    await kernel.shutdown();
  });

  it('مسار الإدارة: agent.quota.usage يستجيب بعد set', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const set = await kernel.executeSyscall('agent.quota.set', {
      agentId: 'agent-q',
      quota: { maxSyscallsPerMinute: 3 },
    });
    expect(set.isOk).toBe(true);
    const usage = await kernel.executeSyscall('agent.quota.usage', { agentId: 'agent-q' });
    expect(usage.isOk).toBe(true);
    if (usage.isOk) expect((usage.value as { syscallCount: number }).syscallCount).toBe(0);
    await kernel.shutdown();
  });

  it('مسار الإدارة: agent.session.create/get/list/close', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const created = await kernel.executeSyscall('agent.session.create', { id: 's1', ownerAgent: 'agent-1' });
    expect(created.isOk).toBe(true);
    const got = await kernel.executeSyscall('agent.session.get', { id: 's1' });
    expect(got.isOk).toBe(true);
    const closed = await kernel.executeSyscall('agent.session.close', { id: 's1' });
    expect(closed.isOk).toBe(true);
    await kernel.shutdown();
  });

  it('المحركات المدارة: engine.list وengine.call بعقد النواة العليا', async () => {
    const kernel = new AgentKernel();
    const engine = {
      name: 'demo-engine',
      title: { ar: 'محرك تجريبي', en: 'Demo engine' },
      call: async (op: string, args: unknown) => ok({ op, args }),
      status: () => ({ active: true }),
    };
    expect(kernel.registerEngine(engine).isOk).toBe(true);
    expect(kernel.registerEngine(engine).isErr).toBe(true); // EEXIST
    await kernel.boot();
    const list = await kernel.executeSyscall('agent.engine.list');
    expect(list.isOk).toBe(true);
    if (list.isOk) expect((list.value as { name: string }[]).some((e) => e.name === 'demo-engine')).toBe(true);
    const call = await kernel.executeSyscall('agent.engine.call', { engine: 'demo-engine', op: 'ping', args: { a: 1 } });
    expect(call.isOk).toBe(true);
    if (call.isOk) expect(call.value).toEqual({ op: 'ping', args: { a: 1 } });
    const missing = await kernel.executeSyscall('agent.engine.call', { engine: 'ghost', op: 'ping' });
    expect(missing.isErr).toBe(true);
    if (missing.isErr) expect(missing.error.message).toContain('ENOENT');
    await kernel.shutdown();
  });

  it('agent.kernel.status يعكس حالة النواة العليا', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const res = await kernel.executeSyscall('agent.kernel.status');
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      const s = res.value as { state: string; tools: number; engines: string[] };
      expect(s.state).toBe('running');
      expect(s.tools).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(s.engines)).toBe(true);
    }
    await kernel.shutdown();
  });

  it('attach يسجّل أوامر agent.* في سجل نواة النظام (مسار العقد)', async () => {
    const kernel = new AgentKernel({
      backends: [new DeterministicBackend({ defaultResponse: 'عبر العقد' })],
    });
    await kernel.boot();
    const pKernel = new Kernel();
    kernel.attach(pKernel);
    const ctx = pKernel.getContext();
    expect(ctx.commands.has('agent.llm.chat')).toBe(true);
    expect(ctx.commands.has('agent.registry.list')).toBe(true);
    expect(ctx.commands.has('agent.kernel.status')).toBe(true);
    expect(ctx.commands.has('agent.scheduler.stats')).toBe(true);
    expect(ctx.commands.has('agent.llm.models')).toBe(true);

    const chatRes = await ctx.commands.execute('agent.llm.chat', {
      messages: [{ role: 'user', content: 'مرحبًا' }],
    });
    expect(chatRes.isOk).toBe(true);
    if (chatRes.isOk) expect((chatRes.value as { content: string }).content).toBe('عبر العقد');
    await kernel.shutdown();
  });

  it('العميل يسجّل أثرًا تلقائيًا (ensureAgent) ويرصد خطأ عند الرفض', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const res = await kernel.executeSyscall('agent.tool.call', {
      agentName: 'silent-client',
      name: 'ghost-tool',
      args: {},
    });
    expect(res.isErr).toBe(true);
    const record = kernel.registry.getAgent('silent-client');
    expect(record).toBeDefined();
    if (record) {
      expect(record.state).toBe('error');
      expect(record.lastError).toBeDefined();
    }
    await kernel.shutdown();
  });

  it('مسار التخزين عبر بوابة النظام: write/read', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    const write = await kernel.executeSyscall('agent.storage.write', { key: 'demo/key-1', value: { ok: true } });
    expect(write.isOk).toBe(true);
    const read = await kernel.executeSyscall('agent.storage.read', { key: 'demo/key-1' });
    expect(read.isOk).toBe(true);
    if (read.isOk) expect(read.value).toEqual({ ok: true });
    await kernel.shutdown();
  });

  it('إيقاف المجدول يمنع التنفيذ ويُنهي بلا أخطاء', async () => {
    const kernel = new AgentKernel();
    await kernel.boot();
    await kernel.shutdown();
    const res = await kernel.executeSyscall('agent.llm.chat', { messages: [{ role: 'user', content: 'x' }] });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('ENOTREADY');
  });

  it('AgentScheduler وضع RR بعدالة بين الوكلاء', async () => {
    const order: string[] = [];
    const sched = new AgentScheduler(
      {
        llm: async (sc) => {
          order.push(sc.owner);
          return `ok-${sc.owner}`;
        },
      },
      { mode: 'rr', batchSize: 2 },
    );
    sched.start();
    const a = sched.submit('alice', 'llm', { op: 'chat' });
    const b = sched.submit('bob', 'llm', { op: 'chat' });
    await Promise.all([a.awaitDone(), b.awaitDone()]);
    expect(new Set(order)).toEqual(new Set(['alice', 'bob']));
    sched.stop();
  });
});
