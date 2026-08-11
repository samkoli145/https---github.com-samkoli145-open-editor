import { EventBus } from './core/event-bus';
import { Result, ok, err } from './core/result';
import { CommandRegistry } from './command-registry';
import { ServiceContainer } from './service-container';
import { Scheduler } from './scheduler';
import { ExtensionManager } from './extension-manager';

export interface KernelContext {
  events: EventBus;
  commands: CommandRegistry;
  services: ServiceContainer;
  scheduler: Scheduler;
  extensions: ExtensionManager;
}

export class Kernel {
  private events = new EventBus();
  private commands = new CommandRegistry();
  private services = new ServiceContainer();
  private scheduler = new Scheduler();
  private extensions = new ExtensionManager();
  private isReady = false;

  async boot(): Promise<Result<KernelContext, Error>> {
    if (this.isReady) {
      return ok(this.getContext());
    }

    try {
      this.isReady = true;
      this.events.emit('kernel:ready', { timestamp: Date.now() });

      return ok(this.getContext());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Kernel boot error: ${msg}`));
    }
  }

  async shutdown(): Promise<Result<void, Error>> {
    if (!this.isReady) return ok(undefined);

    try {
      this.events.emit('kernel:beforeShutdown', { timestamp: Date.now() });
      this.scheduler.cancelAll();
      const deactivateRes = await this.extensions.deactivateAll();

      this.isReady = false;
      this.events.emit('kernel:shutdown', {
        timestamp: Date.now(),
        hadErrors: deactivateRes.isErr,
      });

      if (deactivateRes.isErr) {
        return err(deactivateRes.error);
      }

      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Kernel shutdown error: ${msg}`));
    }
  }

  getContext(): KernelContext {
    return {
      events: this.events,
      commands: this.commands,
      services: this.services,
      scheduler: this.scheduler,
      extensions: this.extensions,
    };
  }
}
