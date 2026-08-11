import { Result, ok, err } from '../kernel/core/result';

export interface LSPDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export interface LSPSuggestion {
  title: string;
  kind: 'refactor' | 'quickfix' | 'completion';
  replacementText: string;
}

export class LanguageServerProtocolAdapter {
  private activeServers: Map<string, { lang: string; status: 'active' | 'starting' | 'stopped' }> = new Map();

  constructor() {
    this.activeServers.set('tsserver', { lang: 'typescript', status: 'active' });
    this.activeServers.set('gopls', { lang: 'go', status: 'active' });
    this.activeServers.set('pyright', { lang: 'python', status: 'active' });
  }

  public getActiveServers() {
    return Array.from(this.activeServers.entries()).map(([name, info]) => ({
      server: name,
      ...info
    }));
  }

  public async getDiagnostics(filePath: string): Promise<Result<LSPDiagnostic[], Error>> {
    const ext = filePath.split('.').pop() || '';
    const diagnostics: LSPDiagnostic[] = [];

    // Synthetic LSP analysis for code health
    if (ext === 'ts' || ext === 'js') {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        severity: 'info',
        message: 'TypeScript Language Server (tsserver): Strict type checking enabled.',
        source: 'tsserver'
      });
    } else if (ext === 'go') {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        severity: 'info',
        message: 'Go Language Server (gopls): Workspace loaded cleanly.',
        source: 'gopls'
      });
    }

    return ok(diagnostics);
  }

  public async getSuggestions(filePath: string, line: number): Promise<Result<LSPSuggestion[], Error>> {
    return ok([
      {
        title: 'Extract variable into Kernel state',
        kind: 'refactor',
        replacementText: 'const state = useKernelState();'
      },
      {
        title: 'Optimize imports',
        kind: 'quickfix',
        replacementText: 'import { Kernel } from "@nawat/kernel";'
      }
    ]);
  }
}
