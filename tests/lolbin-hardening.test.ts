import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxArchExecutionLayer, FORBIDDEN_GENERAL_INTERPRETERS } from '../src/agent-kernel/linux-arch-execution-layer';
import { ProcessLauncher, LAUNCHER_ALLOWED_BINARIES } from '../src/host/launcher/process-launcher';
import { EventBus } from '../src/kernel/core/event-bus';
import { LauncherManager } from '../src/host/launcher/launcher-manager';
import { CommandRegistry } from '../src/kernel/command-registry';
import { SafeSystemStorageEngine } from '../src/system/storage';

describe('إصلاح §5-0 — حظر المفسِّرات العامة (LOLBin) في الطبقة الأرشية', () => {
  it('يُحظر /bin/bash بمسار مطلق داخل الجذر رغم أنه ELF سليم (LOLBin)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-lolbin-'));
    const bashShim = join(tmp, 'bash');
    writeFileSync(bashShim, '#!/bin/sh\necho shim\n');
    chmodSync(bashShim, 0o755);

    const layer = new LinuxArchExecutionLayer({ execRoot: tmp });
    const res = await layer.execute({ commandLine: `${bashShim} -c "id"` });
    expect(res.verdict).toBe('denied');
    expect(res.reason).toContain('general interpreter');
  });

  it('لا يكسر تشغيل سكربت shebang عادي بمفسِّر عام (حالة المشروع)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-shebang-'));
    const script = join(tmp, 'tool.sh');
    writeFileSync(script, '#!/usr/bin/env python3\nprint("ok-shebang")\n');
    chmodSync(script, 0o755);

    const layer = new LinuxArchExecutionLayer({ execRoot: tmp });
    const res = await layer.execute({ commandLine: `./tool.sh`, cwd: tmp });
    expect(res.verdict).toBe('allowed');
    expect(res.stdout).toContain('ok-shebang');
  });

  it('allowlist المفسِّرات العامة محدّد (bash/sh/python/node...) ولا يشمل أدوات محددة الغرض', () => {
    expect(FORBIDDEN_GENERAL_INTERPRETERS).toContain('bash');
    expect(FORBIDDEN_GENERAL_INTERPRETERS).toContain('sh');
    expect(FORBIDDEN_GENERAL_INTERPRETERS).toContain('python3');
    expect(FORBIDDEN_GENERAL_INTERPRETERS).toContain('node');
    expect(FORBIDDEN_GENERAL_INTERPRETERS).not.toContain('ls');
  });
});

describe('إصلاح §5-0 — بوابة ProcessLauncher (allowlist basename + حظر المفسِّرات)', () => {
  const layer = new LinuxArchExecutionLayer({ execRoot: process.cwd() });

  it('يرفض node -e (المفسِّر العام الأبرز)', async () => {
    const pl = new ProcessLauncher(layer, new EventBus());
    const res = await pl.launch({ programId: 'x', binaryPath: 'node', args: ['-e', 'console.log("PWN")'], mode: 'managed' } as any);
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('general interpreter');
  });

  it('يرفض /bin/bash بمسار كامل', async () => {
    const pl = new ProcessLauncher(layer, new EventBus());
    const res = await pl.launch({ programId: 'x', binaryPath: '/bin/bash', args: ['-c', 'id'], mode: 'managed' } as any);
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('general interpreter');
  });

  it('يرفض binaryPath خارج allowlist (ثنائي تعسفي) حتى لو ELF سليم', async () => {
    const pl = new ProcessLauncher(layer, new EventBus());
    const res = await pl.launch({ programId: 'x', binaryPath: '/usr/libexec/evil-tool', args: [], mode: 'managed' } as any);
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('not in the launcher allowlist');
  });

  it('allowlist اللانشر لا يتضمن مفسِّرات عامة إطلاقاً', () => {
    for (const bin of LAUNCHER_ALLOWED_BINARIES) {
      expect(FORBIDDEN_GENERAL_INTERPRETERS).not.toContain(bin);
    }
  });
});

describe('إصلاح §5-0 — LauncherManager.resolveProgramBinary (لا افتراضي /bin/bash)', () => {
  it('يعيد undefined لبرنامج غير معروف بدل افتراضي خطير', () => {
    const launcher = new LauncherManager(
      new EventBus(),
      new CommandRegistry(),
      new LinuxArchExecutionLayer(),
      new SafeSystemStorageEngine('/vfs/launcher-vuln-test')
    );
    expect(launcher.resolveProgramBinary('terminal')).toBeUndefined();
    expect(launcher.resolveProgramBinary('nonexistent')).toBeUndefined();
  });

  it('يستوفي binaryPath من كتالوج مكتشف', async () => {
    const eventBus = new EventBus();
    const commandRegistry = new CommandRegistry();
    const executionLayer = new LinuxArchExecutionLayer();
    const storage = new SafeSystemStorageEngine('/vfs/launcher-vuln-catalog');
    const launcher = new LauncherManager(eventBus, commandRegistry, executionLayer, storage);

    const scanner = launcher['discoveryScanner'];
    const catalog = launcher['catalog'];
    const parsed = scanner.parseDesktopContent(
      '[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox %u\nCategories=Network;WebBrowser;',
      '/usr/share/applications/firefox.desktop',
      'system' as const
    );
    expect(parsed.isOk).toBe(true);
    if (parsed.isOk) {
      catalog['programs'].set(parsed.value.id, parsed.value);
      catalog['categorizeProgram'](parsed.value);
    }
    expect(launcher.resolveProgramBinary('firefox')).toBe('firefox');
  });
});
