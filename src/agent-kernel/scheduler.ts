import { AgentSyscall, AgentSyscallQueue, AgentSyscallPriority } from './syscalls';

export type SyscallHandler = (syscall: AgentSyscall) => Promise<unknown>;

export interface SyscallHandlers {
  llm?: SyscallHandler;
  tool?: SyscallHandler;
  storage?: SyscallHandler;
}

export type SchedulerMode = 'fifo' | 'rr';

export interface AgentSchedulerOptions {
  readonly mode?: SchedulerMode;
  readonly batchSize?: number;
  readonly timeSliceMs?: number;
  readonly priority?: AgentSyscallPriority;
  /** سقف عمق طابور كل نوع (ضغط الظهر): رفض EBUSY عند الامتلاء */
  readonly maxQueueDepth?: number;
  /** عتبة التقدم بالعمر (ms): منع تجويع النداءات منخفضة الأولوية */
  readonly agingMs?: number;
  /** سقف التنفيذ المتوازي الكلي عبر كل الأنواع (حوض موحّد) */
  readonly maxConcurrentExec?: number;
}

export interface SchedulerStats {
  active: boolean;
  mode: SchedulerMode;
  queued: number;
  queueDepth: Record<keyof SyscallHandlers, number>;
  totalSubmitted: number;
  totalCompleted: number;
  totalErrors: number;
  avgTurnaroundMs: number;
  avgLatencyMs: number;
  throughputRps: number;
}

const ALL_TYPES: (keyof SyscallHandlers)[] = ['llm', 'tool', 'storage'];
const DEFAULT_BATCH = 4;
const DEFAULT_SLICE = 1_000;
const DEFAULT_MAX_QUEUE_DEPTH = 64;
const DEFAULT_AGING_MS = 5_000;

export class AgentScheduler {
  private queues: Record<keyof SyscallHandlers, AgentSyscallQueue>;
  private consuming: Record<keyof SyscallHandlers, boolean> = { llm: false, tool: false, storage: false };
  private completedCount = { llm: 0, tool: 0, storage: 0 };
  private errorCount = { llm: 0, tool: 0, storage: 0 };
  private turnaroundSamples: number[] = [];
  private latencySamples: number[] = [];
  private submittedCount = 0;
  private readonly mode: SchedulerMode;
  private readonly batchSize: number;
  private readonly timeSliceMs: number;
  private readonly priority: AgentSyscallPriority;
  private readonly maxConcurrentExec?: number;
  private readonly maxQueueDepth: number;
  private activeExec = 0;
  private execWaiters: (() => void)[] = [];
  private readonly startedAtMs = Date.now();

  active = true;

  constructor(
    private readonly handlers: SyscallHandlers = {},
    options: AgentSchedulerOptions = {},
  ) {
    this.mode = options.mode ?? 'fifo';
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.timeSliceMs = options.timeSliceMs ?? DEFAULT_SLICE;
    this.priority = options.priority ?? 'normal';
    this.maxConcurrentExec = options.maxConcurrentExec;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    const queueOptions = {
      maxDepth: this.maxQueueDepth,
      agingMs: options.agingMs ?? DEFAULT_AGING_MS,
    };
    this.queues = {
      llm: new AgentSyscallQueue(queueOptions),
      tool: new AgentSyscallQueue(queueOptions),
      storage: new AgentSyscallQueue(queueOptions),
    };
  }

  submit(
    agentName: string,
    type: keyof SyscallHandlers,
    query: Record<string, unknown>,
    priority?: AgentSyscallPriority,
  ): AgentSyscall {
    const syscall = new AgentSyscall({
      name: `agent.${type}.${String(query.op ?? 'exec')}`,
      category: type,
      payload: query,
      owner: agentName,
      priority: priority ?? this.priority,
    });
    this.submittedCount += 1;
    if (!this.queues[type].enqueue(syscall)) {
      syscall.markFailed(new Error(`EBUSY: Agent queue '${type}' is full (max ${this.maxQueueDepth} pending)`));
      return syscall;
    }
    void this.consume(type);
    return syscall;
  }

  stats(): SchedulerStats {
    const sum = this.turnaroundSamples.reduce((a, b) => a + b, 0);
    const latencySum = this.latencySamples.reduce((a, b) => a + b, 0);
    const totalCompleted = Object.values(this.completedCount).reduce((a, b) => a + b, 0);
    const totalErrors = Object.values(this.errorCount).reduce((a, b) => a + b, 0);
    const elapsedSec = (Date.now() - this.startedAtMs) / 1000;
    return {
      active: this.active,
      mode: this.mode,
      queued: ALL_TYPES.reduce((a, t) => a + this.queues[t].getPendingCount(), 0),
      queueDepth: {
        llm: this.queues.llm.getPendingCount(),
        tool: this.queues.tool.getPendingCount(),
        storage: this.queues.storage.getPendingCount(),
      },
      totalSubmitted: this.submittedCount,
      totalCompleted,
      totalErrors,
      avgTurnaroundMs: this.turnaroundSamples.length === 0 ? 0 : sum / this.turnaroundSamples.length,
      avgLatencyMs: this.latencySamples.length === 0 ? 0 : latencySum / this.latencySamples.length,
      throughputRps: elapsedSec > 0 ? totalCompleted / elapsedSec : 0,
    };
  }

  stop(): void {
    this.active = false;
    for (const type of ALL_TYPES) {
      this.queues[type].clear();
    }
  }

  start(): void {
    this.active = true;
  }

  private async consume(type: keyof SyscallHandlers): Promise<void> {
    if (this.consuming[type]) return;
    this.consuming[type] = true;
    try {
      if (this.mode === 'rr') {
        await this.consumeRR(type);
      } else {
        await this.consumeFIFO(type);
      }
    } finally {
      this.consuming[type] = false;
    }
  }

  private async consumeFIFO(type: keyof SyscallHandlers): Promise<void> {
    while (this.active) {
      const syscall = this.queues[type].dequeue();
      if (!syscall) return;
      if (!this.active) {
        syscall.markCanceled(new Error('ECANCELED: scheduler stopped'));
        continue;
      }
      await this.runOne(type, syscall);
    }
  }

  private async consumeRR(type: keyof SyscallHandlers): Promise<void> {
    while (this.active) {
      const batch: AgentSyscall[] = [];
      const seenAgents = new Set<string>();

      const guard = this.queues[type].getPendingCount() * 2 + this.batchSize + 1;
      for (let i = 0; i < guard; i++) {
        const front = this.queues[type].peek();
        if (!front) break;
        if (seenAgents.has(front.owner)) {
          const moved = this.queues[type].dequeue();
          if (moved) this.queues[type].enqueue(moved);
          continue;
        }
        const next = this.queues[type].dequeue();
        if (!next) break;
        batch.push(next);
        seenAgents.add(next.owner);
        if (batch.length >= this.batchSize) break;
      }

      if (batch.length === 0) {
        const first = this.queues[type].dequeue();
        if (!first) return;
        if (!this.active) {
          first.markCanceled(new Error('ECANCELED: scheduler stopped'));
          continue;
        }
        batch.push(first);
      }

      await Promise.allSettled(batch.map((syscall) => this.runOne(type, syscall)));
    }
  }

  private async runOne(type: keyof SyscallHandlers, syscall: AgentSyscall): Promise<void> {
    await this.acquireExecSlot();
    try {
      const handler = this.handlers[type];
      syscall.markRunning();
      try {
        if (!handler) {
          throw new Error(`ENOSYS: no handler for '${type}'`);
        }
        const result = await handler(syscall);
        syscall.markCompleted(result);
        this.completedCount[type] += 1;
        this.turnaroundSamples.push(syscall.getTurnaroundMs());
        this.latencySamples.push(syscall.getLatencyMs());
      } catch (e: any) {
        const message = e instanceof Error ? e.message : String(e);
        syscall.markFailed(message);
        this.errorCount[type] += 1;
      }
    } finally {
      this.releaseExecSlot();
    }
  }

  /** حوض موحّد: حجز فتحة تنفيذ عبر كل الأنواع إن ضبط maxConcurrentExec */
  private async acquireExecSlot(): Promise<void> {
    if (this.maxConcurrentExec === undefined) return;
    while (this.activeExec >= this.maxConcurrentExec) {
      await new Promise<void>((resolve) => this.execWaiters.push(resolve));
    }
    this.activeExec += 1;
  }

  private releaseExecSlot(): void {
    if (this.maxConcurrentExec === undefined) return;
    this.activeExec -= 1;
    this.execWaiters.shift()?.();
  }
}
