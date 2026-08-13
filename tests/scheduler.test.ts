import { describe, it, expect, vi } from 'vitest';
import { AgentScheduler } from '../src/agent-kernel/scheduler';
import { AgentSyscall, AgentSyscallQueue } from '../src/agent-kernel/syscalls';

describe('AgentScheduler — توزيع العمل AIOS', () => {
  describe('ضغط الظهر (طوابير محدودة + EBUSY)', () => {
    it('يرفض EBUSY نداءً يتجاوز سقف عمق طابور النوع', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const sched = new AgentScheduler(
        {
          tool: async () => {
            await gate;
            return 'ok';
          },
        },
        { maxQueueDepth: 2 },
      );
      sched.start();

      // a يُسحب فوراً ويركض (محجوب بالبوابة)؛ b وc ينتظران؛ d يفيض (max 2)
      const a = sched.submit('alice', 'tool', { op: 'call' });
      const b = sched.submit('bob', 'tool', { op: 'call' });
      const c = sched.submit('carol', 'tool', { op: 'call' });
      const d = sched.submit('dave', 'tool', { op: 'call' });

      const resD = await d.awaitDone();
      expect(resD.isErr).toBe(true);
      if (resD.isErr) expect(resD.error.message).toContain('EBUSY');
      release();
      await Promise.all([a.awaitDone(), b.awaitDone(), c.awaitDone()]);
      sched.stop();
    });

    it('AgentSyscallQueue.enqueue يعيد false عند الامتلاء ولا يُدرج', () => {
      const queue = new AgentSyscallQueue({ maxDepth: 1 });
      const first = new AgentSyscall({ name: 'a' });
      const second = new AgentSyscall({ name: 'b' });
      expect(queue.enqueue(first)).toBe(true);
      expect(queue.enqueue(second)).toBe(false);
      expect(queue.getPendingCount()).toBe(1);
    });
  });

  describe('منع التجويع (aging)', () => {
    it('نداء background قديم يُخرج قبل نداء high حديث (FCFS بين المتقدمين)', () => {
      const queue = new AgentSyscallQueue({ agingMs: 30 });
      const staleBg = new AgentSyscall({ name: 'old-bg', priority: 'background' });
      queue.enqueue(staleBg);

      const now = Date.now();
      while (Date.now() - now < 35) {
        // انتظار نشيط قصير لتجاوز عتبة aging بشكل حتمي
      }

      const freshHigh = new AgentSyscall({ name: 'new-high', priority: 'high' });
      queue.enqueue(freshHigh);

      expect(queue.dequeue()?.name).toBe('old-bg');
      expect(queue.dequeue()?.name).toBe('new-high');
    });

    it('مجدول بأولوية منخفضة لكل submit يمنع تجويع high بفعل aging', async () => {
      vi.useFakeTimers();
      try {
        const order: string[] = [];
        const sched = new AgentScheduler(
          {
            llm: async (sc) => {
              order.push(sc.name);
              return 'done';
            },
          },
          { mode: 'fifo', priority: 'high', agingMs: 50 },
        );
        sched.start();

        const low = sched.submit('alice', 'llm', { op: 'chat' }, 'low');
        vi.advanceTimersByTime(60);
        const high = sched.submit('bob', 'llm', { op: 'chat' }, 'high');

        await Promise.all([low.awaitDone(), high.awaitDone()]);
        expect(order[0]).toBe('agent.llm.chat');
        sched.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('الحوض الموحّد (maxConcurrentExec)', () => {
    it('لا يتجاوز سقف التنفيذ المتوازي عبر كل الأنواع', async () => {
      let peak = 0;
      let current = 0;
      const handler = async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 20));
        current -= 1;
        return 'done';
      };

      const sched = new AgentScheduler(
        { llm: handler, tool: handler, storage: handler },
        { maxConcurrentExec: 2 },
      );
      sched.start();

      const all = [
        sched.submit('a', 'llm', { op: 'chat' }),
        sched.submit('b', 'tool', { op: 'call' }),
        sched.submit('c', 'storage', { op: 'read' }),
        sched.submit('d', 'llm', { op: 'chat' }),
      ];
      await Promise.all(all.map((s) => s.awaitDone()));
      expect(peak).toBeLessThanOrEqual(2);
      sched.stop();
    });
  });

  describe('المقاييس (queueDepth / avgLatencyMs / throughputRps)', () => {
    it('يصدر إحصائيات عمق طابور لكل نوع، كمون فعلي، وإنتاجية', async () => {
      const sched = new AgentScheduler(
        {
          llm: async () => {
            await new Promise((r) => setTimeout(r, 20));
            return 'ok';
          },
        },
        { maxQueueDepth: 8 },
      );
      sched.start();

      const first = sched.submit('alice', 'llm', { op: 'chat' });
      const queued = sched.submit('bob', 'llm', { op: 'chat' });
      const statsWhileQueued = sched.stats();
      expect(statsWhileQueued.queueDepth.llm).toBeGreaterThanOrEqual(1);

      await Promise.all([first.awaitDone(), queued.awaitDone()]);
      const stats = sched.stats();
      expect(stats.totalCompleted).toBe(2);
      expect(stats.totalErrors).toBe(0);
      expect(stats.avgLatencyMs).toBeGreaterThan(0);
      expect(stats.avgTurnaroundMs).toBeGreaterThanOrEqual(stats.avgLatencyMs);
      expect(stats.throughputRps).toBeGreaterThan(0);
      sched.stop();
    });
  });
});
