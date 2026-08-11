import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSync, chmodSync, mkdirSync, openSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LinuxArchExecutionLayer, ResourceQuotaGuard } from '../src/index';

const TMP = join(tmpdir(), `nawat-arch-layer-${Date.now()}`);

describe('Nawat LinuxArchExecutionLayer (Arch Linux Kernel Execution Layer)', () => {
  afterAll(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  // -------------------------------------------------------------------
  // 1. Command Parsing
  // -------------------------------------------------------------------
  describe('parseCommand (Arch/POSIX command parsing)', () => {
    const layer = new LinuxArchExecutionLayer();

    it('parses tool, flags, and targets', () => {
      const parsed = layer.parseCommand('rg -i foo src');
      expect(parsed.toolName).toBe('rg');
      expect(parsed.flags).toEqual(['-i']);
      expect(parsed.targets).toEqual(['foo', 'src']);
      expect(parsed.subCommand).toBeUndefined();
    });

    it('parses pacman subcommand and packages', () => {
      const parsed = layer.parseCommand('pacman -Syu base-devel');
      expect(parsed.toolName).toBe('pacman');
      expect(parsed.flags).toContain('-Syu');
      expect(parsed.targets).toEqual(['base-devel']);
    });

    it('treats first non-flag token as subCommand', () => {
      const parsed = layer.parseCommand('systemctl status nawat-kernel');
      expect(parsed.toolName).toBe('systemctl');
      expect(parsed.subCommand).toBe('status');
      expect(parsed.targets).toEqual(['nawat-kernel']);
    });
  });

  // -------------------------------------------------------------------
  // 2. Code-Domain Constraint Gates
  // -------------------------------------------------------------------
  describe('code-domain constraint gates', () => {
    const layer = new LinuxArchExecutionLayer();

    it('blocks DENY_TOOL:eval via CODE_DOMAIN_PROFILE', async () => {
      const res = await layer.execute({ commandLine: 'eval 2+2' });
      expect(res.status).toBe('blocked');
      expect(res.verdict).toBe('denied');
      expect(res.reason).toContain('code_no_eval');
    });

    it('warns (not blocks) on process.exit pattern', async () => {
      const res = await layer.execute({ commandLine: 'node -e "process.exit(1)"' });
      expect(res.status).toBe('success');
      expect(res.warnings.some((w) => w.includes('code_no_unhandled_rejection'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // 3. Arch Safety Rules
  // -------------------------------------------------------------------
  describe('Arch Linux safety rules', () => {
    const layer = new LinuxArchExecutionLayer();

    const blockedCases: Array<[string, string]> = [
      ['rm -rf /', 'arch_no_rm_force'],
      ['rm --no-preserve-root -f /', 'arch_no_rm_preserve'],
      ['mkfs.ext4 /dev/sda1', 'arch_no_format'],
      ['dd if=/dev/zero of=/dev/sda', 'arch_no_dd'],
      ['shutdown -h now', 'arch_no_poweroff'],
      ['reboot', 'arch_no_poweroff'],
      ['systemctl poweroff', 'arch_no_systemctl_power'],
      ['pacman -R base-devel', 'arch_no_pacman_remove'],
      ['sudo pacman -Syu', 'arch_no_privilege'],
      ['chroot /mnt /bin/bash', 'arch_no_privilege']
    ];

    it.each(blockedCases)('blocks %s (%s)', async (command, ruleId) => {
      const res = await layer.execute({ commandLine: command });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain(ruleId);
    });
  });

  // -------------------------------------------------------------------
  // 4. Allowlist Enforcement
  // -------------------------------------------------------------------
  describe('allowlist enforcement', () => {
    const layer = new LinuxArchExecutionLayer();

    it('denies tools not in the Arch allowlist (EPERM)', async () => {
      const res = await layer.execute({ commandLine: 'powerhero --mode=on' });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('not in the Arch execution allowlist');
    });

    it('denies rm even when harmless (excluded from allowlist)', async () => {
      const res = await layer.execute({ commandLine: 'rm notes.txt' });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('not in the Arch execution allowlist');
    });
  });

  // -------------------------------------------------------------------
  // 5. Real Execution (success / not_found / timeout / cwd)
  // -------------------------------------------------------------------
  describe('real command execution', () => {
    const layer = new LinuxArchExecutionLayer();

    it('executes an allowed binary via execFile (echo)', async () => {
      const res = await layer.execute({ commandLine: 'echo hello-arch' });
      expect(res.status).toBe('success');
      expect(res.verdict).toBe('allowed');
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('hello-arch');
      expect(res.summary.ar).toContain('نُفّذ');
    });

    it('reports not_found when the binary is missing', async () => {
      const res = await layer.execute({ commandLine: './definitely_missing_elf' });
      expect(res.status).toBe('not_found');
      expect(res.reason).toContain('ENOENT');
    });

    it('kills a hanging command via quota timeout (timeoutMs)', async () => {
      const res = await layer.execute({
        commandLine: 'node -e setTimeout(()=>{},5000)',
        timeoutMs: 150
      });
      expect(res.status).toBe('timeout');
      expect(res.reason).toContain('ETIMEDOUT');
      expect(res.quota?.budgetMs).toBe(150);
    });

    it('rejects a non-existent working directory', async () => {
      const res = await layer.execute({ commandLine: 'echo x', cwd: '/nonexistent_nawat_dir' });
      expect(res.status).toBe('error');
      expect(res.reason).toContain('ENOENT');
    });
  });

  // -------------------------------------------------------------------
  // 6. ELF Validation (magic bytes + exec bit)
  // -------------------------------------------------------------------
  describe('ELF file execution validation', () => {
    const layer = new LinuxArchExecutionLayer();

    const elfFile = join(TMP, 'prog.elf');
    const noExecElf = join(TMP, 'noexec.elf');
    const notElf = join(TMP, 'script.bin');

    beforeAll(() => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(elfFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
      chmodSync(elfFile, 0o755);
      writeFileSync(noExecElf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
      chmodSync(noExecElf, 0o644);
      writeFileSync(notElf, '#!/bin/sh\necho not-elf\n');
      chmodSync(notElf, 0o755);
    });

    it('detects a real ELF magic signature', () => {
      const fd = openSync(elfFile, 'r');
      const buf = Buffer.alloc(4);
      readSync(fd, buf, 0, 4, 0);
      closeSync(fd);
      expect(Array.from(buf)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    });

    it('attempts to execute a valid executable ELF (host ENOEXEC on fake payload)', async () => {
      const res = await layer.execute({ commandLine: `./prog.elf`, cwd: TMP });
      expect(res.status).toBe('error');
      expect(res.status).not.toBe('blocked');
      expect(res.status).not.toBe('not_found');
    });

    it('denies an ELF without the executable bit set', async () => {
      const res = await layer.execute({ commandLine: './noexec.elf', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('no executable bit');
    });

    it('denies a non-ELF executable (shebang shell script with disallowed interpreter)', async () => {
      const res = await layer.execute({ commandLine: './script.bin', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain("shebang interpreter 'sh'");
      expect(res.reason).toContain('not in the Arch execution allowlist');
    });
  });

  // -------------------------------------------------------------------
  // 7. Unknown Files: Shebang Scripts & Unknown Binary Formats
  // -------------------------------------------------------------------
  describe('unknown file handling (shebang scripts / unknown binary formats)', () => {
    const layer = new LinuxArchExecutionLayer();
    const pyScript = join(TMP, 'hello.py');
    const emptyShebang = join(TMP, 'empty.sh');
    const unknownBin = join(TMP, 'blob.bin');

    beforeAll(() => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(pyScript, '#!/usr/bin/env python3\nprint("hello-from-script")\n');
      chmodSync(pyScript, 0o755);
      writeFileSync(emptyShebang, '#!/usr/bin/env\n');
      chmodSync(emptyShebang, 0o755);
      writeFileSync(unknownBin, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10, 0x20]));
      chmodSync(unknownBin, 0o755);
    });

    it('executes a shebang script whose interpreter is allowed (python3 via env)', async () => {
      const res = await layer.execute({ commandLine: './hello.py', cwd: TMP });
      expect(res.status).toBe('success');
      expect(res.stdout).toContain('hello-from-script');
    });

    it('denies a shebang script with no valid interpreter program', async () => {
      const res = await layer.execute({ commandLine: './empty.sh', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('empty shebang');
    });

    it('denies an unknown binary format (no ELF signature, no shebang)', async () => {
      const res = await layer.execute({ commandLine: './blob.bin', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('unknown binary format');
    });
  });

  // -------------------------------------------------------------------
  // 8. Hidden / Backdoor Defenses (symlink escape · unicode · devices · dotfiles)
  // -------------------------------------------------------------------
  describe('hidden & backdoor file defenses', () => {
    const layer = new LinuxArchExecutionLayer();
    const strictLayer = new LinuxArchExecutionLayer({ rejectHiddenFiles: true });
    const OUTSIDE = join(tmpdir(), `nawat-arch-outside-${Date.now()}`);
    const leakScript = join(OUTSIDE, 'leak.py');
    const symlinkTarget = join(TMP, 'leak.py');
    const hiddenScript = join(TMP, '.hidden.py');

    beforeAll(() => {
      mkdirSync(OUTSIDE, { recursive: true });
      writeFileSync(leakScript, '#!/usr/bin/env python3\nprint("LEAKED")\n');
      chmodSync(leakScript, 0o755);
      mkdirSync(TMP, { recursive: true });
      try {
        symlinkSync(leakScript, symlinkTarget);
      } catch {
        /* already exists */
      }
      writeFileSync(hiddenScript, '#!/usr/bin/env python3\nprint("hidden-ok")\n');
      chmodSync(hiddenScript, 0o755);
    });

    afterAll(() => {
      try {
        rmSync(OUTSIDE, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    });

    it('blocks a symlink escaping the execution root (backdoor outside the tree)', async () => {
      const res = await layer.execute({ commandLine: './leak.py', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('outside the execution root');
    });

    it('executes the same file when the real target is inside the tree', async () => {
      const realScript = join(TMP, 'inside.py');
      writeFileSync(realScript, '#!/usr/bin/env python3\nprint("inside-ok")\n');
      chmodSync(realScript, 0o755);
      const res = await layer.execute({ commandLine: './inside.py', cwd: TMP });
      expect(res.status).toBe('success');
      expect(res.stdout).toContain('inside-ok');
    });

    it('blocks paths containing hidden/control characters (zero-width/bidi)', async () => {
      const res = await layer.execute({ commandLine: `./hid\u200bden`, cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('hidden/control characters');
    });

    it('blocks non-regular files such as device nodes', async () => {
      const res = await layer.execute({ commandLine: '/dev/null' });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('not a regular file');
    });

    it('allows dotfiles by default but rejects them when rejectHiddenFiles is on', async () => {
      const allowed = await layer.execute({ commandLine: './.hidden.py', cwd: TMP });
      expect(allowed.status).toBe('success');

      const denied = await strictLayer.execute({ commandLine: './.hidden.py', cwd: TMP });
      expect(denied.status).toBe('blocked');
      expect(denied.reason).toContain('hidden file');
    });
  });

  // -------------------------------------------------------------------
  // 7. ResourceQuotaGuard Integration
  // -------------------------------------------------------------------
  describe('quota.ts integration', () => {
    const guard = new ResourceQuotaGuard();
    const layer = new LinuxArchExecutionLayer({ quotaGuard: guard, defaultAgentId: 'arch-agent' });

    it('tracks syscall budget and denies when quota is exhausted', async () => {
      layer.setQuota('arch-agent', { maxSyscallsPerMinute: 1 });

      const first = await layer.execute({ commandLine: 'echo first', agentId: 'arch-agent' });
      expect(first.status).toBe('success');
      expect(first.quota?.syscallCount).toBe(1);

      const second = await layer.execute({ commandLine: 'echo second', agentId: 'arch-agent' });
      expect(second.status).toBe('blocked');
      expect(second.reason).toContain('EQUOTA_EXCEEDED');
      expect(second.summary.ar).toContain('رُفض');
    });

    it('caps the execution budget at maxExecutionTimeMs', async () => {
      const res = await layer.execute({ commandLine: 'echo capped', agentId: 'arch-agent-cap', timeoutMs: 999999 });
      expect(res.status).toBe('success');
      expect(res.quota?.budgetMs).toBeLessThan(999999);
    });
  });

  // -------------------------------------------------------------------
  // 8. Audit History
  // -------------------------------------------------------------------
  describe('audit history', () => {
    const layer = new LinuxArchExecutionLayer();

    it('records every request (allowed and denied) in order', async () => {
      await layer.execute({ commandLine: 'echo one' });
      await layer.execute({ commandLine: 'eval 1' });
      const records = layer.getRecords();
      expect(records.length).toBe(2);
      expect(records[0].status).toBe('success');
      expect(records[0].verdict).toBe('allowed');
      expect(records[1].status).toBe('blocked');
      expect(records[1].verdict).toBe('denied');
      expect(layer.getHistory().map((r) => r.commandLine)).toEqual(['echo one', 'eval 1']);
    });
  });

  // -------------------------------------------------------------------
  // 9. setuid/setgid Privilege Escalation Rejection
  // -------------------------------------------------------------------
  describe('setuid/setgid privilege escalation rejection', () => {
    const layer = new LinuxArchExecutionLayer();

    const suidScript = join(TMP, 'suid-tool.sh');
    const sgidElf = join(TMP, 'sgid-tool.elf');
    const normalScript = join(TMP, 'normal-tool.sh');

    beforeAll(() => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(suidScript, '#!/usr/bin/env python3\nprint("suid")\n');
      chmodSync(suidScript, 0o4755);
      writeFileSync(sgidElf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
      chmodSync(sgidElf, 0o2755);
      writeFileSync(normalScript, '#!/usr/bin/env python3\nprint("normal")\n');
      chmodSync(normalScript, 0o755);
    });

    it('denies a setuid (SUID) executable as privilege escalation', async () => {
      const res = await layer.execute({ commandLine: './suid-tool.sh', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('setuid/setgid');
      expect(res.reason).toContain('privilege escalation');
    });

    it('denies a setgid (SGID) executable as privilege escalation', async () => {
      const res = await layer.execute({ commandLine: './sgid-tool.elf', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('setuid/setgid');
    });

    it('still allows a regular non-setuid executable', async () => {
      const res = await layer.execute({ commandLine: './normal-tool.sh', cwd: TMP });
      expect(res.status).toBe('success');
      expect(res.stdout).toContain('normal');
    });
  });

  // -------------------------------------------------------------------
  // 10. Exec-Root Enforcement (gap س — OS isolation without bubblewrap)
  // -------------------------------------------------------------------
  describe('exec-root enforcement (isolation of allowed commands)', () => {
    const OUTSIDE = join(tmpdir(), `nawat-arch-rooted-${Date.now()}`);
    const isolated = new LinuxArchExecutionLayer({ execRoot: TMP });

    beforeAll(() => {
      mkdirSync(OUTSIDE, { recursive: true });
    });

    afterAll(() => {
      try {
        rmSync(OUTSIDE, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    });

    it('runs bare commands inside the exec root by default (no cwd escape)', async () => {
      const res = await isolated.execute({ commandLine: 'pwd' });
      expect(res.status).toBe('success');
      expect(res.stdout.trim()).toBe(TMP);
    });

    it('denies a working directory outside the exec root', async () => {
      const res = await isolated.execute({ commandLine: 'echo hi', cwd: OUTSIDE });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('outside the execution root');
    });

    it('denies an absolute target outside the exec root (e.g. cat /etc/shadow)', async () => {
      const res = await isolated.execute({ commandLine: 'cat /etc/hostname', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('resolves outside the execution root');
    });

    it('denies an absolute target even when it does not exist yet (e.g. touch /etc/x)', async () => {
      const res = await isolated.execute({ commandLine: 'touch /etc/nawat-nonexistent-target', cwd: TMP });
      expect(res.status).toBe('blocked');
      expect(res.reason).toContain('resolves outside the execution root');
    });

    it('allows relative targets inside the exec root', async () => {
      const res = await isolated.execute({ commandLine: 'touch rooted-file.txt', cwd: TMP });
      expect(res.status).toBe('success');
    });
  });
});
