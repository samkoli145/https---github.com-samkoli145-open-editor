import { Result, ok, err } from './core/result';
import { LocalizedString } from './i18n/localized-string';

export interface Extension {
  id: string;
  name: LocalizedString;
  version: string;
  activate: () => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}

export class ExtensionManager {
  private activeExtensions = new Map<string, Extension>();

  async activate(extension: Extension): Promise<Result<void, Error>> {
    if (this.activeExtensions.has(extension.id)) {
      return ok(undefined);
    }

    try {
      await extension.activate();
      this.activeExtensions.set(extension.id, extension);
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to activate extension ${extension.id}: ${msg}`));
    }
  }

  async deactivate(extensionId: string): Promise<Result<void, Error>> {
    const ext = this.activeExtensions.get(extensionId);
    if (!ext) {
      return ok(undefined);
    }

    try {
      if (ext.deactivate) {
        await ext.deactivate();
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to deactivate extension ${extensionId}: ${msg}`));
    } finally {
      this.activeExtensions.delete(extensionId);
    }
  }

  async deactivateAll(): Promise<Result<void, Error>> {
    const activeList = Array.from(this.activeExtensions.values()).reverse();
    const errors: string[] = [];

    for (const ext of activeList) {
      const res = await this.deactivate(ext.id);
      if (res.isErr) {
        errors.push(res.error.message);
      }
    }

    if (errors.length > 0) {
      return err(new Error(`Errors during deactivateAll:\n${errors.join('\n')}`));
    }

    return ok(undefined);
  }

  get(extensionId: string): Extension | undefined {
    return this.activeExtensions.get(extensionId);
  }

  isActivated(extensionId: string): boolean {
    return this.activeExtensions.has(extensionId);
  }

  list(): Extension[] {
    return Array.from(this.activeExtensions.values());
  }

  getActiveCount(): number {
    return this.activeExtensions.size;
  }
}
