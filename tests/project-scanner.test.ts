import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersistentIndexer, scanProject } from '../src/index';

function bytesChecksum(buf: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const SHEBANG_PY = '#!/usr/bin/env python3\nprint("hi")';
const ELF_HEADER = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeProject(): { root: string; outsideDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'scan-proj-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'scan-out-'));
  cleanup.push(root, outsideDir);

  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'notes'));

  writeFileSync(join(root, 'src', 'main.py'), SHEBANG_PY);
  chmodSync(join(root, 'src', 'main.py'), 0o755);

  writeFileSync(join(root, 'bin', 'tool.elf'), Buffer.from(ELF_HEADER));
  chmodSync(join(root, 'bin', 'tool.elf'), 0o755);

  writeFileSync(join(root, 'notes', 'ideas.md'), '# ideas\n- scan');
  writeFileSync(join(root, '.hidden_secret'), 'do not index me');
  chmodSync(join(root, '.hidden_secret'), 0o700);

  writeFileSync(join(root, 'suid.sh'), '#!/bin/sh\necho root\n');
  chmodSync(join(root, 'suid.sh'), 0o4755);

  writeFileSync(join(root, 'evil\u200b.sh'), '#!/bin/sh\necho hidden\n');
  chmodSync(join(root, 'evil\u200b.sh'), 0o755);

  writeFileSync(join(outsideDir, 'outside.txt'), 'outside content');
  symlinkSync(join(outsideDir, 'outside.txt'), join(root, 'escape_link.sh'));
  symlinkSync(join(root, 'src', 'main.py'), join(root, 'inside_link.sh'));

  return { root, outsideDir };
}

describe('Project Scanner (external project inspection)', () => {
  it('flags hidden files and directories (dotfiles and control-char names)', () => {
    const { root } = makeProject();
    const report = scanProject(root);

    expect(report.counts.hidden).toBeGreaterThanOrEqual(3);
    expect(report.hidden.some((p) => p.endsWith('.hidden_secret'))).toBe(true);
    expect(report.hidden.some((p) => p.includes('evil\u200b.sh'))).toBe(true);
    const hiddenFinding = report.findings.find((f) => f.path.endsWith('.hidden_secret'));
    expect(hiddenFinding?.kind).toBe('hidden');
  });

  it('flags executable programs (ELF binaries and shebang scripts)', () => {
    const { root } = makeProject();
    const report = scanProject(root);

    const main = report.executables.find((e) => e.path.endsWith('main.py'));
    const tool = report.executables.find((e) => e.path.endsWith('tool.elf'));
    expect(main?.kind).toBe('script');
    expect(tool?.kind).toBe('elf');
    expect(report.executables.length).toBeGreaterThanOrEqual(3);
  });

  it('flags setuid/setgid executables as backdoors (privilege escalation)', () => {
    const { root } = makeProject();
    const report = scanProject(root);

    expect(report.counts.backdoor).toBe(1);
    const suid = report.findings.find((f) => f.path.endsWith('suid.sh'));
    expect(suid?.kind).toBe('backdoor');
    expect(suid?.detail).toContain('setuid');
  });

  it('flags symlinks escaping the project root', () => {
    const { root } = makeProject();
    const report = scanProject(root);

    expect(report.counts.outside_link).toBe(1);
    expect(report.outsideLinks.some((p) => p.endsWith('escape_link.sh'))).toBe(true);
  });

  it('reports regular source files as ok when no index is provided', () => {
    const { root } = makeProject();
    const report = scanProject(root);

    const ideas = report.findings.find((f) => f.path.endsWith('ideas.md'));
    expect(ideas?.kind).toBe('ok');
  });

  it('reports unregistered (planted), tampered, ok, and missing against the index', () => {
    const { root } = makeProject();
    const indexer = new PersistentIndexer(root);

    const mainBytes = Buffer.from(SHEBANG_PY);
    indexer.registerFile(join(root, 'src', 'main.py'), mainBytes, bytesChecksum(mainBytes), 0o755);
    indexer.registerFile(join(root, 'notes', 'ideas.md'), Buffer.from('# ideas\n- scan'), bytesChecksum(Buffer.from('# ideas\n- scan')), 0o644);
    indexer.registerFile(join(root, 'ghost.txt'), Buffer.from('gone'), bytesChecksum(Buffer.from('gone')), 0o644);

    writeFileSync(join(root, 'bin', 'planted.bin'), 'planted by an intruder');

    const tampered = Buffer.from(SHEBANG_PY + '\nprint("backdoored")');
    writeFileSync(join(root, 'src', 'main.py'), tampered);

    const report = scanProject(root, indexer);

    expect(report.counts.unregistered).toBeGreaterThanOrEqual(1);
    expect(report.counts.tampered).toBe(1);
    expect(report.counts.missing).toBe(1);
    expect(report.counts.ok).toBeGreaterThanOrEqual(1);

    const tamperedFinding = report.findings.find((f) => f.kind === 'tampered');
    expect(tamperedFinding?.path.endsWith('main.py')).toBe(true);
    const ghostFinding = report.findings.find((f) => f.kind === 'missing');
    expect(ghostFinding?.path.endsWith('ghost.txt')).toBe(true);
  });
});
