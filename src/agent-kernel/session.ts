import { Result, ok, err } from '../kernel/core/result';
import { EventBus } from '../kernel/core/event-bus';
import { ResourceQuotaGuard } from './quota';

export type SessionState = 'idle' | 'busy' | 'interrupted' | 'closed';

export interface SessionMessage {
  sessionId: string;
  msgId: string;
  msgType: 'execute_request' | 'stream' | 'display_data' | 'execute_reply' | 'interrupt_request';
  content: any;
  timestamp: number;
}

export interface SessionStreamHandler {
  (msg: SessionMessage): void;
}

export class SessionInstance {
  public readonly id: string;
  public readonly ownerAgent: string;
  public state: SessionState = 'idle';
  public readonly createdAt: number;
  public lastActiveAt: number;
  public metadata: Record<string, any>;
  public quotaGuard?: ResourceQuotaGuard;

  private streamListeners = new Set<SessionStreamHandler>();
  private eventBus?: EventBus;

  constructor(id: string, ownerAgent: string = 'system', metadata: Record<string, any> = {}, quotaGuard?: ResourceQuotaGuard, eventBus?: EventBus) {
    this.id = id;
    this.ownerAgent = ownerAgent;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.metadata = metadata;
    this.quotaGuard = quotaGuard;
    this.eventBus = eventBus;
  }

  public executeRequest(content: any): Result<void, Error> {
    if (this.state === 'closed') {
      return err(new Error(`ECLOSED: Session '${this.id}' is closed`));
    }
    if (this.quotaGuard) {
      const quotaCheck = this.quotaGuard.trackSyscall(this.ownerAgent);
      if (!quotaCheck.isOk) {
        this.emitStream('interrupt_request', { error: quotaCheck.error.message });
        return err(quotaCheck.error);
      }
    }
    this.state = 'busy';
    this.emitStream('execute_request', content);
    return ok(undefined);
  }

  public touch(): void {
    this.lastActiveAt = Date.now();
  }

  public onStream(handler: SessionStreamHandler): () => void {
    this.streamListeners.add(handler);
    return () => this.streamListeners.delete(handler);
  }

  public emitStream(msgType: SessionMessage['msgType'], content: any): void {
    this.touch();
    const msg: SessionMessage = {
      sessionId: this.id,
      msgId: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      msgType,
      content,
      timestamp: Date.now()
    };

    for (const listener of this.streamListeners) {
      try {
        listener(msg);
      } catch (e: any) {
        // §5-ح: لا يُبتلع خطأ المستمع صامتاً — يُوجَّه إلى EventBus/onError
        // (مستمع خاطئ لا يُسقط البث عن بقية المستمعين).
        this.eventBus?.emit('session:stream:error', {
          sessionId: this.id,
          msgType,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }
}

/**
 * Stateful Interactive Session Manager following Jupyter/Ansible-Kernel architecture.
 * Maintains isolated per-session states, supports live output streaming, and handles interrupt_requests.
 */
export class SessionManager {
  private sessions = new Map<string, SessionInstance>();
  private eventBus?: EventBus;
  private quotaGuard?: ResourceQuotaGuard;

  constructor(eventBus?: EventBus, quotaGuard?: ResourceQuotaGuard) {
    this.eventBus = eventBus;
    this.quotaGuard = quotaGuard;
  }

  public attachQuotaGuard(guard: ResourceQuotaGuard): void {
    this.quotaGuard = guard;
  }

  public createSession(id: string, ownerAgent: string = 'system', metadata: Record<string, any> = {}): Result<SessionInstance, Error> {
    if (!id || typeof id !== 'string') {
      return err(new Error('EINVAL: Session ID must be a non-empty string'));
    }
    if (this.sessions.has(id)) {
      return err(new Error(`EEXIST: Session '${id}' already exists`));
    }

    const session = new SessionInstance(id, ownerAgent, metadata, this.quotaGuard, this.eventBus);
    this.sessions.set(id, session);
    this.eventBus?.emit('session:created', { sessionId: id, ownerAgent });
    return ok(session);
  }

  public getSession(id: string): SessionInstance | undefined {
    return this.sessions.get(id);
  }

  public closeSession(id: string): Result<void, Error> {
    const session = this.sessions.get(id);
    if (!session) {
      return err(new Error(`ENOENT: Session '${id}' not found`));
    }
    session.state = 'closed';
    this.sessions.delete(id);
    this.eventBus?.emit('session:closed', { sessionId: id });
    return ok(undefined);
  }

  public interruptSession(id: string, reason: string = 'User requested interrupt'): Result<void, Error> {
    const session = this.sessions.get(id);
    if (!session) {
      return err(new Error(`ENOENT: Session '${id}' not found`));
    }

    session.state = 'interrupted';
    session.emitStream('interrupt_request', { reason, status: 'ok' });
    this.eventBus?.emit('session:interrupted', { sessionId: id, reason });
    return ok(undefined);
  }

  public listSessions(): SessionInstance[] {
    return Array.from(this.sessions.values());
  }
}
