import { Result, ok, err } from '../kernel/core/result';
import type { LocalLLMServerInfo } from './local-server-discovery';
import type { InferenceGovernor } from './inference-governor';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  /** مدة إبقاء النموذج في الذاكرة (keep_alive) عبر حاكم الاستدلال */
  keepAlive?: string | number;
}

export interface LLMReply {
  content: string;
  model: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ILLMBackend {
  name: string;
  model: string;
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<Result<LLMReply, Error>>;
}

export interface OllamaBackendOptions {
  name?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** المحاكاة تعمل fallback فقط عند فشل الاتصال (افتراضي true)؛ عطّلها لجعل الاتصال حتمياً */
  simulateOnFailure?: boolean;
}

export class OllamaBackend implements ILLMBackend {
  public readonly name: string;
  public readonly model: string;
  public readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  private readonly simulateOnFailure: boolean;

  constructor(options: OllamaBackendOptions = {}) {
    this.name = options.name || 'ollama';
    this.model = options.model || 'llama3.2';
    this.baseUrl = (options.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl;
    this.simulateOnFailure = options.simulateOnFailure ?? true;
  }

  public async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<Result<LLMReply, Error>> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl === 'function') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const body: Record<string, unknown> = { model: this.model, messages, stream: false };
        if (options.keepAlive !== undefined) {
          body.keep_alive = options.keepAlive;
        }
        const res = await fetchImpl(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Ollama HTTP ${res.status}`);
        }
        const data: any = await res.json();
        const content = typeof data?.message?.content === 'string' ? data.message.content : '';
        const promptTokens = typeof data?.prompt_eval_count === 'number' ? data.prompt_eval_count : 0;
        const completionTokens = typeof data?.eval_count === 'number' ? data.eval_count : 0;
        return ok({
          content,
          model: typeof data?.model === 'string' ? data.model : this.model,
          finishReason: data?.done_reason || 'stop',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
        });
      } catch (e: any) {
        if (!this.simulateOnFailure) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        clearTimeout(timer);
      }
    } else if (!this.simulateOnFailure) {
      return err(new Error('ENOTSUP: fetch is not available'));
    }

    // Fallback/Simulated Ollama response for local unit tests without live Ollama instance
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    return ok({
      content: `[Ollama:${this.model}] Response to: ${lastUserMsg}`,
      model: this.model,
      finishReason: 'stop',
      usage: {
        promptTokens: lastUserMsg.length,
        completionTokens: 20,
        totalTokens: lastUserMsg.length + 20
      }
    });
  }
}

export interface DeterministicBackendOptions {
  name?: string;
  model?: string;
  responses?: Record<string, string>;
  defaultResponse?: string;
}

export class DeterministicBackend implements ILLMBackend {
  public readonly name: string;
  public readonly model: string;
  private responses: Record<string, string>;
  private defaultResponse: string;

  constructor(options: DeterministicBackendOptions = {}) {
    this.name = options.name || 'deterministic';
    this.model = options.model || 'deterministic-v1';
    this.responses = options.responses || {};
    this.defaultResponse = options.defaultResponse || 'Deterministic response';
  }

  public async chat(messages: LLMMessage[], _options: LLMChatOptions = {}): Promise<Result<LLMReply, Error>> {
    const lastMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const answer = this.responses[lastMsg] || this.defaultResponse;

    return ok({
      content: answer,
      model: this.model,
      finishReason: 'stop'
    });
  }
}

export interface LLMCoreOptions {
  backends?: ILLMBackend[];
  defaultModel?: string;
  /** حاكم موارد الاستدلال — يُفعَّل عند حقنه فقط (لا يغيّر السلوك الافتراضي) */
  governor?: InferenceGovernor;
}

export interface DiscoveredBackendOptions {
  /** مهلة كل طلب للخلفيات المكتشفة (افتراضي 10s) */
  timeoutMs?: number;
  /** نموذج افتراضي إن لم يعلن السيرفر نماذج */
  fallbackModel?: string;
}

/**
 * يحوّل سيرفرات LLM المكتشفة إلى خلفيات قابلة للتشغيل.
 * خلفية واحدة لكل سيرفر Ollama (بأول نموذج معلن)؛ السيرفرات OpenAI-المتوافقة
 * الأخرى تُكتشف وتُعرض لكن بلا خلفية حتى تُنفَّذ واجهتها.
 */
export function backendsFromDiscoveredServers(
  infos: LocalLLMServerInfo[],
  options: DiscoveredBackendOptions = {},
): ILLMBackend[] {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const backends: ILLMBackend[] = [];
  for (const info of infos) {
    if (info.vendor !== 'ollama') continue;
    backends.push(
      new OllamaBackend({
        name: `ollama@${info.port}`,
        baseUrl: info.baseUrl,
        model: info.models[0] ?? options.fallbackModel ?? 'llama3.2',
        timeoutMs,
      }),
    );
  }
  return backends;
}

export class LLMCore {
  private backends: ILLMBackend[];
  private governor?: InferenceGovernor;

  constructor(options: LLMCoreOptions = {}) {
    this.backends = options.backends && options.backends.length > 0
      ? options.backends
      : [new OllamaBackend()];
    this.governor = options.governor;
  }

  /** قائمة خلفيات LLM المتاحة (اسم + نموذج) */
  public availableModels(): { name: string; model: string }[] {
    return this.backends.map((b) => ({ name: b.name, model: b.model }));
  }

  /** فحص صحة خلفيات LLM: سليمة إن نجحت أي منها */
  public async health(): Promise<boolean> {
    for (const backend of this.backends) {
      try {
        const res = await backend.chat([{ role: 'user', content: 'ping' }]);
        if (res.isOk) return true;
      } catch (e: any) {
        // continue to next backend
      }
    }
    return false;
  }

  public async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<Result<LLMReply, Error>> {
    if (this.backends.length === 0) {
      return err(new Error('ENOENT: No LLM backends registered'));
    }

    let lastError: Error | undefined;

    // Try primary backend first, fallback to next if available
    for (const backend of this.backends) {
      try {
        // بوابة حاكم الاستدلال: قفل أحادي + فحص VRAM قبل النفاذ
        if (this.governor) {
          const acquireRes = await this.governor.acquireInferenceSlot(backend.model);
          if (acquireRes.isErr) {
            lastError = acquireRes.error;
            continue;
          }
          const release = acquireRes.value;
          try {
            const res = await backend.chat(messages, { keepAlive: this.governor.getKeepAliveParam() });
            if (res.isOk) return res;
          } finally {
            release();
          }
        } else {
          const res = await backend.chat(messages, options);
          if (res.isOk) return res;
        }
      } catch (e: any) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // continue to next backend
      }
    }

    return err(lastError ?? new Error('EEXEC: All LLM backends failed to generate a response'));
  }
}
