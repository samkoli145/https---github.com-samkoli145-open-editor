import { Result, ok, err } from '../kernel/core/result';

export type AgentSyscallPriority = 'high' | 'normal' | 'low' | 'background';
export type AgentSyscallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

export interface AgentSyscallOptions {
  id?: string;
  name: string;
  category?: string;
  priority?: AgentSyscallPriority;
  payload?: any;
  owner?: string;
  timeoutMs?: number;
}

export class AgentSyscall {
  public readonly id: string;
  public readonly name: string;
  public readonly category: string;
  public readonly priority: AgentSyscallPriority;
  public readonly payload: any;
  public readonly owner: string;
  public readonly createdAt: number;
  public readonly timeoutMs?: number;

  public status: AgentSyscallStatus = 'pending';
  public startedAt?: number;
  public completedAt?: number;
  public result?: any;
  public error?: Error;

  private resolveDone!: (value: any) => void;
  private rejectDone!: (reason: Error) => void;
  public readonly donePromise: Promise<any>;

  constructor(options: AgentSyscallOptions) {
    this.id = options.id || `sys_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this.name = options.name;
    this.category = options.category || 'system';
    this.priority = options.priority || 'normal';
    this.payload = options.payload ?? {};
    this.owner = options.owner || 'kernel';
    this.createdAt = Date.now();
    this.timeoutMs = options.timeoutMs;

    this.donePromise = new Promise<any>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // منع الرفض غير المعالج عند markCanceled/markFailed أثناء shutdown/forceKill
    this.donePromise.catch(() => {});
  }

  public markRunning(): void {
    if (this.status !== 'pending') return;
    this.status = 'running';
    this.startedAt = Date.now();
  }

  public markCompleted(res: any): void {
    if (this.status === 'canceled' || this.status === 'completed' || this.status === 'failed') return;
    this.status = 'completed';
    this.completedAt = Date.now();
    this.result = res;
    this.resolveDone(res);
  }

  public markFailed(error: Error | string): void {
    if (this.status === 'canceled' || this.status === 'completed' || this.status === 'failed') return;
    this.status = 'failed';
    this.completedAt = Date.now();
    this.error = typeof error === 'string' ? new Error(error) : error;
    this.rejectDone(this.error);
  }

  public markCanceled(reason: Error | string = 'ECANCELED: Syscall canceled'): void {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'canceled') return;
    this.status = 'canceled';
    this.completedAt = Date.now();
    this.error = typeof reason === 'string' ? new Error(reason) : reason;
    this.rejectDone(this.error);
  }

  public isCanceled(): boolean {
    return this.status === 'canceled';
  }

  public async awaitDone(): Promise<Result<any, Error>> {
    try {
      const res = await this.donePromise;
      return ok(res);
    } catch (e: any) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  public getLatencyMs(): number {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  public getTurnaroundMs(): number {
    const end = this.completedAt || Date.now();
    return Math.max(0, end - this.createdAt);
  }
}

export interface AgentSyscallQueueOptions {
  /** سقف عمق الطابور الكلي (ضغط الظهر): الإدراج يُرفض عند الامتلاء */
  readonly maxDepth?: number;
  /** عتبة التقدم بالعمر (ms): عنصر جاوزها يُخرج حتى لو كان بأولوية أدنى (منع التجويع) */
  readonly agingMs?: number;
}

const PRIORITIES: AgentSyscallPriority[] = ['high', 'normal', 'low', 'background'];

export class AgentSyscallQueue {
  private queues: Record<AgentSyscallPriority, AgentSyscall[]> = {
    high: [],
    normal: [],
    low: [],
    background: []
  };
  private readonly maxDepth: number;
  private readonly agingMs: number;

  constructor(options: AgentSyscallQueueOptions = {}) {
    this.maxDepth = options.maxDepth ?? Infinity;
    this.agingMs = options.agingMs ?? 5_000;
  }

  /** إدراج بضغط الظهر: يعيد false عند بلوغ السقف (EBUSY) دون إدراج */
  public enqueue(syscall: AgentSyscall): boolean {
    if (this.getPendingCount() >= this.maxDepth) return false;
    this.queues[syscall.priority].push(syscall);
    return true;
  }

  public isFull(): boolean {
    return this.getPendingCount() >= this.maxDepth;
  }

  public dequeue(): AgentSyscall | undefined {
    return this.pick(true);
  }

  public peek(): AgentSyscall | undefined {
    return this.pick(false);
  }

  /** اختيار متقدم بالعمر أولاً (FCFS بين المتقدمين)، ثم الأولوية الصارمة */
  private pick(remove: boolean): AgentSyscall | undefined {
    const now = Date.now();
    let oldestAged: AgentSyscall | undefined;
    let oldestAgedLevel: AgentSyscallPriority | undefined;
    for (const p of PRIORITIES) {
      const front = this.queues[p][0];
      if (front && now - front.createdAt >= this.agingMs) {
        if (!oldestAged || front.createdAt < oldestAged.createdAt) {
          oldestAged = front;
          oldestAgedLevel = p;
        }
      }
    }
    if (oldestAged && oldestAgedLevel) {
      return remove ? this.queues[oldestAgedLevel].shift() : oldestAged;
    }
    for (const p of PRIORITIES) {
      if (this.queues[p].length > 0) {
        return remove ? this.queues[p].shift() : this.queues[p][0];
      }
    }
    return undefined;
  }

  public getPendingCount(): number {
    return (
      this.queues.high.length +
      this.queues.normal.length +
      this.queues.low.length +
      this.queues.background.length
    );
  }

  public rejectPending(reason: Error = new Error('ECANCELED: Syscall canceled during queue purge')): number {
    let count = 0;
    for (const p of PRIORITIES) {
      while (this.queues[p].length > 0) {
        const syscall = this.queues[p].shift();
        if (syscall) {
          syscall.markCanceled(reason);
          count++;
        }
      }
    }
    return count;
  }

  public clear(): void {
    for (const p of PRIORITIES) {
      this.queues[p] = [];
    }
  }
}
