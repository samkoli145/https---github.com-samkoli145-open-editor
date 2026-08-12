import { describe, it, expect, vi } from 'vitest';
import { OllamaBackend } from '../src/agent-kernel/llm-core';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('§4-3 — بروتوكول Ollama حقيقي عبر fetch (لا اعتماد خارجي)', () => {
  it('يرسل POST إلى {baseUrl}/api/chat بجسم بروتوكول ollama (model/messages/stream:false)', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      expect(url).toBe('http://localhost:11434/api/chat');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'مرحبا' }],
        stream: false,
      });
      return jsonResponse(200, {
        model: 'llama3.2',
        message: { role: 'assistant', content: 'مرحبا بك' },
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 3,
      });
    });

    const backend = new OllamaBackend({ model: 'llama3.2', fetchImpl: fetchMock });
    const res = await backend.chat([{ role: 'user', content: 'مرحبا' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.content).toBe('مرحبا بك');
      expect(res.value.model).toBe('llama3.2');
      expect(res.value.finishReason).toBe('stop');
      expect(res.value.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    }
  });

  it('ينحسر إلى المحاكاة فقط عند فشل الاتصال (fallback وليس استجابة حقيقية)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED: connect to 127.0.0.1:11434');
    });

    const backend = new OllamaBackend({ model: 'llama3.2', fetchImpl: fetchMock });
    const res = await backend.chat([{ role: 'user', content: 'hi' }]);

    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.content).toContain('[Ollama:llama3.2]');
      expect(res.value.model).toBe('llama3.2');
    }
  });

  it('يعيد خطأ عند HTTP غير ناجح عندما يكون الاتصال حتمياً (simulateOnFailure=false)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: 'model not found' }));

    const backend = new OllamaBackend({ model: 'x', fetchImpl: fetchMock, simulateOnFailure: false });
    const res = await backend.chat([{ role: 'user', content: 'hi' }]);

    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('Ollama HTTP 500');
  });

  it('يعيد الخطأ الأصلي عند فشل الشبكة مع simulateOnFailure=false (لا محاكاة صامتة)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const backend = new OllamaBackend({ fetchImpl: fetchMock, simulateOnFailure: false });
    const res = await backend.chat([{ role: 'user', content: 'hi' }]);

    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toBe('ECONNREFUSED');
  });

  it('يستخدم مهلة إجهاض عبر AbortController ولا يعلق إلى الأبد', async () => {
    let signalSeen: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      signalSeen = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('AbortError: The operation was aborted')));
      });
    });

    const backend = new OllamaBackend({ fetchImpl: fetchMock, timeoutMs: 50 });
    const res = await backend.chat([{ role: 'user', content: 'hi' }]);

    expect(res.isOk).toBe(true);
    expect(signalSeen?.aborted).toBe(true);
  });
});
