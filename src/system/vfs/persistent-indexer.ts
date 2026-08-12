import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Result, ok, err } from '../../kernel/core/result';
import { DisposableStore } from '../../kernel/core/disposable';
import { sanitizePath, SanitizedPath } from './path-sanitizer';
import { detectFileType } from './file-type-detector';

export type FileNodeType = 'file' | 'directory' | 'symlink';

export interface VFSFileIndexEntry {
  path: SanitizedPath;
  type: FileNodeType;
  size: number;
  mode: number;       // POSIX permission flags e.g. 0o755 for executable, 0o644 for readable
  uid: number;        // User ID ownership
  gid: number;        // Group ID ownership
  inode: string;      // Unique inode identifier
  mimeType: string;
  checksum: string;
  isExecutable: boolean;
  updatedAt: number;
  linkTarget?: string; // §5-طـ: هدف السيملينك المُسجَّل (يُفحص ضد هروب الجذر عند التسجيل)
}

export function computeSha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Persistent Indexer that tracks VFS file metadata with POSIX compliance (mode, uid, gid, inode),
 * supports fast search & filtering, and handles safe debounced disk sync & teardown.
 */
export class PersistentIndexer {
  private index = new Map<SanitizedPath, VFSFileIndexEntry>();
  private disposables = new DisposableStore();
  private syncTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private inodeCounter = 1000;

  constructor(
    public readonly rootDir = '/vfs',
    public readonly indexPath?: string
  ) {
    const target = this.snapshotPath();
    if (target && existsSync(target)) {
      this.loadFromDisk();
    }
  }

  /** مسار snapshot خط الأساس: indexPath صريح، وإلا `.nawat-index.json` تحت الجذر. */
  private snapshotPath(targetPath?: string): string | undefined {
    return targetPath ?? this.indexPath ?? (this.rootDir ? join(this.rootDir, '.nawat-index.json') : undefined);
  }

  public registerFile(
    rawPath: string,
    content: string | Uint8Array,
    checksum?: string,
    mode: number = 0o644,
    uid: number = 1000,
    gid: number = 1000,
    nodeType: FileNodeType = 'file',
    linkTarget?: string
  ): Result<VFSFileIndexEntry, Error> {
    if (this.isDisposed) {
      return err(new Error('EDISPOSED: PersistentIndexer has been shut down'));
    }

    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }

    const safePath = pathRes.value;
    const fileType = detectFileType(content);
    const size = typeof content === 'string' ? new TextEncoder().encode(content).length : content.length;
    const finalChecksum = checksum ?? computeSha256(content);

    // §5-طـ: تتبّع هدف السيملينك ورفض ما يهرب خارج الجذر (بدل عقدة ساذجة بلا هدف).
    let trackedTarget: string | undefined;
    if (nodeType === 'symlink' && linkTarget !== undefined) {
      const targetAbs = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(safePath), linkTarget);
      const rootAbs = resolve(this.rootDir);
      const rootPrefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`;
      if (targetAbs !== rootAbs && !targetAbs.startsWith(rootPrefix)) {
        return err(new Error(`ESECURITY: symlink '${rawPath}' targets '${linkTarget}' (${targetAbs}) outside the index root '${this.rootDir}'`));
      }
      trackedTarget = linkTarget;
    }

    // Auto-promote executable permissions if magic bytes indicate ELF/PE/Script binary
    const isExe = fileType.isExecutable || (mode & 0o111) !== 0;
    const finalMode = isExe ? (mode | 0o755) : mode;

    const entry: VFSFileIndexEntry = {
      path: safePath,
      type: nodeType,
      size,
      mode: finalMode,
      uid,
      gid,
      inode: `inode_${this.inodeCounter++}`,
      mimeType: fileType.mime,
      checksum: finalChecksum,
      isExecutable: isExe,
      updatedAt: Date.now(),
      linkTarget: trackedTarget
    };

    this.index.set(safePath, entry);
    this.scheduleSync();

    return ok(entry);
  }

  /** §5-طـ: يعيد هدف السيملينك المُسجَّل إن وُجد، وإلا err. */
  public resolveLinkTarget(rawPath: string): Result<string, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    const entry = this.index.get(pathRes.value);
    if (!entry) {
      return err(new Error(`ENOENT: Index entry not found for path '${rawPath}'`));
    }
    if (entry.type !== 'symlink' || entry.linkTarget === undefined) {
      return err(new Error(`ENOTLINK: '${rawPath}' is not a tracked symlink`));
    }
    return ok(entry.linkTarget);
  }

  public chmod(rawPath: string, mode: number, callerUid = 1000): Result<VFSFileIndexEntry, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    const entry = this.index.get(pathRes.value);
    if (!entry) {
      return err(new Error(`ENOENT: Index entry not found for path '${rawPath}'`));
    }

    if (callerUid !== 0 && callerUid !== entry.uid) {
      return err(new Error(`EPERM: Permission denied. Only owner (UID ${entry.uid}) or root can chmod '${rawPath}'`));
    }

    entry.mode = mode;
    entry.isExecutable = (mode & 0o111) !== 0;
    entry.updatedAt = Date.now();
    this.scheduleSync();
    return ok(entry);
  }

  public chown(rawPath: string, uid: number, gid?: number, callerUid = 0): Result<VFSFileIndexEntry, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    const entry = this.index.get(pathRes.value);
    if (!entry) {
      return err(new Error(`ENOENT: Index entry not found for path '${rawPath}'`));
    }

    if (callerUid !== 0 && callerUid !== entry.uid) {
      return err(new Error(`EPERM: Permission denied. Only owner (UID ${entry.uid}) or root can chown '${rawPath}'`));
    }

    entry.uid = uid;
    if (gid !== undefined) {
      entry.gid = gid;
    }
    entry.updatedAt = Date.now();
    this.scheduleSync();
    return ok(entry);
  }

  public checkAccess(
    rawPath: string,
    accessType: 'read' | 'write' | 'execute',
    uid = 1000,
    gid = 1000
  ): Result<boolean, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    const entry = this.index.get(pathRes.value);
    if (!entry) {
      return err(new Error(`ENOENT: Index entry not found for path '${rawPath}'`));
    }

    // Root user (UID 0) bypasses read/write permissions
    if (uid === 0) {
      if (accessType === 'execute') {
        if ((entry.mode & 0o111) === 0 && !entry.isExecutable) {
          return err(new Error(`EPERM: Permission denied. File '${rawPath}' lacks executable bit`));
        }
      }
      return ok(true);
    }

    let hasPerm = false;
    if (uid === entry.uid) {
      // Owner bits
      if (accessType === 'read') hasPerm = (entry.mode & 0o400) !== 0;
      else if (accessType === 'write') hasPerm = (entry.mode & 0o200) !== 0;
      else if (accessType === 'execute') hasPerm = (entry.mode & 0o100) !== 0 || entry.isExecutable;
    } else if (gid === entry.gid) {
      // Group bits
      if (accessType === 'read') hasPerm = (entry.mode & 0o040) !== 0;
      else if (accessType === 'write') hasPerm = (entry.mode & 0o020) !== 0;
      else if (accessType === 'execute') hasPerm = (entry.mode & 0o010) !== 0;
    } else {
      // Other/World bits
      if (accessType === 'read') hasPerm = (entry.mode & 0o004) !== 0;
      else if (accessType === 'write') hasPerm = (entry.mode & 0o002) !== 0;
      else if (accessType === 'execute') hasPerm = (entry.mode & 0o001) !== 0;
    }

    if (!hasPerm) {
      return err(new Error(`EACCES: Permission denied for ${accessType} on '${rawPath}' (mode 0o${entry.mode.toString(8)}, caller UID ${uid})`));
    }

    return ok(true);
  }

  public getEntry(rawPath: string, callerUid?: number, callerGid?: number): Result<VFSFileIndexEntry, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    const entry = this.index.get(pathRes.value);
    if (!entry) {
      return err(new Error(`ENOENT: Index entry not found for path '${rawPath}'`));
    }

    if (callerUid !== undefined) {
      const access = this.checkAccess(rawPath, 'read', callerUid, callerGid);
      if (!access.isOk) {
        return err(access.error);
      }
    }

    return ok(entry);
  }

  public removeEntry(rawPath: string, callerUid?: number, callerGid?: number): Result<boolean, Error> {
    const pathRes = sanitizePath(rawPath, this.rootDir);
    if (!pathRes.isOk) {
      return err(pathRes.error);
    }
    if (callerUid !== undefined) {
      const access = this.checkAccess(rawPath, 'write', callerUid, callerGid);
      if (!access.isOk) {
        return err(access.error);
      }
    }
    const removed = this.index.delete(pathRes.value);
    if (removed) {
      this.scheduleSync();
    }
    return ok(removed);
  }

  public search(query: string): VFSFileIndexEntry[] {
    const lower = query.toLowerCase();
    const results: VFSFileIndexEntry[] = [];
    for (const entry of this.index.values()) {
      if (entry.path.toLowerCase().includes(lower) || entry.mimeType.toLowerCase().includes(lower)) {
        results.push(entry);
      }
    }
    return results;
  }

  public getAllEntries(): VFSFileIndexEntry[] {
    return Array.from(this.index.values());
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncToDisk();
    }, 100);
  }

  /**
   * حفظ ذرّي حقيقي لخط الأساس إلى `.nawat-index.json` (فجوة ص): كتابة إلى ملف مؤقت
   * ثم rename ذرّي، مع غلاف يحمل بصمة SHA-256 للمحتوى لاكتشاف الفساد/العبث عند التحميل.
   */
  public syncToDisk(targetPath?: string): Result<boolean, Error> {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const destination = this.snapshotPath(targetPath);
    if (!destination) {
      return ok(false);
    }
    try {
      const entries = Array.from(this.index.entries());
      const body = JSON.stringify(entries);
      const snapshot = {
        version: 1,
        entries,
        checksum: computeSha256(body),
        timestamp: Date.now()
      };
      mkdirSync(dirname(destination), { recursive: true });
      const tmp = `${destination}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      renameSync(tmp, destination);
      return ok(true);
    } catch (e: any) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * تحميل خط الأساس من القرص (فجوة ص): يتحقق من بصمة الغلاف SHA-256
   * (يرفض `EINTEGRITY` عند الفساد/العبث) ويعيد بناء الفهرس والعداد.
   */
  public loadFromDisk(targetPath?: string): Result<number, Error> {
    const source = this.snapshotPath(targetPath);
    if (!source || !existsSync(source)) {
      return err(new Error(`ENOENT: index path '${source ?? '(none)'}' does not exist`));
    }
    try {
      const content = readFileSync(source, 'utf-8');
      const snapshot = JSON.parse(content) as {
        version: number;
        entries: Array<[SanitizedPath, VFSFileIndexEntry]>;
        checksum: string;
      };
      if (!Array.isArray(snapshot.entries)) {
        return err(new Error('EINTEGRITY: index snapshot has no entries array'));
      }
      const body = JSON.stringify(snapshot.entries);
      if (typeof snapshot.checksum === 'string' && computeSha256(body) !== snapshot.checksum) {
        return err(new Error('EINTEGRITY: index snapshot checksum mismatch (corrupted or tampered)'));
      }
      this.index.clear();
      let maxInode = this.inodeCounter;
      for (const [key, entry] of snapshot.entries) {
        this.index.set(key, entry);
        const num = parseInt(String(entry.inode).replace('inode_', ''), 10);
        if (!Number.isNaN(num) && num >= maxInode) maxInode = num + 1;
      }
      this.inodeCounter = maxInode;
      return ok(this.index.size);
    } catch (e: any) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.disposables.dispose();
    this.index.clear();
  }
}

