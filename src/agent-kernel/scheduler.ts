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
}

export interface SchedulerStats {
  active: boolean;
  mode: SchedulerMode;
  queued: number;
  totalSubmitted: number;
  totalCompleted: number;
  totalErrors: number;
  avgTurnaroundMs: number;
}

const ALL_TYPES: (keyof SyscallHandlers)[] = ['llm', 'tool', 'storage'];
const DEFAULT_BATCH = 4;
const DEFAULT_SLICE = 1_000;

export class AgentScheduler {
  private queues: Record<keyof SyscallHandlers, AgentSyscallQueue> = {
    llm: new AgentSyscallQueue(),
    tool: new AgentSyscallQueue(),
    storage: new AgentSyscallQueue(),
  };
  private consuming: Record<keyof SyscallHandlers, boolean> = { llm: false, tool: false, storage: false };
  private completedCount = { llm: 0, tool: 0, storage: 0 };
  private errorCount = { llm: 0, tool: 0, storage: 0 };
  private turnaroundSamples: number[] = [];
  private submittedCount = 0;
  private readonly mode: SchedulerMode;
  private readonly batchSize: number;
  private readonly timeSliceMs: number;
  private readonly priority: AgentSyscallPriority;

  active = true;

  constructor(
    private readonly handlers: SyscallHandlers = {},
    options: AgentSchedulerOptions = {},
  ) {
    this.mode = options.mode ?? 'fifo';
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.timeSliceMs = options.timeSliceMs ?? DEFAULT_SLICE;
    this.priority = options.priority ?? 'normal';
  }

  submit(agentName: string, type: keyof SyscallHandlers, query: Record<string, unknown>): AgentSyscall {
    const syscall = new AgentSyscall({
      name: `agent.${type}.${String(query.op ?? 'exec')}`,
      category: type,
      payload: query,
      owner: agentName,
      priority: this.priority,
    });
    this.submittedCount += 1;
    this.queues[type].enqueue(syscall);
    void this.consume(type);
    return syscall;
  }

  stats(): SchedulerStats {
    const sum = this.turnaroundSamples.reduce((a, b) => a + b, 0);
    const totalCompleted = Object.values(this.completedCount).reduce((a, b) => a + b, 0);
    const totalErrors = Object.values(this.errorCount).reduce((a, b) => a + b, 0);
    return {
      active: this.active,
      mode: this.mode,
      queued: ALL_TYPES.reduce((a, t) => a + this.queues[t].getPendingCount(), 0),
      totalSubmitted: this.submittedCount,
      totalCompleted,
      totalErrors,
      avgTurnaroundMs: this.turnaroundSamples.length === 0 ? 0 : sum / this.turnaroundSamples.length,
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
    const handler = this.handlers[type];
    syscall.markRunning();
    try {
      if (!handler) {
        throw new Error(`ENOSYS: no handler for '${type}'`);
      }
      const result = await handler(syscall);
      syscall.markCompleted(result);
      this.completedCount[type] += 1;
      this.turnaroundSamples.push(syscall.getLatencyMs());
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      syscall.markFailed(message);
      this.errorCount[type] += 1;
    }
  }
}
