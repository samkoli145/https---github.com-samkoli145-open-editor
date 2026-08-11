import { Disposable } from './core/disposable';
import { Result, ok, err } from './core/result';
import { LocalizedString } from './i18n/localized-string';

export interface CommandDefinition<T = unknown> {
  id: string;
  title: LocalizedString;
  category?: LocalizedString;
  description?: LocalizedString;
  shortcut?: string;
  isEnabled?: (payload?: unknown) => boolean | Promise<boolean>;
  handler: (payload?: unknown) => Promise<T> | T;
}

export interface CommandExecutionRecord {
  id: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private executionLog: CommandExecutionRecord[] = [];
  private readonly maxLogHistory = 200;

  /**
   * تسجيل أمر جديد في السجل مع دعم ربط التخلّص منه بمالك (DisposableStore/Array)
   */
  register<T>(
    def: CommandDefinition<T>,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    if (this.commands.has(def.id)) {
      console.warn(`[CommandRegistry] Command '${def.id}' is being re-registered. Previous definition will be replaced.`);
    }
    const genericDef = def as CommandDefinition<unknown>;
    this.commands.set(def.id, genericDef);

    const disposable: Disposable = {
      dispose: () => {
        // حماية من التخلّص الخاطئ: لا نحذف إلا إذا كان هذا المرجع هو المسجل حالياً
        if (this.commands.get(def.id) === genericDef) {
          this.commands.delete(def.id);
        }
      },
    };

    if (owner) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  async execute<T>(id: string, payload?: unknown): Promise<Result<T, Error>> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      const errorMsg = `Command '${id}' not found`;
      this.logExecution(id, false, errorMsg);
      return err(new Error(errorMsg));
    }

    if (cmd.isEnabled) {
      try {
        const enabled = await cmd.isEnabled(payload);
        if (!enabled) {
          const disabledMsg = `Command '${id}' is currently disabled`;
          this.logExecution(id, false, disabledMsg);
          return err(new Error(disabledMsg));
        }
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        const disabledErr = `Command '${id}' enablement check failed: ${errStr}`;
        this.logExecution(id, false, disabledErr);
        return err(new Error(disabledErr));
      }
    }

    try {
      const res = await cmd.handler(payload);
      this.logExecution(id, true);
      return ok(res as T);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.logExecution(id, false, errorMsg);
      return err(new Error(errorMsg));
    }
  }

  getCommand(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  getLog(): ReadonlyArray<CommandExecutionRecord> {
    return [...this.executionLog];
  }

  clear(): void {
    this.commands.clear();
    this.executionLog = [];
  }

  private logExecution(id: string, success: boolean, error?: string) {
    this.executionLog.push({
      id,
      timestamp: Date.now(),
      success,
      error,
    });
    if (this.executionLog.length > this.maxLogHistory) {
      this.executionLog.shift();
    }
  }
}

