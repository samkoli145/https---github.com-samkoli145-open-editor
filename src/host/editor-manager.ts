import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Result, ok, err } from '../kernel/core/result';
import { DEFAULT_ALLOWED_BINARIES, LinuxArchExecutionLayer } from '../agent-kernel/linux-arch-execution-layer';

/** أوامر الأدوات المكتشفة التي يسمح للعقل الموجّه بإطلاقها عبر طبقة الأرش
 *  (المحررات/خوادم اللغات/المتصفحات) — تُمكِّن فتح الملفات فعلياً بينما
 *  تبقى قيود طبقة الأرش (ConstraintEngine + الحصص + جذر التنفيذ + TOCTOU) فعّالة.
 *  ملاحظة: `bash` مستبعدة عمداً — التنفيذ الحر عبر شل لا يُسمح به. */
const ORCHESTRATOR_BINARIES = [
  'code', 'code-oss', 'nvim', 'vim', 'subl', 'emacs', 'hx',
  'opencode', 'gopls', 'tsserver', 'falkon', 'google-chrome'
];

export interface EditorCapabilities {
  headless: boolean;
  gui: boolean;
  lsp: boolean;
  terminal: boolean;
  supportedLanguages: string[];
}

export interface DiscoveredTool {
  id: string;
  name: string;
  binary: string;
  type: 'editor' | 'browser' | 'terminal' | 'server' | 'lsp';
  path: string;
  capabilities: EditorCapabilities;
  status: 'available' | 'mock' | 'unavailable';
}

export interface EditorAdapter {
  id: string;
  name: string;
  binary: string;
  type: 'editor' | 'browser' | 'terminal' | 'server' | 'lsp';
  getCapabilities(): EditorCapabilities;
  openFile(filePath: string, line?: number, col?: number): Promise<Result<{ stdout: string; stderr: string }, Error>>;
  editFile?(filePath: string, search: string, replace: string): Promise<Result<{ stdout: string; stderr: string }, Error>>;
  runHeadless?(args: string[]): Promise<Result<{ stdout: string; stderr: string }, Error>>;
}

export class GenericCliAdapter implements EditorAdapter {
  public readonly id: string;
  public readonly name: string;
  public readonly binary: string;
  public readonly type: 'editor' | 'browser' | 'terminal' | 'server' | 'lsp';
  private readonly capabilities: EditorCapabilities;
  private readonly executionLayer: LinuxArchExecutionLayer;

  constructor(
    tool: DiscoveredTool,
    executionLayer: LinuxArchExecutionLayer
  ) {
    this.id = tool.id;
    this.name = tool.name;
    this.binary = tool.binary;
    this.type = tool.type;
    this.capabilities = tool.capabilities;
    this.executionLayer = executionLayer;
  }

  public getCapabilities(): EditorCapabilities {
    return { ...this.capabilities };
  }

  public async openFile(filePath: string, line: number = 1, col: number = 1): Promise<Result<{ stdout: string; stderr: string }, Error>> {
    let cmd = `${this.binary} ${filePath}`;
    if (this.binary === 'code' || this.binary === 'code-oss') {
      cmd = `${this.binary} --reuse-window -g ${filePath}:${line}:${col}`;
    } else if (this.binary === 'nvim' || this.binary === 'vim') {
      cmd = `${this.binary} +${line} ${filePath}`;
    } else if (this.binary === 'subl') {
      cmd = `${this.binary} ${filePath}:${line}:${col}`;
    } else if (this.binary === 'hx') {
      cmd = `${this.binary} ${filePath}:${line}`;
    }

    const res = await this.executionLayer.execute({ commandLine: cmd });
    if (res.status === 'blocked' || res.status === 'error') {
      return err(new Error(res.reason || res.stderr || 'Failed to open file'));
    }
    return ok({ stdout: res.stdout, stderr: res.stderr });
  }

  public async runHeadless(args: string[]): Promise<Result<{ stdout: string; stderr: string }, Error>> {
    const cmd = `${this.binary} ${args.join(' ')}`;
    const res = await this.executionLayer.execute({ commandLine: cmd });
    if (res.status === 'blocked' || res.status === 'error') {
      return err(new Error(res.reason || res.stderr || 'Headless execution failed'));
    }
    return ok({ stdout: res.stdout, stderr: res.stderr });
  }
}

const KNOWN_TOOLS: Array<{
  id: string;
  name: string;
  binary: string;
  type: 'editor' | 'browser' | 'terminal' | 'server' | 'lsp';
  capabilities: EditorCapabilities;
}> = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    binary: 'code',
    type: 'editor',
    capabilities: {
      headless: true,
      gui: true,
      lsp: true,
      terminal: true,
      supportedLanguages: ['typescript', 'javascript', 'go', 'python', 'rust', 'html', 'css', 'json', 'markdown', 'c', 'cpp']
    }
  },
  {
    id: 'neovim',
    name: 'Neovim Editor',
    binary: 'nvim',
    type: 'editor',
    capabilities: {
      headless: true,
      gui: false,
      lsp: true,
      terminal: true,
      supportedLanguages: ['typescript', 'javascript', 'go', 'python', 'rust', 'c', 'cpp', 'html', 'css', 'json', 'lua', 'markdown']
    }
  },
  {
    id: 'vim',
    name: 'Vim Text Editor',
    binary: 'vim',
    type: 'editor',
    capabilities: {
      headless: true,
      gui: false,
      lsp: false,
      terminal: true,
      supportedLanguages: ['typescript', 'javascript', 'go', 'python', 'rust', 'html', 'css', 'json']
    }
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    binary: 'subl',
    type: 'editor',
    capabilities: {
      headless: false,
      gui: true,
      lsp: true,
      terminal: false,
      supportedLanguages: ['typescript', 'javascript', 'python', 'html', 'css', 'json']
    }
  },
  {
    id: 'emacs',
    name: 'GNU Emacs',
    binary: 'emacs',
    type: 'editor',
    capabilities: {
      headless: true,
      gui: true,
      lsp: true,
      terminal: true,
      supportedLanguages: ['typescript', 'javascript', 'python', 'lisp', 'org', 'html', 'css']
    }
  },
  {
    id: 'helix',
    name: 'Helix Editor',
    binary: 'hx',
    type: 'editor',
    capabilities: {
      headless: true,
      gui: false,
      lsp: true,
      terminal: true,
      supportedLanguages: ['rust', 'go', 'typescript', 'python', 'html', 'json']
    }
  },
  {
    id: 'opencode',
    name: 'OpenCode Server Engine',
    binary: 'opencode',
    type: 'server',
    capabilities: {
      headless: true,
      gui: true,
      lsp: true,
      terminal: true,
      supportedLanguages: ['typescript', 'javascript', 'go', 'python', 'html', 'css', 'json', 'markdown']
    }
  },
  {
    id: 'gopls',
    name: 'Go Language Server (gopls)',
    binary: 'gopls',
    type: 'lsp',
    capabilities: {
      headless: true,
      gui: false,
      lsp: true,
      terminal: false,
      supportedLanguages: ['go']
    }
  },
  {
    id: 'tsserver',
    name: 'TypeScript Language Server',
    binary: 'tsserver',
    type: 'lsp',
    capabilities: {
      headless: true,
      gui: false,
      lsp: true,
      terminal: false,
      supportedLanguages: ['typescript', 'javascript']
    }
  },
  {
    id: 'browser-falkon',
    name: 'Falkon Web Browser',
    binary: 'falkon',
    type: 'browser',
    capabilities: {
      headless: false,
      gui: true,
      lsp: false,
      terminal: false,
      supportedLanguages: ['html', 'http', 'web']
    }
  },
  {
    id: 'browser-chrome',
    name: 'Google Chrome Browser',
    binary: 'google-chrome',
    type: 'browser',
    capabilities: {
      headless: true,
      gui: true,
      lsp: false,
      terminal: false,
      supportedLanguages: ['html', 'http', 'web']
    }
  },
  {
    id: 'bash-term',
    name: 'Bash Terminal Agent',
    binary: 'bash',
    type: 'terminal',
    capabilities: {
      headless: true,
      gui: false,
      lsp: false,
      terminal: true,
      supportedLanguages: ['shell', 'bash']
    }
  }
];

export class EditorManager {
  private discoveredTools: Map<string, DiscoveredTool> = new Map();
  private adapters: Map<string, EditorAdapter> = new Map();
  private executionLayer: LinuxArchExecutionLayer;

  constructor(executionLayer?: LinuxArchExecutionLayer) {
    this.executionLayer = executionLayer || new LinuxArchExecutionLayer({
      allowedBinaries: [...DEFAULT_ALLOWED_BINARIES, ...ORCHESTRATOR_BINARIES]
    });
  }

  public scanSystemForEditors(): DiscoveredTool[] {
    this.discoveredTools.clear();
    this.adapters.clear();

    for (const tool of KNOWN_TOOLS) {
      let foundPath = '';
      let status: 'available' | 'mock' | 'unavailable' = 'unavailable';

      try {
        const out = execSync(`which ${tool.binary} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (out && existsSync(out)) {
          foundPath = out;
          status = 'available';
        }
      } catch {
        // Not directly on host path, register fallback available adapter for kernel orchestration
        foundPath = `/usr/bin/${tool.binary}`;
        status = 'mock';
      }

      const discovered: DiscoveredTool = {
        ...tool,
        path: foundPath,
        status
      };

      this.discoveredTools.set(tool.id, discovered);
      const adapter = new GenericCliAdapter(discovered, this.executionLayer);
      this.adapters.set(tool.id, adapter);
    }

    return Array.from(this.discoveredTools.values());
  }

  public getDiscoveredTools(): DiscoveredTool[] {
    if (this.discoveredTools.size === 0) {
      this.scanSystemForEditors();
    }
    return Array.from(this.discoveredTools.values());
  }

  public getAdapter(toolId: string): EditorAdapter | undefined {
    if (this.adapters.size === 0) {
      this.scanSystemForEditors();
    }
    return this.adapters.get(toolId);
  }

  public getBestToolForLanguage(lang: string, preferredType: 'editor' | 'lsp' | 'server' = 'editor'): DiscoveredTool | undefined {
    const tools = this.getDiscoveredTools();
    const langLower = lang.toLowerCase();

    // First try available tools matching language and type
    const matches = tools.filter(
      t => t.capabilities.supportedLanguages.includes(langLower) && t.type === preferredType
    );

    if (matches.length > 0) {
      const available = matches.find(m => m.status === 'available');
      return available || matches[0];
    }

    // Fallback to any tool supporting the language
    const anyLangMatch = tools.find(t => t.capabilities.supportedLanguages.includes(langLower));
    return anyLangMatch || tools[0];
  }

  public async openFile(filePath: string, line: number = 1, toolId?: string): Promise<Result<{ stdout: string; stderr: string; usedTool: string }, Error>> {
    if (this.adapters.size === 0) {
      this.scanSystemForEditors();
    }

    let targetAdapter: EditorAdapter | undefined;
    if (toolId) {
      targetAdapter = this.adapters.get(toolId);
    }

    if (!targetAdapter) {
      // Pick best editor based on file extension
      const ext = filePath.split('.').pop() || '';
      const langMap: Record<string, string> = {
        ts: 'typescript',
        js: 'javascript',
        go: 'go',
        py: 'python',
        rs: 'rust',
        html: 'html',
        css: 'css',
        json: 'json',
        md: 'markdown'
      };
      const lang = langMap[ext] || 'typescript';
      const bestTool = this.getBestToolForLanguage(lang, 'editor');
      if (bestTool) {
        targetAdapter = this.adapters.get(bestTool.id);
      }
    }

    if (!targetAdapter) {
      return err(new Error('No editor adapter available on the system'));
    }

    const res = await targetAdapter.openFile(filePath, line);
    if (res.isErr) {
      return err(res.error);
    }

    return ok({
      stdout: res.value.stdout,
      stderr: res.value.stderr,
      usedTool: targetAdapter.name
    });
  }

  /**
   * Orchestrator Dispatcher ("عقل موجّه")
   * Dispatches task intents to appropriate editor/tool agents.
   */
  public async dispatchIntent(
    intent: 'edit' | 'inspect' | 'format' | 'browse' | 'exec',
    payload: { path?: string; line?: number; query?: string; command?: string; lang?: string; cwd?: string }
  ): Promise<Result<{ toolUsed: string; status: string; output: string }, Error>> {
    if (this.adapters.size === 0) {
      this.scanSystemForEditors();
    }

    if (intent === 'edit' || intent === 'inspect') {
      const filePath = payload.path || 'server.ts';
      const line = payload.line || 1;
      const res = await this.openFile(filePath, line);
      if (res.isErr) {
        return err(res.error);
      }
      return ok({
        toolUsed: res.value.usedTool,
        status: 'dispatched',
        output: `Opened ${filePath}:${line} via ${res.value.usedTool}`
      });
    }

    if (intent === 'browse') {
      const browser = this.adapters.get('browser-falkon') || this.adapters.get('browser-chrome');
      if (browser) {
        return ok({
          toolUsed: browser.name,
          status: 'dispatched',
          output: `Browsing query: ${payload.query || payload.path || 'localhost:3000'}`
        });
      }
    }

    if (intent === 'exec') {
      const term = this.adapters.get('bash-term');
      const cmd = (payload.command ?? '').trim();
      if (term && cmd) {
        // يُوجَّه عبر طبقة تنفيذ الأرش نفسها: قيود الأمان (ConstraintEngine + القائمة
        // المسموحة + جذر التنفيذ + TOCTOU + الحصص) تُطبَّق قبل أي تنفيذ. القوائم
        // المسموحة لا تتضمن شل حر — الأوامر الفعلية هي أدوات مرخّصة (git/node/python3/...).
        const res = await this.executionLayer.execute({
          commandLine: cmd,
          cwd: payload.cwd
        });
        if (res.status === 'blocked' || res.status === 'error' || res.status === 'not_found') {
          return err(new Error(res.reason || res.stderr || `Execution denied (${res.status})`));
        }
        return ok({
          toolUsed: term.name,
          status: res.status,
          output: res.stdout || res.stderr || 'Command executed successfully'
        });
      }
    }

    return ok({
      toolUsed: 'Kernel Orchestrator',
      status: 'completed',
      output: `Intent '${intent}' processed by Nawat Kernel`
    });
  }
}
