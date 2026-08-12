import { Result, ok, err } from '../kernel/core/result';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResourceProbe {
  getAvailableVramMb(): Promise<number>;
  getModelSizeMb(modelName: string, baseUrl: string): Promise<number>;
}

/**
 * مسبار الموارد الافتراضي.
 * يطبق خطة التراجع (Fallback Passive Mode): إذا فشل nvidia-smi، يعود لوضع آمن بدون تعطيل النواة.
 */
export class DefaultResourceProbe implements ResourceProbe {
  async getAvailableVramMb(): Promise<number> {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=memory.free',
        '--format=csv,noheader,nounits'
      ]);
      const freeMb = parseInt(stdout.trim().split('\n')[0], 10);
      return isNaN(freeMb) ? 8192 : freeMb; // Fallback to 8GB safe estimate
    } catch {
      // Fallback Passive Mode: No GPU detected or nvidia-smi failed
      return 8192;
    }
  }

  async getModelSizeMb(modelName: string, baseUrl: string): Promise<number> {
    try {
      const res = await fetch(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });
      if (!res.ok) return 0; // النموذج غير موجود أو غير معروف — بلا دليل، لا يُمنع
      const data = (await res.json()) as any;
      const sizeBytes = typeof data?.size === 'number' ? data.size : 0;
      return Math.ceil(sizeBytes / (1024 * 1024));
    } catch {
      return 0; // بلا دليل (شبكة/خدمة) — لا نرفض حدساً، سيُعالج الخطأ عند chat نفسه
    }
  }
}

/**
 * قفل استدلال أحادي (Inference Mutex) لمنع قمم الذروة (VRAM Spikes).
 * طلب واحد نشط فقط؛ الباقي ينتظر في طابور بمهلة، يتجاوزها يعيد ERR_INFERENCE_BUSY.
 */
export class InferenceMutex {
  private isLocked = false;
  private queue: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  async acquire(timeoutMs = 30000): Promise<() => void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: {
        resolve: (release: () => void) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      } = {
        resolve: (releaseFn: () => void) => {
          clearTimeout(entry.timer);
          resolve(releaseFn);
        },
        reject: (err: Error) => {
          clearTimeout(entry.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) {
            this.queue.splice(index, 1);
            entry.reject(new Error('ERR_INFERENCE_BUSY: inference slot timeout exceeded'));
          }
        }, timeoutMs)
      };
      this.queue.push(entry);
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.isLocked = true; // Still locked, but handed over to next in queue
      next?.resolve(() => this.release());
    } else {
      this.isLocked = false;
    }
  }
}

export interface InferenceGovernorOptions {
  vramSafetyMargin?: number; // Default: 0.85 (leave 15% for OS/KDE Plasma)
  idleTimeoutMs?: number;    // Default: 300000 (5 minutes)
  baseUrl?: string;
}

export class InferenceGovernor {
  private probe: ResourceProbe;
  private mutex: InferenceMutex;
  private options: Required<InferenceGovernorOptions>;
  private activeModel: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(probe: ResourceProbe, options: InferenceGovernorOptions = {}) {
    this.probe = probe;
    this.mutex = new InferenceMutex();
    this.options = {
      vramSafetyMargin: options.vramSafetyMargin ?? 0.85,
      idleTimeoutMs: options.idleTimeoutMs ?? 300000,
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:11434'
    };
  }

  /** ② & ③ فحص الـ VRAM وقفل الاستدلال المتزامن */
  async acquireInferenceSlot(modelName: string): Promise<Result<() => void, Error>> {
    const availableVram = await this.probe.getAvailableVramMb();
    const safeThreshold = availableVram * this.options.vramSafetyMargin;
    const modelSize = await this.probe.getModelSizeMb(modelName, this.options.baseUrl);

    if (modelSize > 0 && modelSize > safeThreshold) {
      return err(new Error(`ERR_VRAM_OVERFLOW: Model '${modelName}' (~${modelSize}MB) exceeds safe VRAM threshold (${safeThreshold}MB)`));
    }

    try {
      const release = await this.mutex.acquire(30000);
      this.activeModel = modelName;
      this.resetIdleTimer();
      return ok(release);
    } catch (e: any) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** ④ سياسة تفريغ النموذج بعد الخمول */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.forceUnloadModel();
    }, this.options.idleTimeoutMs);
  }

  private async forceUnloadModel(): Promise<void> {
    if (!this.activeModel) return;
    try {
      await fetch(`${this.options.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.activeModel, keep_alive: 0 })
      });
      console.log(`[InferenceGovernor] Force unloaded idle model: ${this.activeModel}`);
    } catch {
      // Ignore unload errors (passive governance)
    } finally {
      this.activeModel = null;
    }
  }

  /** معامل keep_alive المُمرَّر لـ OllamaBackend (دورة حياة النموذج في الذاكرة) */
  public getKeepAliveParam(): string {
    return `${Math.floor(this.options.idleTimeoutMs / 60000)}m`;
  }
}
