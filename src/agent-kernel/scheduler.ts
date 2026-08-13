import { AgentSyscall, AgentSyscallQueue, AgentSyscallPriority } from './syscalls';

export type SyscallHandler = (syscall: AgentSyscall) => Promise<unknown>;

export interface SyscallHandlers {
  llm?: SyscallHandler;
  tool?: SyscallHandler;
  storage?: SyscallHandler;
}

export type SchedulerMode = 'fifo' | 'rr';
export type SchedulerRoute = 'affinity' | 'least-loaded';

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
  /** عدد عمال كل نوع (افتراضي 1) */
  readonly workerCount?: number;
  /** سياسة التوجيه بين العمال: affinity (نفس العامل لنفس الوكيل) أو least-loaded (الأخف حملاً) */
  readonly route?: SchedulerRoute;
}

export interface SchedulerStats {
  active: boolean;
  mode: SchedulerMode;
  route: SchedulerRoute;
  workerCount: number;
  queued: number;
  queueDepth: Record<keyof SyscallHandlers, number>;
  workerDepth: Record<keyof SyscallHandlers, number[]>;
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
const DEFAULT_WORKERS = 1;

export class AgentScheduler {
  private queues: Record<keyof SyscallHandlers, AgentSyscallQueue[]>;
  private consuming: Record<keyof SyscallHandlers, boolean[]>;
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
  private readonly route: SchedulerRoute;
  private readonly workerCount: number;
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
    this.route = options.route ?? 'least-loaded';
    this.workerCount = Math.max(1, options.workerCount ?? DEFAULT_WORKERS);
    const queueOptions = {
      maxDepth: this.maxQueueDepth,
      agingMs: options.agingMs ?? DEFAULT_AGING_MS,
    };
    this.queues = {
      llm: Array.from({ length: this.workerCount }, () => new AgentSyscallQueue(queueOptions)),
      tool: Array.from({ length: this.workerCount }, () => new AgentSyscallQueue(queueOptions)),
      storage: Array.from({ length: this.workerCount }, () => new AgentSyscallQueue(queueOptions)),
    };
    this.consuming = {
      llm: Array.from({ length: this.workerCount }, () => false),
      tool: Array.from({ length: this.workerCount }, () => false),
      storage: Array.from({ length: this.workerCount }, () => false),
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

    let worker = this.selectWorker(agentName, type);
    let queue = this.queues[type][worker];
    if (queue.isFull()) {
      const fallback = this.queues[type].findIndex((q) => !q.isFull());
      if (fallback === -1) {
        syscall.markFailed(new Error(`EBUSY: Agent queue '${type}' is full (max ${this.maxQueueDepth} pending)`));
        return syscall;
      }
      worker = fallback;
      queue = this.queues[type][worker];
    }

    queue.enqueue(syscall);
    void this.consume(type, worker);
    return syscall;
  }

  /** توجيه الوكيل إلى عامل: affinity (تجزئة ثابتة) أو least-loaded (الأخف عمقاً) */
  selectWorker(agentName: string, type: keyof SyscallHandlers): number {
    const workers = this.queues[type];
    if (workers.length === 1) return 0;
    if (this.route === 'affinity') {
      return this.hashWorker(`${agentName}:${type}`, workers.length);
    }
    let best = 0;
    for (let i = 1; i < workers.length; i++) {
      if (workers[i].getPendingCount() < workers[best].getPendingCount()) best = i;
    }
    return best;
  }

  stats(): SchedulerStats {
    const sum = this.turnaroundSamples.reduce((a, b) => a + b, 0);
    const latencySum = this.latencySamples.reduce((a, b) => a + b, 0);
    const totalCompleted = Object.values(this.completedCount).reduce((a, b) => a + b, 0);
    const totalErrors = Object.values(this.errorCount).reduce((a, b) => a + b, 0);
    const elapsedSec = (Date.now() - this.startedAtMs) / 1000;
    const depthOf = (t: keyof SyscallHandlers) => this.queues[t].reduce((a, q) => a + q.getPendingCount(), 0);
    const depths = (t: keyof SyscallHandlers) => this.queues[t].map((q) => q.getPendingCount());
    return {
      active: this.active,
      mode: this.mode,
      route: this.route,
      workerCount: this.workerCount,
      queued: ALL_TYPES.reduce((a, t) => a + depthOf(t), 0),
      queueDepth: {
        llm: depthOf('llm'),
        tool: depthOf('tool'),
        storage: depthOf('storage'),
      },
      workerDepth: {
        llm: depths('llm'),
        tool: depths('tool'),
        storage: depths('storage'),
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
      for (const queue of this.queues[type]) queue.clear();
    }
  }

  start(): void {
    this.active = true;
  }

  private async consume(type: keyof SyscallHandlers, worker: number): Promise<void> {
    if (this.consuming[type][worker]) return;
    this.consuming[type][worker] = true;
    try {
      if (this.mode === 'rr') {
        await this.consumeRR(type, worker);
      } else {
        await this.consumeFIFO(type, worker);
      }
    } finally {
      this.consuming[type][worker] = false;
    }
  }

  private async consumeFIFO(type: keyof SyscallHandlers, worker: number): Promise<void> {
    const queue = this.queues[type][worker];
    while (this.active) {
      const syscall = queue.dequeue();
      if (!syscall) return;
      if (!this.active) {
        syscall.markCanceled(new Error('ECANCELED: scheduler stopped'));
        continue;
      }
      await this.runOne(type, syscall);
    }
  }

  private async consumeRR(type: keyof SyscallHandlers, worker: number): Promise<void> {
    const queue = this.queues[type][worker];
    while (this.active) {
      const batch: AgentSyscall[] = [];
      const seenAgents = new Set<string>();

      const guard = queue.getPendingCount() * 2 + this.batchSize + 1;
      for (let i = 0; i < guard; i++) {
        const front = queue.peek();
        if (!front) break;
        if (seenAgents.has(front.owner)) {
          const moved = queue.dequeue();
          if (moved) queue.enqueue(moved);
          continue;
        }
        const next = queue.dequeue();
        if (!next) break;
        batch.push(next);
        seenAgents.add(next.owner);
        if (batch.length >= this.batchSize) break;
      }

      if (batch.length === 0) {
        const first = queue.dequeue();
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

  private hashWorker(key: string, mod: number): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return hash % mod;
  }
}
