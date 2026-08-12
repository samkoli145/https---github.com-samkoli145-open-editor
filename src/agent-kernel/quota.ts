import { Result, ok, err } from '../kernel/core/result';

export interface ResourceQuota {
  maxMemoryBytes?: number;
  maxSyscallsPerMinute?: number;
  maxErrorThreshold?: number;
  maxExecutionTimeMs?: number;
  /** سقف العمليات المتزامنة لكل وكيل (pids.max — منع Fork-Bomb) */
  maxChildProcesses?: number;
  /** سقف استهلاك ذاكرة الكارت (VRAM) المدمج مع InferenceGovernor */
  maxVramUsageMb?: number;
  /** حد الاستدلالات المتزامنة (مدمج مع InferenceMutex) */
  maxConcurrentInference?: number;
}

export interface AgentResourceUsage {
  agentId: string;
  memoryBytes: number;
  syscallCount: number;
  errorCount: number;
  /** العمليات المتزامنة النشطة حالياً لهذا الوكيل (pids.max) */
  activeProcesses: number;
  lastResetAt: number;
}

/**
 * Resource Quota & Hard Termination Guard (AIOS / Cgroups / OOM Killer equivalent).
 * Prevents rogue agents from depleting system memory or hanging in infinite execution loops.
 */
export class ResourceQuotaGuard {
  private quotas = new Map<string, ResourceQuota>();
  private usageMap = new Map<string, AgentResourceUsage>();

  private defaultQuota: ResourceQuota = {
    maxMemoryBytes: undefined, // حاكم الذاكرة اختياري: لا حد افتراضي كي لا يكسر أعباء العمل الحقيقية
    maxSyscallsPerMinute: 120,
    maxErrorThreshold: 10,
    maxExecutionTimeMs: 10000,
    maxChildProcesses: 10
  };

  public setQuota(agentId: string, quota: ResourceQuota): void {
    this.quotas.set(agentId, { ...this.defaultQuota, ...quota });
  }

  public getUsage(agentId: string): AgentResourceUsage {
    let usage = this.usageMap.get(agentId);
    if (!usage) {
      usage = {
        agentId,
        memoryBytes: 0,
        syscallCount: 0,
        errorCount: 0,
        activeProcesses: 0,
        lastResetAt: Date.now()
      };
      this.usageMap.set(agentId, usage);
    }

    // Auto-reset rate limit counter every 60s
    if (Date.now() - usage.lastResetAt > 60000) {
      usage.syscallCount = 0;
      usage.lastResetAt = Date.now();
    }

    return usage;
  }

  /** حجز فتحة عملية متزامنة (pids.max): رفض فوري عند بلوغ سقف الأبناء النشطين */
  public acquireProcessSlot(agentId: string): Result<void, Error> {
    const quota = this.quotas.get(agentId) || this.defaultQuota;
    const usage = this.getUsage(agentId);

    if (quota.maxChildProcesses !== undefined && usage.activeProcesses >= quota.maxChildProcesses) {
      return err(new Error(`EAGAIN: Agent '${agentId}' reached maximum concurrent processes limit (${quota.maxChildProcesses})`));
    }

    usage.activeProcesses++;
    return ok(undefined);
  }

  /** تحرير فتحة العملية بعد خروجها (في finally مهما حدث) */
  public releaseProcessSlot(agentId: string): void {
    const usage = this.getUsage(agentId);
    usage.activeProcesses = Math.max(0, usage.activeProcesses - 1);
  }

  public trackSyscall(agentId: string): Result<void, Error> {
    const quota = this.quotas.get(agentId) || this.defaultQuota;
    const usage = this.getUsage(agentId);

    usage.syscallCount++;

    if (quota.maxSyscallsPerMinute && usage.syscallCount > quota.maxSyscallsPerMinute) {
      return err(new Error(`EQUOTA_EXCEEDED: Agent '${agentId}' exceeded max syscall rate limit (${quota.maxSyscallsPerMinute}/min)`));
    }

    return ok(undefined);
  }

  public trackMemory(agentId: string, bytesUsed: number): Result<void, Error> {
    const quota = this.quotas.get(agentId) || this.defaultQuota;
    const usage = this.getUsage(agentId);

    usage.memoryBytes = bytesUsed;

    if (quota.maxMemoryBytes && usage.memoryBytes > quota.maxMemoryBytes) {
      return err(new Error(`EOM: Agent '${agentId}' exceeded maximum allowed memory budget (${quota.maxMemoryBytes} bytes)`));
    }

    return ok(undefined);
  }

  public trackError(agentId: string): Result<void, Error> {
    const quota = this.quotas.get(agentId) || this.defaultQuota;
    const usage = this.getUsage(agentId);

    usage.errorCount++;

    if (quota.maxErrorThreshold && usage.errorCount >= quota.maxErrorThreshold) {
      return err(new Error(`EKILLED: Agent '${agentId}' terminated due to exceeding error threshold (${quota.maxErrorThreshold})`));
    }

    return ok(undefined);
  }

  /** حصة الاستدلال: رفض طلب يتجاوز سقف VRAM المعيَّن للوكيل (لا يؤثر على السلوك الافتراضي) */
  public checkInferenceQuota(agentId: string, vramMb: number): Result<void, Error> {
    const quota = this.quotas.get(agentId) || this.defaultQuota;
    if (quota.maxVramUsageMb && vramMb > quota.maxVramUsageMb) {
      return err(new Error(`EVRAM_QUOTA: Agent '${agentId}' requested ${vramMb}MB VRAM exceeding quota (${quota.maxVramUsageMb}MB)`));
    }
    return ok(undefined);
  }

  public reset(agentId: string): void {
    this.usageMap.delete(agentId);
  }
}
