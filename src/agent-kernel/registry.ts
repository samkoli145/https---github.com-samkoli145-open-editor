import { Result, ok, err } from '../kernel/core/result';

export type AgentState = 'idle' | 'active' | 'busy' | 'sleep' | 'error';

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  state: AgentState;
  createdAt: number;
  lastActiveAt: number;
  metadata: Record<string, any>;
  lastError?: string;
}

export interface RegisterAgentParams {
  id: string;
  name: string;
  role?: string;
  metadata?: Record<string, any>;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();

  public registerAgent(params: RegisterAgentParams): Result<AgentRecord, Error> {
    if (!params.id || typeof params.id !== 'string') {
      return err(new Error('EINVAL: Agent ID must be a non-empty string'));
    }
    if (!params.name || typeof params.name !== 'string') {
      return err(new Error('EINVAL: Agent name must be a non-empty string'));
    }
    if (this.agents.has(params.id)) {
      return err(new Error(`EEXIST: Agent '${params.id}' is already registered`));
    }

    const record: AgentRecord = {
      id: params.id,
      name: params.name,
      role: params.role || 'assistant',
      state: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: params.metadata || {}
    };

    this.agents.set(params.id, record);
    return ok(record);
  }

  public unregisterAgent(id: string): Result<void, Error> {
    if (!this.agents.has(id)) {
      return err(new Error(`ENOENT: Agent '${id}' not found`));
    }
    this.agents.delete(id);
    return ok(undefined);
  }

  public getAgent(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  public hasAgent(id: string): boolean {
    return this.agents.has(id);
  }

  public setState(id: string, newState: AgentState): Result<AgentRecord, Error> {
    const record = this.agents.get(id);
    if (!record) {
      return err(new Error(`ENOENT: Agent '${id}' not found`));
    }

    record.state = newState;
    record.lastActiveAt = Date.now();
    return ok(record);
  }

  public touch(id: string): Result<void, Error> {
    const record = this.agents.get(id);
    if (!record) {
      return err(new Error(`ENOENT: Agent '${id}' not found`));
    }
    record.lastActiveAt = Date.now();
    return ok(undefined);
  }

  public markError(id: string, error: Error | string): Result<AgentRecord, Error> {
    const record = this.agents.get(id);
    if (!record) {
      return err(new Error(`ENOENT: Agent '${id}' not found`));
    }

    record.state = 'error';
    record.lastError = typeof error === 'string' ? error : error.message;
    record.lastActiveAt = Date.now();
    return ok(record);
  }

  public listAgents(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  public exportAll(): Record<string, AgentRecord> {
    const obj: Record<string, AgentRecord> = {};
    for (const [id, record] of this.agents.entries()) {
      obj[id] = { ...record, metadata: { ...record.metadata } };
    }
    return obj;
  }

  public importAll(data: Record<string, any>): Result<number, Error> {
    if (!data || typeof data !== 'object') {
      return err(new Error('EINVAL: Invalid import payload, expected object'));
    }

    let count = 0;
    for (const [id, raw] of Object.entries(data)) {
      if (!raw || typeof raw !== 'object') continue;
      if (!raw.id || !raw.name) continue;

      const record: AgentRecord = {
        id: String(raw.id),
        name: String(raw.name),
        role: String(raw.role || 'assistant'),
        state: (['idle', 'active', 'busy', 'sleep', 'error'].includes(raw.state) ? raw.state : 'idle') as AgentState,
        createdAt: Number(raw.createdAt) || Date.now(),
        lastActiveAt: Number(raw.lastActiveAt) || Date.now(),
        metadata: typeof raw.metadata === 'object' && raw.metadata !== null ? { ...raw.metadata } : {},
        lastError: raw.lastError ? String(raw.lastError) : undefined
      };

      this.agents.set(id, record);
      count++;
    }

    return ok(count);
  }
}
