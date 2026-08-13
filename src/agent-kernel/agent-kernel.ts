import { Result, ok, err } from '../kernel/core/result';
import { LocalizedString } from '../kernel/i18n/localized-string';
import { Kernel } from '../kernel/kernel';
import { LLMCore, LLMMessage, LLMReply, ILLMBackend } from './llm-core';
import { InferenceGovernor } from './inference-governor';
import { ToolRegistry } from './tools';
import { AgentRegistry, RegisterAgentParams } from './registry';
import { AccessManager, AccessPolicy, PolicySummary } from './access';
import { ResourceQuotaGuard, ResourceQuota, AgentResourceUsage } from './quota';
import { SessionManager } from './session';
import { SafeStorageEngine } from './storage';
import { AgentScheduler, SyscallHandlers, SchedulerStats } from './scheduler';
import { AgentSyscallPriority } from './syscalls';

export type AgentCommandType = 'llm' | 'tool' | 'storage' | 'registry' | 'access' | 'quota' | 'session' | 'engine' | 'kernel';
export type AgentManagedType = 'registry' | 'access' | 'quota' | 'session' | 'engine' | 'kernel';

export interface AgentCommandSpec {
  id: string;
  title: LocalizedString;
  type: AgentCommandType;
  op: string;
}

export interface AgentKernelOptions {
  backends?: ILLMBackend[];
  llm?: LLMCore;
  governor?: InferenceGovernor;
  tools?: ToolRegistry;
  registry?: AgentRegistry;
  access?: AccessManager;
  quota?: ResourceQuotaGuard;
  sessions?: SessionManager;
  storage?: SafeStorageEngine;
  scheduler?: {
    mode?: 'fifo' | 'rr';
    batchSize?: number;
    priority?: AgentSyscallPriority;
    maxQueueDepth?: number;
    agingMs?: number;
    maxConcurrentExec?: number;
  };
  defaultAgentId?: string;
  defaultAgentName?: string;
}

export interface AgentManagedEngine {
  name: string;
  title: LocalizedString;
  call: (op: string, payload?: unknown) => Promise<Result<unknown, Error>>;
  status?: () => unknown;
}

export interface LLMChatResult {
  content: string;
  model: string;
  usage?: LLMReply['usage'];
}

export interface AgentKernelStatus {
  state: AgentKernelState;
  llmModels: string[];
  tools: number;
  agents: number;
  engines: string[];
  scheduler: SchedulerStats;
}

export type AgentKernelState = 'idle' | 'running' | 'stopped' | 'error';

const DEFAULT_AGENT_ID = 'agent-1';

export const AGENT_KERNEL_COMMANDS: AgentCommandSpec[] = [
  // مستوى البيانات (يُجدول عبر AgentScheduler)
  { id: 'agent.llm.chat', title: { ar: 'محادثة عبر نواة LLM', en: 'LLM chat' }, type: 'llm', op: 'chat' },
  { id: 'agent.tool.call', title: { ar: 'استدعاء أداة', en: 'Call tool' }, type: 'tool', op: 'call' },
  { id: 'agent.tool.list', title: { ar: 'سرد الأدوات', en: 'List tools' }, type: 'tool', op: 'list' },
  { id: 'agent.storage.read', title: { ar: 'قراءة من التخزين', en: 'Storage read' }, type: 'storage', op: 'read' },
  { id: 'agent.storage.write', title: { ar: 'كتابة إلى التخزين', en: 'Storage write' }, type: 'storage', op: 'write' },
  { id: 'agent.storage.list', title: { ar: 'سرد سجلات التخزين', en: 'Storage list' }, type: 'storage', op: 'list' },
  // مستوى الإدارة (مسار سريع مباشر)
  { id: 'agent.registry.register', title: { ar: 'تسجيل وكيل', en: 'Register agent' }, type: 'registry', op: 'register' },
  { id: 'agent.registry.get', title: { ar: 'قراءة بيانات وكيل', en: 'Get agent' }, type: 'registry', op: 'get' },
  { id: 'agent.registry.list', title: { ar: 'سرد الوكلاء', en: 'List agents' }, type: 'registry', op: 'list' },
  { id: 'agent.registry.stats', title: { ar: 'إحصائيات الوكلاء', en: 'Registry stats' }, type: 'registry', op: 'stats' },
  { id: 'agent.access.set', title: { ar: 'ضبط سياسة صلاحيات', en: 'Set access policy' }, type: 'access', op: 'set' },
  { id: 'agent.access.check', title: { ar: 'فحص صلاحية أمر', en: 'Check command access' }, type: 'access', op: 'check' },
  { id: 'agent.access.list', title: { ar: 'سرد سياسات الصلاحيات', en: 'List access policies' }, type: 'access', op: 'list' },
  { id: 'agent.quota.set', title: { ar: 'ضبط حصة وكيل', en: 'Set agent quota' }, type: 'quota', op: 'set' },
  { id: 'agent.quota.usage', title: { ar: 'استهلاك حصة وكيل', en: 'Agent quota usage' }, type: 'quota', op: 'usage' },
  { id: 'agent.session.create', title: { ar: 'إنشاء جلسة', en: 'Create session' }, type: 'session', op: 'create' },
  { id: 'agent.session.get', title: { ar: 'قراءة جلسة', en: 'Get session' }, type: 'session', op: 'get' },
  { id: 'agent.session.list', title: { ar: 'سرد الجلسات', en: 'List sessions' }, type: 'session', op: 'list' },
  { id: 'agent.session.close', title: { ar: 'إغلاق جلسة', en: 'Close session' }, type: 'session', op: 'close' },
  // المحركات المدارة (النواة العليا تديرها بعقد)
  { id: 'agent.engine.list', title: { ar: 'سرد المحركات المدارة', en: 'List managed engines' }, type: 'engine', op: 'list' },
  { id: 'agent.engine.call', title: { ar: 'نداء محرك مُدار', en: 'Call managed engine' }, type: 'engine', op: 'call' },
  // حالة النواة العليا
  { id: 'agent.kernel.status', title: { ar: 'حالة النواة العليا', en: 'Upper kernel status' }, type: 'kernel', op: 'status' },
  { id: 'agent.kernel.stats', title: { ar: 'إحصائيات النواة العليا', en: 'Upper kernel stats' }, type: 'kernel', op: 'stats' },
];

function isManagedType(t: AgentCommandType): t is AgentManagedType {
  return t === 'registry' || t === 'access' || t === 'quota' || t === 'session' || t === 'engine' || t === 'kernel';
}

/**
 * النواة العليا المستقلة (طبقة خامسة) — على نمط AIOS:
 * تملك مكوناتها (llm/tools/registry/access/quota/sessions/storage) وتدير المحركات
 * (هيرمس/سنجبول/محرر/لانشر) بوصفها وحدات داخلية، وتوزّع العمل منها وحدها عبر
 * executeSyscall: تسجيل أثر → بوابة صلاحيات → (مسار إدارة مباشر) أو (نداء → مجدول → معالج).
 */
export class AgentKernel {
  readonly llm: LLMCore;
  readonly tools: ToolRegistry;
  readonly registry: AgentRegistry;
  readonly access: AccessManager;
  readonly quota: ResourceQuotaGuard;
  readonly sessions: SessionManager;
  readonly storage: SafeStorageEngine;
  readonly scheduler: AgentScheduler;

  private engines = new Map<string, AgentManagedEngine>();
  private readonly defaultAgentId: string;
  private state: AgentKernelState = 'idle';

  constructor(options: AgentKernelOptions = {}) {
    this.defaultAgentId = options.defaultAgentId ?? DEFAULT_AGENT_ID;
    this.llm = options.llm ?? new LLMCore({ backends: options.backends, governor: options.governor });
    this.tools = options.tools ?? new ToolRegistry();
    this.registry = options.registry ?? new AgentRegistry();
    this.access = options.access ?? new AccessManager();
    this.quota = options.quota ?? new ResourceQuotaGuard();
    this.sessions = options.sessions ?? new SessionManager();
    this.storage = options.storage ?? new SafeStorageEngine();
    this.scheduler = new AgentScheduler(this.buildHandlers(), options.scheduler ?? {});
  }

  getState(): AgentKernelState {
    return this.state;
  }

  registerEngine(engine: AgentManagedEngine): Result<void, Error> {
    if (!engine?.name || typeof engine.name !== 'string') {
      return err(new Error('EINVAL: engine name must be a non-empty string'));
    }
    if (this.engines.has(engine.name)) {
      return err(new Error(`EEXIST: engine '${engine.name}' already managed by the upper kernel`));
    }
    this.engines.set(engine.name, engine);
    return ok(undefined);
  }

  unregisterEngine(name: string): Result<void, Error> {
    if (!this.engines.delete(name)) {
      return err(new Error(`ENOENT: engine '${name}' not managed`));
    }
    return ok(undefined);
  }

  listEngines(): { name: string; title: LocalizedString; status?: unknown }[] {
    return Array.from(this.engines.values()).map((e) => ({
      name: e.name,
      title: e.title,
      status: e.status?.() ?? 'active',
    }));
  }

  getEngine(name: string): AgentManagedEngine | undefined {
    return this.engines.get(name);
  }

  async boot(): Promise<Result<{ llmModels: number; tools: number; engines: number }, Error>> {
    this.scheduler.start();
    this.ensureAgent(this.defaultAgentId);
    this.state = 'running';
    return ok({
      llmModels: this.llm.availableModels().length,
      tools: this.tools.listTools().length,
      engines: this.engines.size,
    });
  }

  async shutdown(): Promise<Result<void, Error>> {
    this.scheduler.stop();
    this.state = 'stopped';
    return ok(undefined);
  }

  /**
   * النقطة الرئيسية: أمر agent.* → تسجيل الأثر → بوابة الصلاحيات →
   * (مسار إدارة مباشر) أو (نداء → مجدول → معالج).
   * payload.agentName (اختياري) يحدد هوية الوكيل الطالب (افتراضي agent-1).
   */
  async executeSyscall(commandId: string, payload?: unknown): Promise<Result<unknown, Error>> {
    if (this.state !== 'running') {
      return err(new Error('ENOTREADY: upper kernel is not running'));
    }
    const spec = AGENT_KERNEL_COMMANDS.find((c) => c.id === commandId);
    if (!spec) {
      return err(new Error(`ENOSYS: unknown agent command '${commandId}'`));
    }
    const p = (payload ?? {}) as Record<string, unknown>;
    const agentName = (p.agentName as string) ?? this.defaultAgentId;

    this.ensureAgent(agentName);
    this.registry.touch(agentName);

    const gate = this.access.checkCommand(agentName, commandId);
    if (gate.isErr) {
      this.registry.markError(agentName, gate.error);
      return gate;
    }

    if (isManagedType(spec.type)) {
      const managed = await this.dispatchManagement(spec, p, agentName);
      if (managed.isErr) this.registry.markError(agentName, managed.error);
      return managed;
    }

    const query = this.buildQuery(spec, p);
    const priority = (p.priority as AgentSyscallPriority | undefined) ?? undefined;
    this.registry.setState(agentName, 'busy');
    const syscall = this.scheduler.submit(agentName, spec.type, query, priority);
    const completed = await syscall.awaitDone();
    this.registry.setState(agentName, 'active');
    if (completed.isErr) {
      this.registry.markError(agentName, completed.error);
      return completed;
    }
    return ok(completed.value);
  }

  /** محادثة مباشرة عبر نواة LLM (للاستخدام البرمجي المباشر) */
  async chat(agentName: string, messages: LLMMessage[]): Promise<Result<LLMChatResult, Error>> {
    const result = await this.llm.chat(messages);
    if (result.isErr) return result;
    return ok({
      content: result.value.content,
      model: result.value.model,
      usage: result.value.usage,
    });
  }

  /** تسجيل أوامر agent.* في سجل نواة النظام (تمر عبر النواهي) */
  attach(kernel: Kernel): void {
    const ctx = kernel.getContext();
    for (const spec of AGENT_KERNEL_COMMANDS) {
      ctx.commands.register({
        id: spec.id,
        title: spec.title,
        category: { ar: 'النواة العليا', en: 'Upper Kernel' },
        description: spec.title,
        handler: async (payload?: unknown) => {
          const res = await this.executeSyscall(spec.id, payload);
          if (res.isErr) throw res.error;
          return res.value;
        },
      });
    }
    ctx.commands.register({
      id: 'agent.scheduler.stats',
      title: { ar: 'إحصائيات جدولة الوكلاء', en: 'Agent scheduler stats' },
      category: { ar: 'النواة العليا', en: 'Upper Kernel' },
      description: { ar: 'إحصائيات مجدول النواة العليا', en: 'Upper kernel scheduler stats' },
      handler: () => ok(this.scheduler.stats()),
    });
    ctx.commands.register({
      id: 'agent.llm.models',
      title: { ar: 'قائمة أنوية LLM', en: 'List LLM cores' },
      category: { ar: 'النواة العليا', en: 'Upper Kernel' },
      description: { ar: 'قائمة خلفيات LLM المتاحة', en: 'List available LLM backends' },
      handler: () => ok(this.llm.availableModels()),
    });
    ctx.commands.register({
      id: 'agent.llm.health',
      title: { ar: 'فحص صحة نواة LLM', en: 'LLM core health' },
      category: { ar: 'النواة العليا', en: 'Upper Kernel' },
      description: { ar: 'فحص صحة خلفيات LLM', en: 'LLM backend health check' },
      handler: () => this.llm.health(),
    });
  }

  status(): AgentKernelStatus {
    return {
      state: this.state,
      llmModels: this.llm.availableModels().map((m) => m.name),
      tools: this.tools.listTools().length,
      agents: this.registry.listAgents().length,
      engines: Array.from(this.engines.keys()),
      scheduler: this.scheduler.stats(),
    };
  }

  // ─── Private ───────────────────────────────────────────────────────

  private ensureAgent(agentId: string): void {
    if (!this.registry.hasAgent(agentId)) {
      this.registry.registerAgent({ id: agentId, name: agentId });
    }
  }

  private buildQuery(spec: AgentCommandSpec, p: Record<string, unknown>): Record<string, unknown> {
    switch (spec.id) {
      case 'agent.llm.chat':
        return { op: 'chat', messages: (p.messages as LLMMessage[]) ?? [], options: (p.options as object) ?? {} };
      case 'agent.tool.call':
        return { op: 'call', name: (p.name as string) ?? '', args: (p.args as Record<string, unknown>) ?? {} };
      case 'agent.tool.list':
        return { op: 'list' };
      case 'agent.storage.read':
        return { op: 'read', key: (p.key as string) ?? '' };
      case 'agent.storage.write':
        return { op: 'write', key: (p.key as string) ?? '', value: p.value };
      case 'agent.storage.list':
        return { op: 'list', keyPrefix: (p.keyPrefix as string) ?? '' };
      default:
        return { op: spec.op };
    }
  }

  private buildHandlers(): SyscallHandlers {
    return {
      llm: async (syscall) => {
        const messages = (syscall.payload.messages as LLMMessage[] | undefined) ?? [];
        if (messages.length === 0) {
          throw new Error('EINVAL: llm chat requires non-empty messages');
        }
        const result = await this.llm.chat(messages);
        if (result.isErr) throw result.error;
        return {
          content: result.value.content,
          model: result.value.model,
          usage: result.value.usage,
        };
      },
      tool: async (syscall) => {
        if (syscall.payload.op === 'list') {
          return this.tools.listTools();
        }
        const name = String(syscall.payload.name ?? '');
        const gate = this.access.checkTool(syscall.owner, name);
        if (gate.isErr) throw gate.error;
        const result = await this.tools.executeTool(name, syscall.payload.args);
        if (result.isErr) throw result.error;
        return result.value;
      },
      storage: async (syscall) => {
        const gate = this.access.checkSystem(syscall.owner);
        if (gate.isErr) throw gate.error;
        const key = String(syscall.payload.key ?? syscall.payload.keyPrefix ?? '');
        switch (syscall.payload.op) {
          case 'read': {
            const read = await this.storage.load(key);
            if (read.isErr) throw read.error;
            return read.value;
          }
          case 'write': {
            const write = await this.storage.save(key, syscall.payload.value);
            if (write.isErr) throw write.error;
            return { key, written: true };
          }
          case 'list': {
            const list = await this.storage.list(key);
            if (list.isErr) throw list.error;
            return list.value;
          }
          default:
            throw new Error(`ENOSYS: storage.${String(syscall.payload.op ?? '')}`);
        }
      },
    };
  }

  private async dispatchManagement(
    spec: AgentCommandSpec,
    p: Record<string, unknown>,
    agentName: string,
  ): Promise<Result<unknown, Error>> {
    switch (spec.type) {
      case 'registry':
        return this.handleRegistry(spec.op, p);
      case 'access':
        return this.handleAccess(spec.op, p);
      case 'quota':
        return this.handleQuota(spec.op, p);
      case 'session':
        return this.handleSession(spec.op, p);
      case 'engine':
        return this.handleEngine(spec.op, p);
      case 'kernel':
        return this.handleKernel(spec.op);
      default:
        return err(new Error(`ENOSYS: management.${spec.op ?? ''}`));
    }
  }

  private handleRegistry(op: string, p: Record<string, unknown>): Result<unknown, Error> {
    switch (op) {
      case 'register': {
        const params = (p.params ?? p) as RegisterAgentParams;
        if (!params || typeof params.id !== 'string' || params.id.length === 0) {
          return err(new Error('EINVAL: registry.register requires agent id'));
        }
        return this.registry.registerAgent(params);
      }
      case 'get': {
        const record = this.registry.getAgent(String(p.id ?? ''));
        return record ? ok(record) : err(new Error(`ENOENT: agent '${String(p.id)}' not registered`));
      }
      case 'list':
        return ok(this.registry.listAgents());
      case 'stats':
        return ok({ count: this.registry.listAgents().length });
      default:
        return err(new Error(`ENOSYS: registry.${op}`));
    }
  }

  private handleAccess(op: string, p: Record<string, unknown>): Result<unknown, Error> {
    switch (op) {
      case 'set': {
        const policy = (p.policy ?? {}) as AccessPolicy;
        this.access.setPolicy(String(p.agentName ?? ''), policy);
        return ok({ agentId: String(p.agentName ?? ''), policy });
      }
      case 'check': {
        const verdict = this.access.checkCommand(String(p.agentName ?? ''), String(p.commandId ?? ''));
        return ok(verdict.isOk ? { allowed: true } : { allowed: false, reason: verdict.error.message });
      }
      case 'list':
        return ok(this.access.list() as PolicySummary[]);
      default:
        return err(new Error(`ENOSYS: access.${op}`));
    }
  }

  private handleQuota(op: string, p: Record<string, unknown>): Result<unknown, Error> {
    switch (op) {
      case 'set': {
        const quota = (p.quota ?? {}) as ResourceQuota;
        this.quota.setQuota(String(p.agentId ?? ''), quota);
        return ok({ agentId: String(p.agentId ?? ''), quota });
      }
      case 'usage':
        return ok(this.quota.getUsage(String(p.agentId ?? '')) as AgentResourceUsage);
      default:
        return err(new Error(`ENOSYS: quota.${op}`));
    }
  }

  private handleSession(op: string, p: Record<string, unknown>): Result<unknown, Error> {
    switch (op) {
      case 'create': {
        const created = this.sessions.createSession(
          String(p.id ?? ''),
          String(p.ownerAgent ?? this.defaultAgentId),
          (p.metadata as Record<string, any> | undefined) ?? {},
        );
        return created;
      }
      case 'get': {
        const session = this.sessions.getSession(String(p.id ?? ''));
        return session ? ok(session) : err(new Error(`ENOENT: session '${String(p.id)}' not found`));
      }
      case 'list':
        return ok(this.sessions.listSessions().map((s) => ({ id: s.id, ownerAgent: s.ownerAgent, state: s.state })));
      case 'close':
        return this.sessions.closeSession(String(p.id ?? ''));
      default:
        return err(new Error(`ENOSYS: session.${op}`));
    }
  }

  private async handleEngine(op: string, p: Record<string, unknown>): Promise<Result<unknown, Error>> {
    switch (op) {
      case 'list':
        return ok(this.listEngines());
      case 'call': {
        const engineName = String(p.engine ?? p.name ?? '');
        const engineOp = String(p.op ?? '');
        const engine = this.engines.get(engineName);
        if (!engine) {
          return err(new Error(`ENOENT: engine '${engineName}' not managed by the upper kernel`));
        }
        try {
          return await engine.call(engineOp, p.args ?? {});
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return err(new Error(`engine.call '${engineName}' failed: ${msg}`));
        }
      }
      default:
        return err(new Error(`ENOSYS: engine.${op}`));
    }
  }

  private handleKernel(op: string): Result<unknown, Error> {
    switch (op) {
      case 'status':
        return ok(this.status());
      case 'stats':
        return ok(this.scheduler.stats());
      default:
        return err(new Error(`ENOSYS: kernel.${op}`));
    }
  }
}
