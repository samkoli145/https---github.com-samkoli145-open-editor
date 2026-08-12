import { Result, ok, err } from '../../kernel/core/result';
import { BaseSystemEngine, SystemEngineConfig } from './base-engine';
import { PersistentIndexer, VFSFileIndexEntry } from '../vfs/persistent-indexer';
import { sanitizePath } from '../vfs/path-sanitizer';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';

export interface ExecutionRequest {
  path: string;
  args?: string[];
  uid?: number;
  gid?: number;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Production Execution Sandbox Engine.
 * Replaces LLM refusal subjectivity with deterministic POSIX permission checking,
 * checksum verification, and isolated execution bounds.
 *
 * §5-م: التنفيذ الفعلي موجَّه إلى `LinuxArchExecutionLayer` (الطبقة الأرشية)
 * بدلاً من الرسالة الجاهزة — التحقق الحتمي (بوابات POSIX/الفهرس) يبقى بوابة
 * قبلية، ثم يُنفَّذ الأمر داخل جذر التنفيذ عبر بوابات الطبقة (allowlist →
 * حصص → عزل أهداف → ELF/shebang).
 */
export class ExecutionSandboxEngine extends BaseSystemEngine {
  private indexer: PersistentIndexer;
  private execLayer: LinuxArchExecutionLayer;
  private execRoot: string;
  private allowedBinaries = new Set<string>(['node', 'ts-node', 'git', 'npm', 'vitest', 'bash', 'python3']);

  constructor(config: SystemEngineConfig & { indexer?: PersistentIndexer; execLayer?: LinuxArchExecutionLayer; execRoot?: string }) {
    super(config);
    this.indexer = config.indexer || new PersistentIndexer();
    this.execRoot = config.execRoot ?? process.cwd();
    this.execLayer = config.execLayer ?? new LinuxArchExecutionLayer({
      defaultAgentId: 'sandbox',
      execRoot: this.execRoot,
      allowedBinaries: [...this.allowedBinaries]
    });
  }

  protected onInitialize(): void {
    // Engine initialization
  }

  protected onDispose(): void {
    // Cleanup allocated resources
  }

  /**
   * Evaluates if a file is safe and authorized for execution without relying on LLM subjectivity.
   */
  public verifyExecutionRights(req: ExecutionRequest): Result<VFSFileIndexEntry, Error> {
    const sanitizeRes = sanitizePath(req.path, this.indexer.rootDir);
    if (!sanitizeRes.isOk) {
      return err(new Error(`ESECURITY_VIOLATION: Execution path violation: ${sanitizeRes.error.message}`));
    }

    const entryRes = this.indexer.getEntry(req.path);
    if (!entryRes.isOk) {
      return err(new Error(`ENOENT: Cannot execute missing binary or script '${req.path}'`));
    }

    const entry = entryRes.value;

    // 1. POSIX Permission Mode Check (Must have executable bit set e.g. 0o755)
    if (!entry.isExecutable && (entry.mode & 0o111) === 0) {
      return err(new Error(`EPERM: Permission denied. File '${req.path}' lacks POSIX executable flag (mode 0o${entry.mode.toString(8)})`));
    }

    // 2. UID / GID Ownership Gate
    const callerUid = req.uid ?? 1000;
    if (entry.uid !== 0 && entry.uid !== callerUid && callerUid !== 0) {
      return err(new Error(`EACCES: User ID ${callerUid} is not authorized to execute binary owned by UID ${entry.uid}`));
    }

    return ok(entry);
  }

  /**
   * Executes script or binary through the arch execution layer (LinuxArchExecutionLayer)
   * inside the sandbox execution root, after the deterministic POSIX gate.
   */
  public async execute(req: ExecutionRequest): Promise<Result<ExecutionResult, Error>> {
    const rightsCheck = this.verifyExecutionRights(req);
    if (!rightsCheck.isOk) {
      return err(rightsCheck.error);
    }

    const startTime = performance.now();
    const entry = rightsCheck.value;

    if (/\s/.test(req.path)) {
      return err(new Error(`ESECURITY: Execution path '${req.path}' contains whitespace and cannot be dispatched by the arch layer`));
    }

    const args = (req.args ?? []).filter((a) => !/\s/.test(a));
    if (args.length !== (req.args?.length ?? 0)) {
      return err(new Error(`ESECURITY: Execution arguments contain whitespace and cannot be dispatched by the arch layer`));
    }

    const commandLine = [req.path, ...args].join(' ');

    try {
      const outcome = await this.execLayer.execute({
        commandLine,
        cwd: this.execRoot,
        env: req.env,
        timeoutMs: 10000,
        agentId: 'sandbox'
      });

      const durationMs = performance.now() - startTime;

      if (outcome.status === 'success') {
        return ok({
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          exitCode: outcome.exitCode ?? 0,
          durationMs: Math.round((durationMs + outcome.executionTimeMs) / 2)
        });
      }

      const code = outcome.status === 'not_found' ? 'ENOENT' : outcome.status === 'timeout' ? 'ETIMEDOUT' : 'ESECURITY';
      return err(new Error(`${code}: Execution of '${entry.path}' was not permitted by the arch layer: ${outcome.reason ?? outcome.status}`));
    } catch (e: any) {
      return err(new Error(`EEXEC_FAIL: Execution of '${req.path}' failed: ${e.message}`));
    }
  }

  public allowBinary(binName: string): void {
    this.allowedBinaries.add(binName);
  }
}
