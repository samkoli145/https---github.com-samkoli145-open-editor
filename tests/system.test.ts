import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizePath,
  detectFileType,
  inspectElfHeader,
  PersistentIndexer,
  SafeSystemStorageEngine,
  BaseSystemEngine,
  ExecutionSandboxEngine,
  EventBus
} from '../src/index';

describe('Nawat System Layer - Storage & VFS Infrastructure', () => {

  // -------------------------------------------------------------------
  // 1. Path Sanitization & Traversal Security Tests
  // -------------------------------------------------------------------
  describe('Path Sanitizer (Path Traversal Security)', () => {
    it('sanitizes valid relative and absolute paths within VFS root', () => {
      const res = sanitizePath('/vfs/documents/notes.txt', '/vfs');
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        expect(res.value).toBe('/vfs/documents/notes.txt');
      }
    });

    it('blocks path traversal attempts out of root jail (e.g. ../../etc/passwd)', () => {
      const res = sanitizePath('/vfs/../../etc/passwd', '/vfs');
      expect(res.isOk).toBe(false);
      if (!res.isOk) {
        expect(res.error.message).toContain('ESECURITY_VIOLATION');
      }
    });

    it('blocks null byte injection attacks', () => {
      const res = sanitizePath('/vfs/uploads/avatar.png\0.exe', '/vfs');
      expect(res.isOk).toBe(false);
      if (!res.isOk) {
        expect(res.error.message).toContain('null byte');
      }
    });

    it('normalizes backslashes and Windows path traversal attacks', () => {
      const res = sanitizePath('subfolder\\..\\..\\secret.key', '/vfs');
      expect(res.isOk).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // 2. File Type Detection (Magic Bytes Inspection)
  // -------------------------------------------------------------------
  describe('File Type Detector', () => {
    it('detects PNG image via magic bytes header', () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const res = detectFileType(pngHeader);
      expect(res.ext).toBe('png');
      expect(res.mime).toBe('image/png');
      expect(res.isExecutable).toBe(false);
      expect(res.confidence).toBe('magic_bytes');
    });

    it('detects ELF Linux executable via magic bytes', () => {
      const elfHeader = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const res = detectFileType(elfHeader);
      expect(res.ext).toBe('elf');
      expect(res.isExecutable).toBe(true);
    });

    it('inspectElfHeader validates e_ident (class/endian/version) and e_type for deep ELF checks', () => {
      // 64-bit little-endian ET_EXEC
      const exec64 = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00]);
      const infoExec = inspectElfHeader(exec64);
      expect(infoExec).not.toBeNull();
      expect(infoExec!.elfClass).toBe(64);
      expect(infoExec!.endian).toBe('little');
      expect(infoExec!.version).toBe(1);
      expect(infoExec!.eTypeName).toBe('ET_EXEC');
      expect(infoExec!.isExecutable).toBe(true);

      // 32-bit big-endian ET_DYN (PIE)
      const dyn32be = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x03]);
      const infoDyn = inspectElfHeader(dyn32be);
      expect(infoDyn!.elfClass).toBe(32);
      expect(infoDyn!.endian).toBe('big');
      expect(infoDyn!.eTypeName).toBe('ET_DYN');
      expect(infoDyn!.isExecutable).toBe(true);
    });

    it('rejects non-executable ELF types (ET_REL object) as data, not executable', () => {
      const rel = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00]);
      const info = inspectElfHeader(rel);
      expect(info).not.toBeNull();
      expect(info!.eTypeName).toBe('ET_REL');
      expect(info!.isExecutable).toBe(false);

      const res = detectFileType(rel);
      expect(res.ext).toBe('bin');
      expect(res.isExecutable).toBe(false);
    });

    it('keeps truncated ELF signatures classified as executable (legacy magic-only)', () => {
      const truncated = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const res = detectFileType(truncated);
      expect(res.ext).toBe('elf');
      expect(res.isExecutable).toBe(true);
    });

    it('detects JSON strings via text heuristics', () => {
      const res = detectFileType('{"name": "Nawat Kernel"}');
      expect(res.ext).toBe('json');
      expect(res.mime).toBe('application/json');
      expect(res.confidence).toBe('text_heuristic');
    });

    it('detects shebang scripts and their interpreter regardless of extension', () => {
      const res = detectFileType('#!/usr/bin/env python3\nprint("hi")');
      expect(res.ext).toBe('py');
      expect(res.mime).toBe('text/x-python');
      expect(res.isExecutable).toBe(true);
      expect(res.confidence).toBe('shebang');
      expect(res.interpreter).toContain('python3');
    });

    it('maps env shebangs to the real program (#!/usr/bin/env -S node)', () => {
      const res = detectFileType('#!/usr/bin/env -S node\nconsole.log(1)');
      expect(res.ext).toBe('js');
      expect(res.interpreter).toContain('node');
    });

    it('reports unknown binary content as bin/octet-stream, not text', () => {
      const res = detectFileType(new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x10]));
      expect(res.ext).toBe('bin');
      expect(res.mime).toBe('application/octet-stream');
      expect(res.isExecutable).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // 3. Persistent Indexer Lifecycle & POSIX Metadata
  // -------------------------------------------------------------------
  describe('Persistent Indexer & POSIX Compliance', () => {
    it('registers files, indexes POSIX metadata (mode, uid, gid, inode), and supports search', () => {
      const indexer = new PersistentIndexer('/vfs');

      const regRes = indexer.registerFile('/vfs/docs/guide.md', '# Nawat Architecture', 'hash_123', 0o644, 1000, 1000);
      expect(regRes.isOk).toBe(true);

      const entry = indexer.getEntry('/vfs/docs/guide.md');
      expect(entry.isOk).toBe(true);
      if (entry.isOk) {
        expect(entry.value.size).toBeGreaterThan(0);
        expect(entry.value.mode).toBe(0o644);
        expect(entry.value.uid).toBe(1000);
        expect(entry.value.inode).toContain('inode_');
        expect(entry.value.checksum).toBe('hash_123');
      }

      const searchResults = indexer.search('guide');
      expect(searchResults.length).toBe(1);

      indexer.dispose();
    });

    it('auto-promotes executable permissions for ELF binary signatures', () => {
      const indexer = new PersistentIndexer('/vfs');
      const elfHeader = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]);

      const regRes = indexer.registerFile('/vfs/bin/runner', elfHeader, 'hash_elf', 0o644);
      expect(regRes.isOk).toBe(true);

      const entry = indexer.getEntry('/vfs/bin/runner');
      expect(entry.isOk).toBe(true);
      if (entry.isOk) {
        expect(entry.value.isExecutable).toBe(true);
        expect(entry.value.mode & 0o111).not.toBe(0); // Has executable bit
      }
    });

    it('simulates chmod and chown operations with permission enforcement', () => {
      const indexer = new PersistentIndexer('/vfs');
      indexer.registerFile('/vfs/script.sh', 'echo "test"', 'hash_123', 0o644, 1000, 1000);

      // 1. Check initial read/execute permissions
      expect(indexer.checkAccess('/vfs/script.sh', 'read', 1000).isOk).toBe(true);
      expect(indexer.checkAccess('/vfs/script.sh', 'execute', 1000).isOk).toBe(false);

      // 2. chmod to 0o755 by owner (UID 1000)
      const chmodRes = indexer.chmod('/vfs/script.sh', 0o755, 1000);
      expect(chmodRes.isOk).toBe(true);
      expect(indexer.checkAccess('/vfs/script.sh', 'execute', 1000).isOk).toBe(true);

      // 3. Non-owner cannot chmod
      const failChmod = indexer.chmod('/vfs/script.sh', 0o600, 2000);
      expect(failChmod.isOk).toBe(false);
      if (!failChmod.isOk) {
        expect(failChmod.error.message).toContain('EPERM');
      }

      // 4. chown by root (UID 0) to UID 2000
      const chownRes = indexer.chown('/vfs/script.sh', 2000, 2000, 0);
      expect(chownRes.isOk).toBe(true);
      const getRes = indexer.getEntry('/vfs/script.sh');
      expect(getRes.isOk).toBe(true);
      if (getRes.isOk) {
        expect(getRes.value.uid).toBe(2000);
      }

      // 5. Old owner (UID 1000) now restricted if mode is 0o700
      indexer.chmod('/vfs/script.sh', 0o700, 2000);
      expect(indexer.checkAccess('/vfs/script.sh', 'read', 1000).isOk).toBe(false);
      expect(indexer.checkAccess('/vfs/script.sh', 'read', 2000).isOk).toBe(true);
    });

    it('persists the index to disk and reloads it across sessions (syncToDisk/loadFromDisk)', () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'nawat-index-persist-'));
      try {
        const indexer = new PersistentIndexer(rootDir);
        indexer.registerFile(join(rootDir, 'src', 'main.py'), '#!/usr/bin/env python3\nprint("hi")', undefined, 0o755);
        indexer.registerFile(join(rootDir, 'notes', 'ideas.md'), '# ideas', undefined, 0o644);
        indexer.syncToDisk();
        indexer.dispose();

        const reloaded = new PersistentIndexer(rootDir);
        const loadRes = reloaded.loadFromDisk();
        expect(loadRes.isOk).toBe(true);
        expect(loadRes.isOk && loadRes.value).toBe(2);

        const main = reloaded.getEntry(join(rootDir, 'src', 'main.py'));
        expect(main.isOk).toBe(true);
        if (main.isOk) {
          expect(main.value.mode).toBe(0o755);
          expect(main.value.isExecutable).toBe(true);
          expect(main.value.checksum).toBe(PersistentIndexer.computeChecksum('#!/usr/bin/env python3\nprint("hi")'));
        }
        reloaded.dispose();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it('rejects a tampered index snapshot with EINTEGRITY on load', () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'nawat-index-tamper-'));
      try {
        const indexer = new PersistentIndexer(rootDir);
        indexer.registerFile(join(rootDir, 'a.txt'), 'hello', undefined, 0o644);
        indexer.syncToDisk();
        indexer.dispose();

        const snapshotPath = join(rootDir, '.nawat-index.json');
        const raw = readFileSync(snapshotPath, 'utf8');
        const checksum = PersistentIndexer.computeChecksum('hello');
        const corrupted = raw.replace(checksum, checksum.slice(0, 20) + (checksum[20] === 'a' ? 'b' : 'a') + checksum.slice(21));
        writeFileSync(snapshotPath, corrupted, 'utf8');

        const reloaded = new PersistentIndexer(rootDir);
        const loadRes = reloaded.loadFromDisk();
        expect(loadRes.isErr).toBe(true);
        if (loadRes.isErr) {
          expect(loadRes.error.message).toContain('EINTEGRITY');
        }
        reloaded.dispose();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------
  // 4. Safe Storage Engine (Atomic Writes & Corruption Bounds)
  // -------------------------------------------------------------------
  describe('Safe Storage Engine', () => {
    it('saves and loads data with checksum validation', async () => {
      const storage = new SafeSystemStorageEngine();
      const payload = { userId: 'usr_42', role: 'admin', sessionActive: true };

      const saveRes = await storage.save('session_42.json', payload);
      expect(saveRes.isOk).toBe(true);

      const loadRes = await storage.load<typeof payload>('session_42.json');
      expect(loadRes.isOk).toBe(true);
      if (loadRes.isOk) {
        expect(loadRes.value.userId).toBe('usr_42');
      }
    });

    it('rejects keys with path traversal security violations', async () => {
      const storage = new SafeSystemStorageEngine();
      const saveRes = await storage.save('../../etc/shadow', { secret: 'data' });
      expect(saveRes.isOk).toBe(false);
      if (!saveRes.isOk) {
        expect(saveRes.error.message).toContain('ESECURITY_VIOLATION');
      }
    });
  });

  // -------------------------------------------------------------------
  // 5. Execution Sandbox Engine (Deterministic POSIX & LLM Over-Refusal Shield)
  // -------------------------------------------------------------------
  describe('Execution Sandbox Engine', () => {
    it('verifies POSIX permissions and executes authorized scripts safely', async () => {
      const indexer = new PersistentIndexer('/vfs');
      const elfHeader = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]);

      indexer.registerFile('/vfs/bin/safe_task', elfHeader, 'hash_task', 0o755, 1000, 1000);

      const sandbox = new ExecutionSandboxEngine({ engineId: 'sandbox_v1', indexer });
      const execRes = await sandbox.execute({ path: '/vfs/bin/safe_task', uid: 1000 });

      expect(execRes.isOk).toBe(true);
      if (execRes.isOk) {
        expect(execRes.value.exitCode).toBe(0);
        expect(execRes.value.stdout).toContain('inode_');
      }
    });

    it('rejects execution when file lacks executable permission mode or non-owner UID', async () => {
      const indexer = new PersistentIndexer('/vfs');
      indexer.registerFile('/vfs/docs/script.sh', 'echo "test"', 'hash_sh', 0o600, 1000, 1000);

      const sandbox = new ExecutionSandboxEngine({ engineId: 'sandbox_v1', indexer });

      // Should fail due to missing executable mode 0o600
      const execRes = await sandbox.execute({ path: '/vfs/docs/script.sh', uid: 1000 });
      expect(execRes.isOk).toBe(false);
      if (!execRes.isOk) {
        expect(execRes.error.message).toContain('EPERM');
      }
    });
  });

  // -------------------------------------------------------------------
  // 6. Base System Engine Lifecycle & Event Hooks
  // -------------------------------------------------------------------
  describe('Base System Engine', () => {
    class MockEngine extends BaseSystemEngine {
      public initCalled = false;
      public disposeCalled = false;

      protected onInitialize(): void {
        this.initCalled = true;
      }

      protected onDispose(): void {
        this.disposeCalled = true;
      }
    }

    it('handles initialization, event bus signals, and disposal', async () => {
      const bus = new EventBus();
      let initFired = false;
      let disposeFired = false;

      bus.on('engine:initialized', () => { initFired = true; }, []);
      bus.on('engine:disposed', () => { disposeFired = true; }, []);

      const engine = new MockEngine({ engineId: 'mock_v1', eventBus: bus });
      const initRes = await engine.initialize();

      expect(initRes.isOk).toBe(true);
      expect(engine.initCalled).toBe(true);
      expect(initFired).toBe(true);

      engine.dispose();
      expect(engine.disposeCalled).toBe(true);
      expect(disposeFired).toBe(true);
    });
  });

});
