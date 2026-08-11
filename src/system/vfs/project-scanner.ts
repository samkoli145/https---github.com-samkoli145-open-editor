import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { PersistentIndexer } from './persistent-indexer';

export type ProjectFindingKind =
  | 'ok'
  | 'hidden'
  | 'executable'
  | 'backdoor'
  | 'outside_link'
  | 'unregistered'
  | 'tampered'
  | 'missing';

export interface ProjectScanFinding {
  path: string;
  kind: ProjectFindingKind;
  detail: string;
  mode?: number;
  isExecutable?: boolean;
  checksum?: string;
}

export interface ProjectScanOptions {
  maxDepth?: number;
  skipDirs?: string[];
}

export interface ProjectScanReport {
  root: string;
  scannedFiles: number;
  scannedDirs: number;
  elapsedMs: number;
  counts: Record<ProjectFindingKind, number>;
  findings: ProjectScanFinding[];
  hidden: string[];
  executables: Array<{ path: string; kind: 'elf' | 'script' | 'unknown' }>;
  outsideLinks: string[];
}

const DEFAULT_SKIP_DIRS = ['node_modules', 'dist', 'build', 'target', '.venv', 'venv', '.git'];
const ELF_MAGIC = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
const HAS_CONTROL_CHARS = (name: string): boolean => /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(name);

function bytesChecksum(buf: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * ماسح سلامة المشروع الخارجي — عند فحص مجلد مشروع من الخارج:
 * - يكتشف الملفات المخفية (نقطية أو أسماء Unicode خفية) ويزجها في finding منفصلة
 * - يكتشف القابلات للتنفيذ (ELF/سكربت shebang) كإشارات أبواب خلفية محتملة
 * - يكتشف ملفات setuid/setgid القابلة للتنفيذ (تصعيد صلاحيات)
 * - يكتشف الروابط الرمزية الخارجة عن الشجرة (هروب من الجذر)
 * - بمقارنة مع PersistentIndexer: غير المسجّلة (مزروعة) / المغيّرة (معبث بها) / المفقودة
 */
export function scanProject(rootDir: string, indexer?: PersistentIndexer, options: ProjectScanOptions = {}): ProjectScanReport {
  const started = Date.now();
  const maxDepth = options.maxDepth ?? 12;
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);

  let rootReal: string;
  try {
    rootReal = realpathSync(rootDir);
  } catch {
    rootReal = rootDir;
  }
  const rootPrefix = rootReal.endsWith('/') ? rootReal : `${rootReal}/`;

  const findings: ProjectScanFinding[] = [];
  const hidden: string[] = [];
  const executables: Array<{ path: string; kind: 'elf' | 'script' | 'unknown' }> = [];
  const outsideLinks: string[] = [];
  let scannedFiles = 0;
  let scannedDirs = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      findings.push({ path: dir, kind: 'backdoor', detail: `scan aborted: exceeds max depth ${maxDepth}` });
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const hiddenName = entry.name.startsWith('.') || HAS_CONTROL_CHARS(entry.name);

      if (entry.isDirectory()) {
        if (hiddenName) {
          hidden.push(fullPath);
          findings.push({ path: fullPath, kind: 'hidden', detail: 'hidden directory (dotfile or control-char name)' });
        }
        if (skipDirs.has(entry.name)) continue;
        scannedDirs++;
        walk(fullPath, depth + 1);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(fullPath);
        } catch {
          findings.push({ path: fullPath, kind: 'outside_link', detail: 'broken symbolic link' });
          outsideLinks.push(fullPath);
          continue;
        }
        if (real === rootReal || real.startsWith(rootPrefix)) {
          findings.push({ path: fullPath, kind: 'hidden', detail: `symbolic link inside tree → ${real}` });
        } else {
          findings.push({ path: fullPath, kind: 'outside_link', detail: `symbolic link escapes project root → ${real}` });
          outsideLinks.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        findings.push({ path: fullPath, kind: 'backdoor', detail: 'non-regular file (device/socket/fifo)' });
        continue;
      }

      scannedFiles++;
      const finding = inspectFile(fullPath, indexer, hiddenName, executables);
      if (finding) {
        findings.push(finding);
        if (finding.kind === 'hidden') hidden.push(fullPath);
        if (finding.kind === 'outside_link') outsideLinks.push(fullPath);
      }
    }
  };

  walk(rootDir, 0);

  if (indexer) {
    for (const entry of indexer.getAllEntries()) {
      if (!existsSync(entry.path)) {
        findings.push({ path: entry.path, kind: 'missing', detail: 'indexed file missing from disk (removed?)' });
      }
    }
  }

  const counts: Record<ProjectFindingKind, number> = {
    ok: 0, hidden: 0, executable: 0, backdoor: 0, outside_link: 0, unregistered: 0, tampered: 0, missing: 0
  };
  for (const f of findings) counts[f.kind]++;

  return {
    root: rootDir,
    scannedFiles,
    scannedDirs,
    elapsedMs: Date.now() - started,
    counts,
    findings,
    hidden,
    executables,
    outsideLinks
  };
}

function inspectFile(
  fullPath: string,
  indexer: PersistentIndexer | undefined,
  hiddenName: boolean,
  executables: Array<{ path: string; kind: 'elf' | 'script' | 'unknown' }>
): ProjectScanFinding | undefined {
  let st;
  let head: Uint8Array;
  try {
    st = statSync(fullPath);
    const fd = openSync(fullPath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, 512, 0);
      head = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { path: fullPath, kind: 'missing', detail: 'cannot stat/read file' };
  }

  const isExe = (st.mode & 0o111) !== 0;
  const privileged = (st.mode & 0o6000) !== 0;
  const isElf = ELF_MAGIC(head);
  const isScript = head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;
  const isProgram = isExe || isElf || isScript;
  const kind: 'elf' | 'script' | 'unknown' = isElf ? 'elf' : isScript ? 'script' : 'unknown';

  let fullSum: string | undefined;
  if (isProgram || indexer) {
    try {
      fullSum = bytesChecksum(readFileSync(fullPath));
    } catch {
      fullSum = undefined;
    }
  }

  if (isProgram) {
    executables.push({ path: fullPath, kind });
  }

  if (privileged && isProgram) {
    return {
      path: fullPath,
      kind: 'backdoor',
      detail: `setuid/setgid executable (mode 0o${st.mode.toString(8)}) — privilege escalation risk`,
      mode: st.mode,
      isExecutable: true,
      checksum: fullSum
    };
  }

  if (hiddenName) {
    return {
      path: fullPath,
      kind: 'hidden',
      detail: 'hidden file (dotfile or control-char name)',
      mode: st.mode,
      isExecutable: isProgram,
      checksum: fullSum
    };
  }

  if (indexer) {
    const entryRes = indexer.getEntry(fullPath);
    if (entryRes.isErr) {
      return {
        path: fullPath,
        kind: 'unregistered',
        detail: 'file on disk is not registered in the kernel index (planted?)',
        mode: st.mode,
        isExecutable: isProgram,
        checksum: fullSum
      };
    }
    const entry = entryRes.value;
    if (fullSum !== undefined && entry.checksum !== fullSum) {
      return {
        path: fullPath,
        kind: 'tampered',
        detail: `checksum mismatch: index '${entry.checksum}' vs disk '${fullSum}'`,
        mode: st.mode,
        isExecutable: isProgram,
        checksum: fullSum
      };
    }
    return { path: fullPath, kind: 'ok', detail: 'content matches index', mode: st.mode, isExecutable: isProgram, checksum: fullSum };
  }

  return isProgram
    ? { path: fullPath, kind: 'executable', detail: `executable program (${kind})`, mode: st.mode, isExecutable: true, checksum: fullSum }
    : { path: fullPath, kind: 'ok', detail: 'regular non-executable file', mode: st.mode, isExecutable: false };
}
