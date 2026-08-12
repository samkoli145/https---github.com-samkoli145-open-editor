import { Result, ok, err } from '../kernel/core/result';
import { CommandRegistry } from '../kernel/command-registry';
import { evaluateMathExpression } from './math-eval';

export interface ToolDefinition {
  name: string;
  description: string;
  owner: string;
  requiredPermission?: string;
  handler: (args: any, context?: any) => Promise<any> | any;
}

export interface ToolExecutionContext {
  owner?: string;
  permissions?: Set<string> | string[];
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private commandRegistry?: CommandRegistry;

  constructor(commandRegistry?: CommandRegistry) {
    this.commandRegistry = commandRegistry;
    this.registerBuiltInTools();
  }

  public attachCommandRegistry(registry: CommandRegistry): void {
    this.commandRegistry = registry;
    for (const tool of this.tools.values()) {
      this.syncToolToCommand(tool);
    }
  }

  private syncToolToCommand(def: ToolDefinition): void {
    if (!this.commandRegistry) return;
    this.commandRegistry.register({
      id: `tool.${def.name}`,
      title: { ar: `أداة ${def.name}`, en: `Tool ${def.name}` },
      category: { ar: 'الأدوات', en: 'Tools' },
      description: { ar: def.description, en: def.description },
      handler: (args: any) => this.executeTool(def.name, args)
    });
  }

  public registerTool(def: ToolDefinition): Result<void, Error> {
    if (!def.name || typeof def.name !== 'string') {
      return err(new Error('EINVAL: Tool name must be a non-empty string'));
    }
    if (this.tools.has(def.name)) {
      const existing = this.tools.get(def.name)!;
      if (existing.owner !== def.owner) {
        return err(new Error(`EPERM: Tool '${def.name}' belongs to owner '${existing.owner}'`));
      }
    }
    this.tools.set(def.name, def);
    this.syncToolToCommand(def);
    return ok(undefined);
  }

  public unregisterTool(name: string, owner?: string): Result<void, Error> {
    const existing = this.tools.get(name);
    if (!existing) {
      return err(new Error(`ENOENT: Tool '${name}' not found`));
    }
    if (owner && existing.owner !== owner) {
      return err(new Error(`EPERM: Cannot unregister tool '${name}' owned by '${existing.owner}'`));
    }
    this.tools.delete(name);
    return ok(undefined);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public async executeTool(
    name: string,
    args: any = {},
    context?: ToolExecutionContext
  ): Promise<Result<any, Error>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return err(new Error(`ENOENT: Tool '${name}' not found`));
    }

    // Permission enforcement
    if (tool.requiredPermission) {
      const userPerms = context?.permissions;
      let hasPerm = false;
      if (userPerms) {
        if (userPerms instanceof Set) {
          hasPerm = userPerms.has(tool.requiredPermission) || userPerms.has('*');
        } else if (Array.isArray(userPerms)) {
          hasPerm = userPerms.includes(tool.requiredPermission) || userPerms.includes('*');
        }
      }
      if (!hasPerm) {
        return err(new Error(`EPERM: Permission '${tool.requiredPermission}' required to execute tool '${name}'`));
      }
    }

    try {
      const result = await tool.handler(args, context);
      return ok(result);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`EEXEC: Tool execution failed for '${name}': ${msg}`));
    }
  }

  private registerBuiltInTools(): void {
    // 1. echo
    this.registerTool({
      name: 'echo',
      description: 'Echoes back the input message or object safely',
      owner: 'system',
      handler: (args: any) => {
        if (typeof args === 'string') return args;
        if (args && typeof args === 'object' && 'message' in args) return args.message;
        return args;
      }
    });

    // 2. calc
    this.registerTool({
      name: 'calc',
      description: 'Performs safe basic arithmetic calculations (add, sub, mul, div)',
      owner: 'system',
      handler: (args: any) => {
        const expr = typeof args === 'string' ? args : args?.expr || args?.expression;
        if (!expr || typeof expr !== 'string') {
          throw new Error('Invalid arithmetic expression');
        }
        // محلّل حسابي خاص (recursive descent) — لا eval ولا new Function
        try {
          return evaluateMathExpression(expr);
        } catch (e: any) {
          throw new Error(`Math syntax error: ${e.message}`);
        }
      }
    });

    // 3. now
    this.registerTool({
      name: 'now',
      description: 'Returns current timestamp and ISO string',
      owner: 'system',
      handler: () => {
        const now = new Date();
        return {
          timestamp: now.getTime(),
          iso: now.toISOString()
        };
      }
    });
  }
}
