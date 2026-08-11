import { Result, ok, err } from '../../kernel/core/result';
import { DisposableStore, Disposable } from '../../kernel/core/disposable';
import { EventBus } from '../../kernel/core/event-bus';

export interface SystemEngineConfig {
  engineId: string;
  eventBus?: EventBus;
}

export abstract class BaseSystemEngine implements Disposable {
  public readonly engineId: string;
  protected readonly eventBus?: EventBus;
  protected readonly disposables = new DisposableStore();
  protected isInitialized = false;
  protected isDisposed = false;

  constructor(config: SystemEngineConfig) {
    this.engineId = config.engineId;
    this.eventBus = config.eventBus;
  }

  public async initialize(): Promise<Result<void, Error>> {
    if (this.isDisposed) {
      return err(new Error(`EDISPOSED: Engine '${this.engineId}' has already been disposed`));
    }
    if (this.isInitialized) {
      return ok(undefined);
    }

    try {
      await this.onInitialize();
      this.isInitialized = true;
      if (this.eventBus) {
        this.eventBus.emit('engine:initialized', { engineId: this.engineId });
      }
      return ok(undefined);
    } catch (e: any) {
      return err(new Error(`EINIT_FAILED: Engine '${this.engineId}' initialization failed: ${e.message}`));
    }
  }

  protected abstract onInitialize(): Promise<void> | void;

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.isInitialized = false;

    try {
      this.onDispose();
    } catch (e: any) {
      console.error(`[BaseSystemEngine] Error during dispose of engine '${this.engineId}':`, e);
    } finally {
      this.disposables.dispose();
      if (this.eventBus) {
        this.eventBus.emit('engine:disposed', { engineId: this.engineId });
      }
    }
  }

  protected abstract onDispose(): void;
}
