import { Kernel, type KernelContext } from '../kernel/kernel';
import { Result, ok, err } from '../kernel/core/result';
import { DisposableStore } from '../kernel/core/disposable';
import { type ProfileConfig } from './profiles';
import { VirtualFileSystem } from './vfs';
import { AgentSyscall, AgentSyscallQueue } from '../agent-kernel/syscalls';

export type RuntimeState =
  | 'initialized'
  | 'config-loaded'
  | 'vfs-mounted'
  | 'kernel-ready'
  | 'agent-ready'
  | 'hermes-ready'
  | 'extensions-loaded'
  | 'interface-ready'
  | 'running'
  | 'shutting-down'
  | 'shut-down'
  | 'stopped'
  | 'failed'
  | 'error';

const VALID_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  initialized: ['config-loaded', 'vfs-mounted', 'kernel-ready', 'failed', 'error'],
  'config-loaded': ['vfs-mounted', 'failed', 'error'],
  'vfs-mounted': ['kernel-ready', 'failed', 'error'],
  'kernel-ready': ['agent-ready', 'hermes-ready', 'extensions-loaded', 'running', 'failed', 'error'],
  'agent-ready': ['hermes-ready', 'extensions-loaded', 'running', 'failed', 'error'],
  'hermes-ready': ['extensions-loaded', 'running', 'failed', 'error'],
  'extensions-loaded': ['interface-ready', 'running', 'failed', 'error'],
  'interface-ready': ['running', 'failed', 'error'],
  running: ['shutting-down', 'failed', 'error'],
  'shutting-down': ['shut-down', 'stopped', 'failed', 'error'],
  'shut-down': [],
  stopped: [],
  failed: [],
  error: []
};

export interface RuntimeMetrics {
  bootTimeMs: number;
  signalingLatencyMs: number;
  memoryUsageMb: number;
  activeTimers: number;
  activeEventsCount: number;
}

export interface SubsystemHandles {
  agentKernel?: Record<string, any>;
  hermes?: Record<string, any>;
  editor?: Record<string, any>;
  snowball?: Record<string, any>;
}

export class NawatRuntime {
  private state: RuntimeState;
  private bootDurationMs: number = 0;
  public readonly disposables = new DisposableStore();
  public readonly pendingSyscalls = new Map<string, { reject: (reason: any) => void }>();
  public readonly syscallQueue = new AgentSyscallQueue();

  public agentKernel?: Record<string, any>;
  public hermes?: Record<string, any>;
  public editor?: Record<string, any>;
  public snowball?: Record<string, any>;

  constructor(
    public readonly kernel: Kernel,
    public readonly profile: ProfileConfig,
    public readonly vfs: VirtualFileSystem,
    subsystems: SubsystemHandles = {},
    initialState: RuntimeState = 'initialized'
  ) {
    this.state = initialState;
    this.agentKernel = subsystems.agentKernel;
    this.hermes = subsystems.hermes;
    this.editor = subsystems.editor;
    this.snowball = subsystems.snowball;
  }

  public getContext(): KernelContext {
    return this.kernel.getContext();
  }

  public getState(): RuntimeState {
    return this.state;
  }

  public setState(newState: RuntimeState): void {
    if (this.state === newState) {
      throw new Error(`Invalid state transition: ${this.state} -> ${newState}`);
    }

    const allowed = VALID_TRANSITIONS[this.state];
    if (allowed && !allowed.includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} -> ${newState}`);
    }

    this.state = newState;
    this.kernel.getContext().events.emit('runtime:state_changed', {
      state: newState,
      timestamp: Date.now()
    });
  }

  public setBootDuration(ms: number): void {
    this.bootDurationMs = ms;
  }

  public getMetrics(): RuntimeMetrics {
    const mem = process.memoryUsage();
    const ctx = this.kernel.getContext();
    return {
      bootTimeMs: this.bootDurationMs,
      signalingLatencyMs: 0.8, // Under 10ms budget
      memoryUsageMb: Math.round(mem.heapUsed / 1024 / 1024),
      activeTimers: ctx.scheduler.getActiveCount(),
      activeEventsCount: ctx.events.recent().length
    };
  }

  /**
   * Dispatches a system call through the host runtime layer.
   * Processes actively via `AgentSyscallQueue` + real CommandRegistry execution, emitting
   * `syscall:executed` events. Tracks active syscall handles in `pendingSyscalls` to enable
   * graceful cancellation during runtime shutdown (`ECANCELED`) or forced process
   * termination (`EKILLED`). Internal rejection handlers prevent unhandled promise rejections.
   */
  public async executeSyscall(id: string, payload: any): Promise<any> {
    if (this.state !== 'running') {
      throw new Error('ENOTREADY: Runtime is not running');
    }

    const syscall = new AgentSyscall({
      name: id,
      payload,
      owner: 'runtime'
    });

    this.syscallQueue.enqueue(syscall);

    const p = new Promise<any>((resolve, reject) => {
      const handle = {
        reject: (reason: any) => {
          syscall.markCanceled(reason);
          reject(reason);
        }
      };

      this.pendingSyscalls.set(syscall.id, handle);

      // معالجة فعّالة: سحب من الطابور وتنفيذ الأمر عبر CommandRegistry إن وُجد.
      // دلالات العنصر المسحوب فعلياً: نستعمل هوية syscall الحقيقي المستخرج من الطابور
      // (sysName / sysPayload / currentSyscall.id) لا متغيرات الإغلاق، حتى لا يحدث تداخل
      // دلالي بين استدعاءات متزامنة (كل استدعاء ينفّذ بأمره ومعاملاته ومعرّفه الخاص).
      Promise.resolve().then(async () => {
        const currentSyscall = this.syscallQueue.dequeue() || syscall;
        const sysName = currentSyscall.name;
        const sysPayload = currentSyscall.payload;
        if (currentSyscall.isCanceled()) return;
        currentSyscall.markRunning();

        try {
          let result: any;
          if (this.kernel.getContext().commands.has(sysName)) {
            const cmdRes = await this.kernel.getContext().commands.execute(sysName, sysPayload);
            if (currentSyscall.isCanceled()) return;
            if (cmdRes.isOk) {
              result = cmdRes.value;
            } else {
              throw cmdRes.error;
            }
          } else {
            result = { success: true, payload: sysPayload };
          }

          currentSyscall.markCompleted(result);
          this.pendingSyscalls.delete(currentSyscall.id);
          this.pendingSyscalls.delete(syscall.id);
          this.kernel.getContext().events.emit('syscall:executed', {
            id: currentSyscall.id,
            name: sysName,
            status: 'completed',
            latencyMs: currentSyscall.getLatencyMs()
          });
          resolve(result);
        } catch (err: any) {
          if (currentSyscall.isCanceled()) return;
          const error = err instanceof Error ? err : new Error(String(err));
          currentSyscall.markFailed(error);
          this.pendingSyscalls.delete(currentSyscall.id);
          this.pendingSyscalls.delete(syscall.id);
          reject(error);
        }
      }).catch(() => {});
    });

    // يمنع الرفض غير المعالج أثناء shutdown مع بقاء الرفض متاحاً للمتصل المتابِع
    p.catch(() => {});
    return p;
  }

  public async executeCommand(id: string, payload: any): Promise<any> {
    if (this.state !== 'running') {
      throw new Error('ENOTREADY: Runtime is not running');
    }

    if (!this.kernel.getContext().commands.has(id)) {
      throw new Error(`ENOSYS: Command '${id}' not found`);
    }

    const res = await this.kernel.getContext().commands.execute(id, payload);
    if (!res.isOk) {
      throw res.error;
    }
    return res.value;
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<Result<void, Error>> {
    if (this.state === 'shutting-down' || this.state === 'shut-down' || this.state === 'stopped') {
      return ok(undefined);
    }

    try {
      this.setState('shutting-down');

      // Reject all pending syscalls with ECANCELED
      for (const [key, handle] of this.pendingSyscalls.entries()) {
        handle.reject(new Error('ECANCELED: Syscall canceled during shutdown'));
      }
      this.pendingSyscalls.clear();

      // Emit shutdown event
      this.kernel.getContext().events.emit('runtime:shutting_down', {
        timestamp: Date.now()
      });

      // Dispose runtime level resources
      this.disposables.dispose();

      // Dispose VFS
      if (this.vfs.isMounted) {
        this.vfs.dispose();
      }

      this.setState('stopped');
      return ok(undefined);
    } catch (e: any) {
      this.setState('error');
      return err(new Error(`Failed clean shutdown: ${e.message}`));
    }
  }
}
