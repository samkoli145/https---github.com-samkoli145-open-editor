/**
 * نَوَاة — LinuxArchExecutionLayer (طبقة تنفيذ أوامر النظام وملفات ELF كأنها نواة Arch Linux)
 *
 * قبل أي تنفيذ تمر الأوامر ببوابات أمان إلزامية:
 *   1) قيود code-domain (ConstraintEngine + CODE_DOMAIN_PROFILE) + قواعد أرش للحماية.
 *   2) قائمة الأدوات المسموحة (allowlist) — أو تحقق ELF للمسارات المباشرة.
 *   3) حصص quota.ts (ResourceQuotaGuard: معدل syscalls / زمن / أخطاء).
 *   4) تحقق المسار (sanitizePath) وتوقيع ELF وبت التنفيذ.
 * ثم تنفيذ حقيقي عبر child_process.execFile بدون shell.
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

import type { LocalizedString } from '../kernel/i18n/localized-string';
import { ConstraintEngine, type ConstraintRule } from './intelligence/constraint-engine';
import { CODE_DOMAIN_PROFILE } from './logic/domains/code-domain';
import { ResourceQuotaGuard, type ResourceQuota } from './quota';
import { parseShebang, inspectElfHeader, type ElfHeaderInfo } from '../system/vfs/file-type-detector';
import { sanitizePath } from '../system/vfs/path-sanitizer';

export interface LinuxCommandRequest {
  commandLine: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  agentId?: string;
  /** خفض أولوية CPU (niceness 0..19) عبر renice على العملية الحية */
  niceLevel?: number;
}

export interface ParsedCommand {
  toolName: string;
  subCommand?: string;
  flags: string[];
  targets: string[];
}

export type LinuxArchStatus = 'success' | 'blocked' | 'timeout' | 'not_found' | 'error';

export interface LinuxCommandResult {
  command: string;
  status: LinuxArchStatus;
  verdict: 'allowed' | 'denied';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  parsedTool: ParsedCommand;
  reason?: string;
  warnings: string[];
  niceLevel?: number;
  quota?: { agentId: string; syscallCount: number; errorCount: number; budgetMs: number };
  summary: LocalizedString;
}

export interface LinuxArchExecutionLayerOptions {
  allowedBinaries?: string[];
  authorizedSignatures?: string[];
  forbiddenGeneralInterpreters?: string[];
  extraRules?: ConstraintRule[];
  defaultAgentId?: string;
  constraintEngine?: ConstraintEngine;
  quotaGuard?: ResourceQuotaGuard;
  maxExecutionTimeMs?: number;
  execRoot?: string;
  rejectHiddenFiles?: boolean;
  enforceExecRoot?: boolean;
  rejectSetuidSetgid?: boolean;
  isolateAbsoluteTargets?: boolean;
  /** خفض أولوية CPU الافتراضي لكل الأوامر (niceness 0..19) — يطبّق عبر renice */
  niceLevel?: number;
}

/**
 * المفسِّرات العامة: أدوات «مُطلِقة عامة» بلا غرض محدّد — يُحظَر تنفيذها
 * بمسار مطلق حتى لو كان ELF سليماً داخل جذر التنفيذ (فئة LOLBins:
 * bash/sh/python/node... تُستغل كبوابة تنفيذ تعسفي).
 */
export const FORBIDDEN_GENERAL_INTERPRETERS = [
  'bash', 'sh', 'dash', 'ash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish',
  'python', 'python2', 'python3', 'pypy', 'node', 'nodejs', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua', 'luajit', 'tclsh', 'expect',
];

export interface LinuxArchRecord {
  request: LinuxCommandRequest;
  parsedTool: ParsedCommand;
  status: LinuxArchStatus;
  verdict: 'allowed' | 'denied';
  reason?: string;
  /** جذر التنفيذ الفعلي (execRoot أو cwd أو مجلد العمل) — كسجل تدقيق بنمط auditd */
  effectiveRoot?: string;
  timestamp: number;
}

export const DEFAULT_ALLOWED_BINARIES = [
  'ls', 'pwd', 'echo', 'printf', 'cat', 'whoami', 'id', 'uname', 'arch', 'date', 'uptime',
  'df', 'du', 'free', 'stat', 'file', 'which', 'env', 'hostname', 'nproc',
  'grep', 'rg', 'ripgrep', 'find', 'tree', 'sed', 'awk', 'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'yes',
  'xargs', 'tee', 'paste', 'comm', 'seq', 'shuf', 'md5sum', 'sha256sum', 'bc', 'jq', 'readlink', 'mktemp', 'timeout',
  'node', 'npm', 'npx', 'bun', 'tsc', 'ts-node', 'python3', 'python', 'cargo', 'rustc', 'gcc', 'g++', 'clang', 'git', 'make', 'go',
  'systemctl', 'journalctl', 'systemd-analyze', 'ps', 'top', 'htop', 'kill', 'pgrep', 'pkill',
  'pacman', 'curl', 'wget', 'tar', 'unzip', 'gzip', 'gunzip', 'xz', 'zstd', 'zip',
  'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'chmod', 'ln', 'realpath', 'dirname', 'basename', 'diff',
  'xdg-open', 'ffmpeg', 'notify-send', 'wmctrl',
  'code', 'code-oss', 'code-insiders', 'code-server'
];

/**
 * أوامر مدمجة في الصدفة وليست ملفات ثنائية (cd/export/source...):
 * تغيير الحالة (CWD/env/مصادر) يجب أن يُدار على مستوى الجلسة لا عبر تنفيذ أوامر.
 */
export const SHELL_BUILTINS = new Set(['cd', 'export', 'source', '.', 'alias', 'eval', 'exec']);

const ARCH_SAFETY_RULES: ConstraintRule[] = [
  { id: 'arch_no_rm_force', expression: 'REGEX:^rm\\s+-[rR]+f', severity: 'block', reason: 'Deleting with force recursion is prohibited' },
  { id: 'arch_no_rm_preserve', expression: 'REGEX:--no-preserve-root', severity: 'block', reason: '--no-preserve-root is prohibited' },
  { id: 'arch_no_format', expression: 'REGEX:^mkfs', severity: 'block', reason: 'Block device formatting is prohibited' },
  { id: 'arch_no_dd', expression: 'REGEX:^dd\\s+if=', severity: 'block', reason: 'Raw device writes via dd are prohibited' },
  { id: 'arch_no_poweroff', expression: 'REGEX:^(shutdown|reboot|poweroff|halt)\\b', severity: 'block', reason: 'System power management commands are prohibited' },
  { id: 'arch_no_systemctl_power', expression: 'REGEX:^systemctl\\s+(poweroff|reboot|halt|suspend|hibernate)\\b', severity: 'block', reason: 'Power management via systemctl is prohibited' },
  { id: 'arch_no_pacman_remove', expression: 'REGEX:^pacman\\s+-R', severity: 'block', reason: 'Package removal via pacman is prohibited' },
  { id: 'arch_no_chown_root', expression: 'REGEX:^chown\\s+(root|0)\\b', severity: 'block', reason: 'Ownership escalation to root is prohibited' },
  { id: 'arch_no_privilege', expression: 'REGEX:^(sudo|su|chroot)\\b', severity: 'block', reason: 'Privilege escalation or chroot is prohibited' },
  { id: 'arch_no_rm_parent_traversal', expression: 'REGEX:^rm\\s+.*\\.\\./', severity: 'block', reason: 'Parent directory traversal deletion is prohibited' },
  { id: 'arch_no_rm_wildcard', expression: 'REGEX:^rm\\s+.*\\*', severity: 'block', reason: 'Wildcard deletion (rm *) is prohibited' },
  { id: 'arch_no_rm_root', expression: 'REGEX:^rm\\s+.*(^|\\s)/(\\s|$)', severity: 'block', reason: 'Deleting the root directory (/) is prohibited' },
  { id: 'arch_no_dd_raw', expression: 'REGEX:^dd\\s+.*\\bof=/dev/(sd|hd|vd|nvme|loop|mmcblk|mem|kmem)', severity: 'block', reason: 'Raw block device writes via dd are prohibited' },
  { id: 'arch_no_curl_pipe_shell', expression: 'REGEX:curl.*\\|\\s*(ba)?sh', severity: 'block', reason: 'Piping curl output to shell is a security risk' },
  { id: 'arch_no_wget_pipe_shell', expression: 'REGEX:wget.*\\|\\s*(ba)?sh', severity: 'block', reason: 'Piping wget output to shell is a security risk' }
];

export class LinuxArchExecutionLayer {
  private readonly defaultAgentId: string;
  private readonly allowedBinaries: string[];
  private readonly authorizedSignatures: string[];
  private readonly constraintEngine: ConstraintEngine;
  private readonly quotaGuard: ResourceQuotaGuard;
  private readonly maxExecutionTimeMs: number;
  private readonly execRoot?: string;
  private readonly rejectHiddenFiles: boolean;
  private readonly enforceExecRoot: boolean;
  private readonly rejectSetuidSetgid: boolean;
  private readonly isolateAbsoluteTargets: boolean;
  private readonly forbiddenGeneralInterpreters: Set<string>;
  private readonly niceLevel: number;
  private readonly records: LinuxArchRecord[] = [];

  constructor(options: LinuxArchExecutionLayerOptions = {}) {
    this.defaultAgentId = options.defaultAgentId ?? 'linux';
    this.allowedBinaries = options.allowedBinaries ?? [...DEFAULT_ALLOWED_BINARIES];
    this.authorizedSignatures = options.authorizedSignatures ?? [];
    this.forbiddenGeneralInterpreters = new Set(
      options.forbiddenGeneralInterpreters ?? FORBIDDEN_GENERAL_INTERPRETERS
    );
    this.constraintEngine = options.constraintEngine ?? new ConstraintEngine();
    this.quotaGuard = options.quotaGuard ?? new ResourceQuotaGuard();
    this.maxExecutionTimeMs = options.maxExecutionTimeMs ?? 10000;
    this.execRoot = options.execRoot;
    this.rejectHiddenFiles = options.rejectHiddenFiles ?? false;
    this.enforceExecRoot = options.enforceExecRoot ?? true;
    this.rejectSetuidSetgid = options.rejectSetuidSetgid ?? true;
    this.isolateAbsoluteTargets = options.isolateAbsoluteTargets ?? true;
    this.niceLevel = Math.min(19, Math.max(0, options.niceLevel ?? 0));

    for (const rule of [...CODE_DOMAIN_PROFILE.defaultConstraints, ...ARCH_SAFETY_RULES, ...(options.extraRules ?? [])]) {
      this.constraintEngine.addRule(rule);
    }
  }

  public parseCommand(commandLine: string): ParsedCommand {
    const tokens = commandLine.trim().split(/\s+/);
    const toolName = tokens[0] || 'sh';
    let subCommand: string | undefined;
    const flags: string[] = [];
    const targets: string[] = [];

    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('-')) {
        flags.push(token);
      } else if (!subCommand && i === 1 && !token.startsWith('/') && !token.includes('/')) {
        subCommand = token;
      } else {
        targets.push(token);
      }
    }

    return { toolName, subCommand, flags, targets };
  }

  /**
   * اكتشاف البرامج (بروح binfmt): يفحص مسارات بحث عن ثنائيات قابلة للتنفيذ
   * (ELF أو سكربت بمفسر مسموح) دون تنفيذها. السكربتات التي تشير لمفسر غير
   * مسموح تُستبعد، وأي مسار خارج جذر التنفيذ يُتجاهل.
   */
  public async discoverPrograms(searchPaths: string[]): Promise<string[]> {
    const discovered: string[] = [];
    for (const path of searchPaths) {
      try {
        const resolvedPath = realpathSync(path);
        if (this.execRoot && !resolvedPath.startsWith(this.execRoot)) continue;

        const entries = readdirSync(resolvedPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          const fullPath = join(resolvedPath, entry.name);
          const inspection = this.inspectPath(fullPath);
          if (!inspection.exists || !inspection.executable) continue;
          if (inspection.kind !== 'elf' && inspection.kind !== 'script') continue;
          if (inspection.kind === 'script' && inspection.interpreter) {
            const interpreterProgram = parseShebang(inspection.interpreter).program;
            if (!this.allowedBinaries.includes(interpreterProgram)) continue;
          }
          discovered.push(entry.name);
        }
      } catch {
        // تجاهل المسارات غير الموجودة أو غير المصرح بها
      }
    }
    return [...new Set(discovered)];
  }

  public setQuota(agentId: string, quota: ResourceQuota): void {
    this.quotaGuard.setQuota(agentId, quota);
  }

  public getQuotaGuard(): ResourceQuotaGuard {
    return this.quotaGuard;
  }

  public async execute(request: LinuxCommandRequest): Promise<LinuxCommandResult> {
    const started = Date.now();
    const agentId = request.agentId ?? this.defaultAgentId;
    const parsed = this.parseCommand(request.commandLine);
    const warnings: string[] = [];

    const denied = (
      status: LinuxArchStatus,
      reason: string,
      verdict: 'allowed' | 'denied' = 'denied'
    ): LinuxCommandResult => {
      const executionTimeMs = Date.now() - started;
      const rootBase = this.execRoot ?? (request.cwd ? resolve(request.cwd) : process.cwd());
      let effectiveRoot = rootBase;
      try {
        effectiveRoot = realpathSync(rootBase);
      } catch {
        effectiveRoot = resolve(rootBase);
      }
      this.records.push({ request, parsedTool: parsed, status, verdict, reason, effectiveRoot, timestamp: started });
      return this.buildResult(request, parsed, status, verdict, null, '', '', executionTimeMs, reason, warnings, agentId);
    };

    const constraintResult = this.constraintEngine.evaluate(request.commandLine, { name: parsed.toolName, args: parsed });
    warnings.push(...constraintResult.warnings);

    if (constraintResult.isBlocked) {
      const rule = constraintResult.violatedRule;
      return denied('blocked', `DENIED by ${rule?.id}: ${rule?.reason}`);
    }

    // أوامر الصدفة المدمجة (cd/export/source/...): تغيير الحالة يُدار على مستوى الجلسة لا عبر تنفيذ أوامر
    if (SHELL_BUILTINS.has(parsed.toolName)) {
      return denied('blocked', `EPERM_SHELL_BUILTIN: '${parsed.toolName}' is a shell builtin; state changes must be managed at session level`);
    }

    const looksLikePath = parsed.toolName.includes('/') || parsed.toolName.startsWith('.');
    if (!looksLikePath && !this.allowedBinaries.includes(parsed.toolName)) {
      return denied('blocked', `EPERM: tool '${parsed.toolName}' is not in the Arch execution allowlist`);
    }

    const syscallRes = this.quotaGuard.trackSyscall(agentId);
    if (syscallRes.isErr) {
      return denied('blocked', syscallRes.error.message);
    }

    // حجز فتحة عملية متزامنة (pids.max): رفض فوري عند بلوغ سقف الأبناء النشطين
    const slotRes = this.quotaGuard.acquireProcessSlot(agentId);
    if (slotRes.isErr) {
      return denied('blocked', slotRes.error.message);
    }

    try {
    const budgetMs = Math.max(1, Math.min(request.timeoutMs ?? this.maxExecutionTimeMs, this.maxExecutionTimeMs));

    // عزل نظامي (فجوة س): جذر تنفيذ إلزامي — root = execRoot إن حُدّد، وإلا cwd الطلب، وإلا مجلد العمل الحالي.
    let effectiveRoot: string;
    const rootBase = this.execRoot ?? (request.cwd ? resolve(request.cwd) : process.cwd());
    try {
      effectiveRoot = realpathSync(rootBase);
    } catch {
      effectiveRoot = resolve(rootBase);
    }
    const rootPrefix = effectiveRoot.endsWith('/') ? effectiveRoot : `${effectiveRoot}/`;

    let cwd: string | undefined;
    if (request.cwd) {
      const sanitized = sanitizePath(request.cwd, '/');
      if (sanitized.isErr) {
        return denied('blocked', sanitized.error.message);
      }
      if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
        return denied('error', `ENOENT: working directory '${request.cwd}' does not exist`);
      }
      if (this.enforceExecRoot) {
        const cwdReal = realpathSync(request.cwd);
        if (cwdReal !== effectiveRoot && !cwdReal.startsWith(rootPrefix)) {
          return denied('blocked', `ESECURITY: working directory '${request.cwd}' is outside the execution root`);
        }
      }
      cwd = request.cwd;
    } else if (this.enforceExecRoot) {
      // بدون cwd: يُنفَّذ داخل جذر التنفيذ لا داخل مجلد عمل الخادم.
      cwd = effectiveRoot;
    }

    // عزل الأهداف (data-domain): منع الأوامر المسموحة من لمس مسارات خارج الجذر — المطلقة
    // (cat /etc/shadow · rm /etc/x) والنسبية العابرة عبر `..` (cat ../etc/passwd من عمق داخل
    // الجذر) — بينما تبقى النسبية داخل الجذر مسموحة.
    if (this.isolateAbsoluteTargets) {
      for (const target of parsed.targets) {
        const isAbsolute = target.startsWith('/');
        const isRelativeEscape = !isAbsolute && target.split('/').includes('..');
        if (!isAbsolute && !isRelativeEscape) continue;
        const candidate = isAbsolute ? target : resolve(cwd ?? effectiveRoot, target);
        let resolved: string;
        try {
          resolved = realpathSync(candidate);
        } catch {
          resolved = resolve(candidate);
        }
        if (resolved !== effectiveRoot && !resolved.startsWith(rootPrefix)) {
          return denied('blocked', `ESECURITY: target '${target}' resolves outside the execution root`);
        }
      }
    }

    let execPath = parsed.toolName;
    let elfReason: string | undefined;

    if (looksLikePath) {
      const targetPath = resolve(cwd ?? process.cwd(), parsed.toolName);
      const sanitized = sanitizePath(targetPath, '/');
      if (sanitized.isErr) {
        return denied('blocked', sanitized.error.message);
      }
      if (this.containsControlChars(parsed.toolName)) {
        return denied('blocked', 'ESECURITY: path contains hidden/control characters (zero-width or bidi override)');
      }
      const inspected = this.inspectPath(targetPath);
      if (!inspected.exists) {
        return denied('not_found', `ENOENT: program '${parsed.toolName}' does not exist`);
      }
      if (inspected.kind === 'dir') {
        return denied('blocked', `EPERM: '${parsed.toolName}' is a directory`);
      }
      if (inspected.kind === 'special') {
        return denied('blocked', `EPERM: '${parsed.toolName}' is not a regular file (device/socket/fifo)`);
      }
      if (this.rejectSetuidSetgid && inspected.privileged) {
        return denied(
          'blocked',
          `ESECURITY: '${parsed.toolName}' is setuid/setgid (mode 0o${inspected.mode.toString(8)}): privilege escalation is prohibited`
        );
      }

      const effectivePath = inspected.realPath ?? targetPath;

      if (this.rejectHiddenFiles && parsed.toolName.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
        return denied('blocked', `EPERM: '${parsed.toolName}' is a hidden file (dotfile) and rejectHiddenFiles is enabled`);
      }

      if (!this.withinExecRoot(effectivePath, cwd)) {
        return denied('blocked', `ESECURITY: '${parsed.toolName}' resolves outside the execution root (symlink or path escape)`);
      }

      if (!inspected.executable) {
        return denied('blocked', `EPERM: '${parsed.toolName}' has no executable bit set`);
      }

      // حظر المفسِّرات العامة حتى بمسار مطلق سليم (فئة LOLBins): يُفحص اسم الملف النهائي
      // بغضّ النظر عن المسار الكامل — فـ /bin/bash و/usr/bin/python3 و/usr/bin/node هي
      // «مُطلقات عامة» لا أدوات محددة الغرض، وتمريرها كمسار لا يعفيها من allowlist.
      const basename = effectivePath.split('/').pop() ?? parsed.toolName;
      if (this.forbiddenGeneralInterpreters.has(basename)) {
        return denied(
          'blocked',
          `EPERM: '${parsed.toolName}' is a general interpreter ('${basename}') and is forbidden from direct path execution (LOLBin hardening)`
        );
      }

      if (inspected.kind === 'script') {
        const program = inspected.interpreter ? parseShebang(inspected.interpreter).program : '';
        if (!program) {
          return denied('blocked', `EPERM: '${parsed.toolName}' has an empty shebang line`);
        }
        if (!this.allowedBinaries.includes(program)) {
          return denied('blocked', `EPERM: shebang interpreter '${program}' is not in the Arch execution allowlist`);
        }
      } else if (inspected.kind === 'data') {
        const reasonDetail = inspected.elfInfo?.reason ? ` (${inspected.elfInfo.reason})` : '';
        return denied('blocked', `EPERM: '${parsed.toolName}' is an unknown binary format or invalid ELF${reasonDetail}`);
      }

      if (this.authorizedSignatures.length > 0) {
        try {
          const content = readFileSync(effectivePath);
          const hash = createHash('sha256').update(content).digest('hex');
          if (!this.authorizedSignatures.includes(hash)) {
            return denied('blocked', `ESECURITY: binary checksum '${hash.slice(0, 12)}...' is not in authorizedSignatures allowlist`);
          }
        } catch {
          return denied('error', `ENOENT: failed to read binary '${parsed.toolName}' for signature verification`);
        }
      }

      // TOCTOU mitigation: re-verify target path immediately before execution
      try {
        const postCheckReal = realpathSync(effectivePath);
        const postCheckStat = statSync(postCheckReal);
        if (postCheckReal !== effectivePath || (postCheckStat.mode & 0o111) === 0) {
          return denied('blocked', `ESECURITY: TOCTOU vulnerability detected - target binary '${parsed.toolName}' changed state or path between inspection and execution`);
        }
      } catch {
        return denied('error', `ENOENT: program '${parsed.toolName}' mutated or disappeared prior to spawn`);
      }

      execPath = effectivePath;
    }

    const tokens = request.commandLine.trim().split(/\s+/);
    const args = tokens.slice(1);

    // عزل البيئة (execve-style): ندمج بيئة الطلب فوق بيئة المضيف ثم نُزيل متغيرات
    // التسريب الخطرة (LD_PRELOAD/LD_LIBRARY_PATH/NODE_OPTIONS) — لا بيئة نظيفة
    // كاملة كي لا تُكسر حالات التشغيل الحقيقية (xdg-open يحتاج DISPLAY، git يحتاج HOME).
    const safeEnv: NodeJS.ProcessEnv = { ...process.env, ...request.env };
    delete safeEnv.LD_PRELOAD;
    delete safeEnv.LD_LIBRARY_PATH;
    delete safeEnv.NODE_OPTIONS;

    const niceLevel = Math.min(19, Math.max(0, request.niceLevel ?? this.niceLevel));

    const outcome = await this.spawnCommand(execPath, args, {
      timeout: budgetMs,
      cwd,
      env: safeEnv,
      niceLevel
    });

    const { stdout, stderr, exitCode, status, reason } = outcome;

    // حاكم الذاكرة (memory.max): احتساب بصمة التنفيذ عبر حجم حائل المخرجات.
    // يبقى اختيارياً (maxMemoryBytes غير محدد افتراضياً) — لا يُقيّد أعباء العمل الحقيقية.
    const outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const memRes = this.quotaGuard.trackMemory(agentId, outputBytes);
    if (memRes.isErr) {
      return denied('blocked', memRes.error.message);
    }

    if (status === 'error' || status === 'timeout') {
      const errorRes = this.quotaGuard.trackError(agentId);
      if (errorRes.isErr) {
        warnings.push(errorRes.error.message);
      }
    }

    const executionTimeMs = Date.now() - started;
    this.records.push({ request, parsedTool: parsed, status, verdict: 'allowed', reason, effectiveRoot, timestamp: started });

    return this.buildResult(request, parsed, status, 'allowed', exitCode, stdout, stderr, executionTimeMs, reason, warnings, agentId, budgetMs, niceLevel);
    } finally {
      this.quotaGuard.releaseProcessSlot(agentId);
    }
  }

  public getHistory(): LinuxCommandRequest[] {
    return this.records.map((record) => record.request);
  }

  public getRecords(): LinuxArchRecord[] {
    return [...this.records];
  }

  private async spawnCommand(
    execPath: string,
    args: string[],
    options: { timeout: number; cwd?: string; env: NodeJS.ProcessEnv; niceLevel?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; status: LinuxArchStatus; reason?: string }> {
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let status: LinuxArchStatus = 'success';
    let reason: string | undefined;

    try {
      await new Promise<void>((resolvePromise) => {
        const onExit = (
          error: any,
          out: string | Buffer,
          errOut: string | Buffer
        ) => {
          stdout = String(out);
          stderr = String(errOut);
          if (error) {
            const code = (error as any).code;
            if (code === 'ETIMEDOUT' || (error as any).killed === true) {
              status = 'timeout';
              reason = `ETIMEDOUT: killed after ${options.timeout}ms (quota maxExecutionTimeMs)`;
            } else if (code === 'ENOENT') {
              status = 'not_found';
              reason = `ENOENT: binary '${execPath}' not found on host`;
            } else if (typeof code === 'number') {
              status = 'error';
              exitCode = code;
              reason = `process exited with code ${code}`;
            } else {
              status = 'error';
              reason = code ? `${code}: ${error.message}` : error.message;
            }
          } else {
            exitCode = 0;
          }
          resolvePromise();
        };

        const nice = options.niceLevel ?? 0;
        if (nice > 0) {
          // niceness (خفض أولوية CPU) + kill زمني يقتل مجموعة العملية كلها (منع الأيتام)
          const child = spawn(execPath, args, {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let niced = false;
          const childPid = child.pid;
          try {
            // خفض أولوية الجدولة عبر renice فوري بعد الإقلاع (0..19 → أولوية أدنى = أنسنة)
            if (childPid !== undefined) {
              execFile('renice', ['-n', String(nice), '-p', String(childPid)], (e) => {
                if (!e) niced = true;
              });
            }
          } catch {
            /* renice يفتقر للصلاحية أو غير متوفر — نكمل دون خفض */
          }

          child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
          child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

          const timer = setTimeout(() => {
            status = 'timeout';
            reason = `ETIMEDOUT: killed after ${options.timeout}ms (quota maxExecutionTimeMs)`;
            try {
              // SIGKILL لمجموعة العملية (negative pid) فيقتل كل الأبناء — لا أيتام
              if (childPid !== undefined) process.kill(-childPid, 'SIGKILL');
            } catch {
              try {
                child.kill('SIGKILL');
              } catch {
                /* already exited */
              }
            }
            resolvePromise();
          }, options.timeout);

          child.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            const code = err.code;
            if (code === 'ENOENT') {
              status = 'not_found';
              reason = `ENOENT: binary '${execPath}' not found on host`;
            } else {
              status = 'error';
              reason = code ? `${code}: ${err.message}` : err.message;
            }
            resolvePromise();
          });

          child.on('close', (code, signal) => {
            if (status !== 'timeout') clearTimeout(timer);
            if (status !== 'timeout') {
              if (code !== null) {
                exitCode = code;
                if (code !== 0) {
                  status = 'error';
                  reason = `process exited with code ${code}`;
                }
              } else if (signal) {
                status = 'error';
                reason = `process killed by signal ${signal}`;
              }
            }
            if (!niced && nice > 0) {
              stderr += `\n[warn] renice failed; niceness requested (${nice}) not applied`;
            }
            resolvePromise();
          });
        } else {
          execFile(execPath, args, options, onExit);
        }
      });
    } catch (caught) {
      status = 'error';
      reason = `EUNEXPECTED: ${caught instanceof Error ? caught.message : String(caught)}`;
    }

    return { stdout, stderr, exitCode, status, reason };
  }

  private inspectPath(targetPath: string): {
    exists: boolean;
    kind: 'elf' | 'script' | 'data' | 'dir' | 'special';
    executable: boolean;
    privileged: boolean;
    mode: number;
    interpreter?: string;
    realPath?: string;
    elfInfo?: ElfHeaderInfo;
  } {
    let realPath: string;
    try {
      const lst = lstatSync(targetPath);
      realPath = lst.isSymbolicLink() ? realpathSync(targetPath) : targetPath;
      const st = statSync(realPath);
      const executable = (st.mode & 0o111) !== 0;
      const privileged = (st.mode & 0o6000) !== 0;
      if (st.isDirectory()) {
        return { exists: true, kind: 'dir', executable, privileged, mode: st.mode, realPath };
      }
      if (!st.isFile()) {
        return { exists: true, kind: 'special', executable, privileged, mode: st.mode, realPath };
      }
      const fd = openSync(realPath, 'r');
      try {
        const buf = Buffer.alloc(512);
        const read = readSync(fd, buf, 0, 512, 0);
        const head = buf.subarray(0, read);

        if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
          const elfInfo = inspectElfHeader(head);
          // executable = بت التنفيذ الفعلي؛ نوع ELF غير القابل للتنفيذ (ET_REL/CORE) يُحجب
          // في `execute` بفرع kind==='data' مع ذكر سبب elfInfo.reason — لا بقناع "لا بت تنفيذ".
          return { exists: true, kind: elfInfo.isValid ? 'elf' : 'data', executable, privileged, mode: st.mode, realPath, elfInfo };
        }

        if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
          const line = new TextDecoder('utf-8', { fatal: false }).decode(head).split(/\r?\n/, 1)[0] ?? '';
          const { interpreter } = parseShebang(line);
          return { exists: true, kind: 'script', executable, privileged, mode: st.mode, interpreter, realPath };
        }

        return { exists: true, kind: 'data', executable, privileged, mode: st.mode, realPath };
      } finally {
        closeSync(fd);
      }
    } catch {
      return { exists: false, kind: 'data', executable: false, privileged: false, mode: 0 };
    }
  }

  private containsControlChars(path: string): boolean {
    return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(path);
  }

  private withinExecRoot(filePath: string, cwd?: string): boolean {
    let root: string;
    const candidate = this.execRoot ?? (cwd ?? process.cwd());
    try {
      root = realpathSync(candidate);
    } catch {
      root = resolve(candidate);
    }
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return filePath === root || filePath.startsWith(prefix);
  }

  private buildResult(
    request: LinuxCommandRequest,
    parsed: ParsedCommand,
    status: LinuxArchStatus,
    verdict: 'allowed' | 'denied',
    exitCode: number | null,
    stdout: string,
    stderr: string,
    executionTimeMs: number,
    reason: string | undefined,
    warnings: string[],
    agentId: string,
    budgetMs?: number,
    niceLevel?: number
  ): LinuxCommandResult {
    const usage = this.quotaGuard.getUsage(agentId);
    const command = request.commandLine;

    const summary: LocalizedString =
      status === 'blocked'
        ? {
            ar: `رُفض تنفيذ [${command}] بواسطة النواة: ${reason ?? 'سبب غير محدد'}`,
            en: `[${command}] was denied by the kernel: ${reason ?? 'unspecified reason'}`
          }
        : status === 'timeout'
          ? {
              ar: `انتهت مهلة تنفيذ [${command}] بعد ${budgetMs}ms (حد الحصة الزمنية)`,
              en: `[${command}] timed out after ${budgetMs}ms (quota time budget)`
            }
          : status === 'not_found'
            ? {
                ar: `الأمر أو البرنامج [${parsed.toolName}] غير موجود على مضيف أرش`,
                en: `Command or program [${parsed.toolName}] not found on the Arch host`
              }
            : status === 'error'
              ? {
                  ar: `فشل تنفيذ [${command}] خلال ${Math.round(executionTimeMs)}ms${reason ? `: ${reason}` : ''}`,
                  en: `[${command}] failed after ${Math.round(executionTimeMs)}ms${reason ? `: ${reason}` : ''}`
                }
              : {
                  ar: `نُفّذ [${command}] بنجاح في طبقة أرش خلال ${Math.round(executionTimeMs)}ms (كود خروج ${exitCode ?? '—'})`,
                  en: `[${command}] executed successfully in the Arch layer in ${Math.round(executionTimeMs)}ms (exit code ${exitCode ?? '—'})`
                };

    return {
      command,
      status,
      verdict,
      exitCode,
      stdout,
      stderr,
      executionTimeMs,
      parsedTool: parsed,
      reason,
      warnings,
      niceLevel,
      quota: {
        agentId,
        syscallCount: usage.syscallCount,
        errorCount: usage.errorCount,
        budgetMs: budgetMs ?? this.maxExecutionTimeMs
      },
      summary
    };
  }
}
