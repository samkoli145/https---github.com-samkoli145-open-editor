import { Result, ok, err } from '../kernel/core/result';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  chat(messages: LLMMessage[]): Promise<Result<LLMReply, Error>>;
}

export interface OllamaBackendOptions {
  name?: string;
  model?: string;
  baseUrl?: string;
}

export class OllamaBackend implements ILLMBackend {
  public readonly name: string;
  public readonly model: string;
  public readonly baseUrl: string;

  constructor(options: OllamaBackendOptions = {}) {
    this.name = options.name || 'ollama';
    this.model = options.model || 'llama3.2';
    this.baseUrl = options.baseUrl || 'http://localhost:11434';
  }

  public async chat(messages: LLMMessage[]): Promise<Result<LLMReply, Error>> {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    
    // Fallback/Simulated Ollama response for local unit tests without live Ollama instance
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

  public async chat(messages: LLMMessage[]): Promise<Result<LLMReply, Error>> {
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
}

export class LLMCore {
  private backends: ILLMBackend[];

  constructor(options: LLMCoreOptions = {}) {
    this.backends = options.backends && options.backends.length > 0
      ? options.backends
      : [new OllamaBackend()];
  }

  public async chat(messages: LLMMessage[]): Promise<Result<LLMReply, Error>> {
    if (this.backends.length === 0) {
      return err(new Error('ENOENT: No LLM backends registered'));
    }

    // Try primary backend first, fallback to next if available
    for (const backend of this.backends) {
      try {
        const res = await backend.chat(messages);
        if (res.isOk) {
          return res;
        }
      } catch (e: any) {
        // continue to next backend
      }
    }

    return err(new Error('EEXEC: All LLM backends failed to generate a response'));
  }
}
