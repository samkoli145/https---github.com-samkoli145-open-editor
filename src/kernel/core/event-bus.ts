import { Disposable } from './disposable';
import { EventName, EventHandler, SystemEvent } from './types';

export interface EventBusHandlerError {
  readonly eventName: EventName;
  readonly error: string;
  readonly timestamp: number;
}

export interface EventBusOptions {
  readonly onError?: (eventName: EventName, error: unknown, event: SystemEvent) => void;
  readonly maxHistory?: number;
}

export class EventBus {
  private handlers = new Map<EventName, Set<EventHandler>>();
  private history: SystemEvent[] = [];
  private handlerErrors: EventBusHandlerError[] = [];
  private eventCounter = 0;
  private readonly maxHistory: number;
  private readonly onError?: (eventName: EventName, error: unknown, event: SystemEvent) => void;

  constructor(options: EventBusOptions = {}) {
    this.maxHistory = options.maxHistory ?? 100;
    this.onError = options.onError;
  }

  emit<T>(name: EventName, payload: T): void {
    const event: SystemEvent<T> = {
      id: `${Date.now()}-${++this.eventCounter}`,
      name,
      payload,
      timestamp: Date.now(),
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const set = this.handlers.get(name);
    if (set) {
      for (const handler of set) {
        try {
          handler(event);
        } catch (err: any) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.handlerErrors.push({
            eventName: name,
            error: errMsg,
            timestamp: Date.now(),
          });
          if (this.handlerErrors.length > this.maxHistory) {
            this.handlerErrors.shift();
          }
          if (this.onError) {
            try {
              this.onError(name, err, event);
            } catch (onErrorErr) {
              console.error(`[EventBus] onError handler itself threw for '${name}':`, onErrorErr);
            }
          } else {
            console.error(`[EventBus] Error in event handler for '${name}':`, err);
          }
        }
      }
    }
  }

  /**
   * الاشتراك في حدث مفروض الربط بمالك (DisposableStore أو مصفوفة Disposables) لمنع تسريب الذاكرة تلقائياً.
   */
  on<T>(
    name: EventName,
    handler: EventHandler<T>,
    owner: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    if (!this.handlers.has(name)) {
      this.handlers.set(name, new Set());
    }
    const set = this.handlers.get(name)!;
    const genericHandler = handler as EventHandler<unknown>;
    set.add(genericHandler);

    const disposable: Disposable = {
      dispose: () => {
        set.delete(genericHandler);
        if (set.size === 0) {
          this.handlers.delete(name);
        }
      },
    };

    if (Array.isArray(owner)) {
      owner.push(disposable);
    } else if (typeof owner.add === 'function') {
      owner.add(disposable);
    }

    return disposable;
  }

  /**
   * ربط الاشتراك بمالك بشكل صريح عبر scopedOn.
   */
  scopedOn<T>(
    owner: Disposable[] | { add(d: Disposable): Disposable },
    name: EventName,
    handler: EventHandler<T>
  ): Disposable {
    return this.on(name, handler, owner);
  }

  recent(): ReadonlyArray<SystemEvent> {
    return [...this.history];
  }

  getHandlerErrors(): ReadonlyArray<EventBusHandlerError> {
    return [...this.handlerErrors];
  }

  clearHandlerErrors(): void {
    this.handlerErrors = [];
  }
}

