import { describe, it, expect } from 'vitest';
import { EditorManager } from '../src/host/editor-manager';
import { LanguageServerProtocolAdapter } from '../src/host/lsp-adapter';
import { Bootloader } from '../src/host/bootloader';

// ---------------------------------------------------------------------------
// العقل الموجّه (Orchestrator Kernel): اكتشاف أدوات النظام وتوجيه المهام إليها
// كأطراف تنفيذية — محررات/خوادم لغات/متصفحات/وكلاء طرفية، عبر بوابات طبقة الأرش.
// ---------------------------------------------------------------------------

describe('EditorManager — tool discovery (العقل الموجه: اكتشاف الأدوات)', () => {
  it('discovers the known developer tools with available/mock status', () => {
    const mgr = new EditorManager();
    const tools = mgr.scanSystemForEditors();
    expect(tools.length).toBeGreaterThan(10);
    const ids = tools.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([
      'vscode', 'neovim', 'vim', 'sublime', 'emacs', 'helix',
      'opencode', 'gopls', 'tsserver', 'browser-chrome', 'bash-term'
    ]));
    for (const t of tools) {
      expect(['available', 'mock']).toContain(t.status);
      expect(typeof t.binary).toBe('string');
      expect(t.path.length).toBeGreaterThan(0);
    }
  });

  it('picks gopls as the best LSP for go', () => {
    const mgr = new EditorManager();
    expect(mgr.getBestToolForLanguage('go', 'lsp')?.id).toBe('gopls');
  });

  it('picks an editor supporting typescript for edit intents', () => {
    const mgr = new EditorManager();
    const best = mgr.getBestToolForLanguage('typescript', 'editor');
    expect(best?.type).toBe('editor');
    expect(best?.capabilities.supportedLanguages).toContain('typescript');
  });
});

describe('EditorManager — orchestrator dispatch (توجيه العقل الموجّه)', () => {
  it('dispatches an exec intent through the arch gates for an allowlisted command', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('exec', { command: 'echo orch-ok' });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.toolUsed).toBe('Bash Terminal Agent');
      expect(res.value.output).toContain('orch-ok');
    }
  });

  it('denies an exec intent that escapes the execution root', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('exec', { command: 'cat /etc/hostname' });
    expect(res.isErr).toBe(true);
    if (res.isErr) {
      expect(res.error.message).toMatch(/outside the execution root/);
    }
  });

  it('denies an exec intent via a shell (bash is not allowlisted)', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('exec', { command: 'bash -c "id"' });
    expect(res.isErr).toBe(true);
    if (res.isErr) {
      expect(res.error.message).toContain('allowlist');
    }
  });

  it('denies a destructive exec intent (rm -rf via constraint engine)', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('exec', { command: 'rm -rf /tmp/nonexistent' });
    expect(res.isErr).toBe(true);
  });

  it('dispatches an inspect intent to the chosen editor tool', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('inspect', { path: 'src/index.ts', line: 3 });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.status).toBe('dispatched');
      expect(res.value.toolUsed).toBeTruthy();
      expect(res.value.output).toContain('src/index.ts');
    }
  });

  it('handles a browse intent via a browser agent', async () => {
    const mgr = new EditorManager();
    const res = await mgr.dispatchIntent('browse', { query: 'kernel orchestration' });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.status).toBe('dispatched');
      expect(res.value.output).toContain('kernel orchestration');
    }
  });
});

describe('LanguageServerProtocolAdapter — LSP diagnostics (قراءة التشخيصات)', () => {
  it('reports active language servers', () => {
    const lsp = new LanguageServerProtocolAdapter();
    const servers = lsp.getActiveServers();
    expect(servers).toHaveLength(3);
    expect(servers.map((s) => s.server)).toEqual(expect.arrayContaining(['tsserver', 'gopls', 'pyright']));
  });

  it('returns a tsserver diagnostic for TypeScript files', async () => {
    const lsp = new LanguageServerProtocolAdapter();
    const res = await lsp.getDiagnostics('/tmp/example.ts');
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.length).toBeGreaterThan(0);
      expect(res.value[0].source).toBe('tsserver');
    }
  });

  it('returns a gopls diagnostic for Go files', async () => {
    const lsp = new LanguageServerProtocolAdapter();
    const res = await lsp.getDiagnostics('main.go');
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value[0].source).toBe('gopls');
    }
  });

  it('returns no diagnostics for unsupported extensions', async () => {
    const lsp = new LanguageServerProtocolAdapter();
    const res = await lsp.getDiagnostics('README.md');
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value).toEqual([]);
    }
  });

  it('returns refactor/quickfix suggestions', async () => {
    const lsp = new LanguageServerProtocolAdapter();
    const res = await lsp.getSuggestions('file.ts', 1);
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.length).toBeGreaterThan(0);
      expect(res.value[0].kind).toBe('refactor');
    }
  });
});

describe('Bootloader — orchestrator commands (أوامر العقل الموجّه)', () => {
  it('registers host.editor.scan and returns discovered tools', async () => {
    const bootloader = new Bootloader({ profile: 'editor' });
    const runtime = await bootloader.boot();
    const exec = await runtime.executeSyscall('host.editor.scan', {});
    expect(Array.isArray(exec)).toBe(true);
    expect((exec as any[]).length).toBeGreaterThan(0);
    await bootloader.shutdown({ timeoutMs: 2000 });
  });

  it('registers host.orchestrator.dispatch for an exec intent', async () => {
    const bootloader = new Bootloader({ profile: 'editor' });
    const runtime = await bootloader.boot();
    const exec = await runtime.executeSyscall('host.orchestrator.dispatch', { intent: 'exec', command: 'echo boot-orch' });
    expect((exec as any)?.output).toContain('boot-orch');
    await bootloader.shutdown({ timeoutMs: 2000 });
  });

  it('registers host.lsp.diagnose for a TypeScript file', async () => {
    const bootloader = new Bootloader({ profile: 'editor' });
    const runtime = await bootloader.boot();
    const diags = await runtime.executeSyscall('host.lsp.diagnose', { path: 'file.ts' });
    expect(Array.isArray(diags)).toBe(true);
    expect((diags as any[]).length).toBeGreaterThan(0);
    await bootloader.shutdown({ timeoutMs: 2000 });
  });
});
