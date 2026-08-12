import { describe, it, expect, vi } from 'vitest';
import {
  discoverLocalLLMServers,
  vendorForPort,
  DEFAULT_LLM_SERVER_PORTS,
  DEFAULT_LLM_SERVER_HOSTS,
} from '../src/agent-kernel/local-server-discovery';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = (init?: RequestInit) => Promise<Response>;

/** fetch مُوجَّه حسب URL؛ أي مسار غير مسجَّل يعيد 404 */
function routingFetch(routes: Record<string, RouteHandler>) {
  return vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(init);
  });
}

const ollamaVersion = () => jsonResponse(200, { version: '0.5.4' });
const ollamaTags = () =>
  jsonResponse(200, {
    models: [
      { name: 'llama3.2:latest', model: 'llama3.2:latest' },
      { name: 'qwen2.5:7b', model: 'qwen2.5:7b' },
    ],
  });

describe('§4-4 — اكتشاف شامل لسيرفرات LLM المحلية عبر المنافذ (الشروط النموذجية)', () => {
  it('الشروط النموذجية: مضيفان افترضيان و8 منافذ معروفة مصدَّرة', () => {
    expect(DEFAULT_LLM_SERVER_HOSTS).toEqual(['127.0.0.1', 'localhost']);
    expect(DEFAULT_LLM_SERVER_PORTS).toEqual([11434, 1234, 8080, 8000, 1337, 5001, 7860, 3001]);
  });

  it('خريطة المنفذ → البائع عند اعتماد واجهة OpenAI فقط', () => {
    expect(vendorForPort(11434)).toBe('ollama');
    expect(vendorForPort(1234)).toBe('lm-studio');
    expect(vendorForPort(8080)).toBe('llamacpp');
    expect(vendorForPort(8000)).toBe('vllm');
    expect(vendorForPort(1337)).toBe('jan');
    expect(vendorForPort(9000)).toBe('openai-compatible');
  });

  it('يكتشف سيرفر Ollama عبر البروتوكول الأصلي (/api/version + /api/tags)', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:11434/api/version': async () => ollamaVersion(),
      'http://127.0.0.1:11434/api/tags': async () => ollamaTags(),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [11434],
      fetchImpl: fetchMock,
    });

    expect(infos).toHaveLength(1);
    const info = infos[0];
    expect(info.vendor).toBe('ollama');
    expect(info.baseUrl).toBe('http://127.0.0.1:11434');
    expect(info.version).toBe('0.5.4');
    expect(info.models).toEqual(['llama3.2:latest', 'qwen2.5:7b']);
    expect(info.endpoints).toEqual(['/api/version', '/api/tags']);
  });

  it('يكتشف Ollama حتى لو تعطّل /api/version (يكفي /api/tags)', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:11434/api/tags': async () => ollamaTags(),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [11434],
      fetchImpl: fetchMock,
    });

    expect(infos).toHaveLength(1);
    expect(infos[0].vendor).toBe('ollama');
    expect(infos[0].endpoints).toEqual(['/api/tags']);
  });

  it('يكتشف LM Studio على 1234 عبر /v1/models (مزوّد OpenAI-متوافق)', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:1234/v1/models': async () =>
        jsonResponse(200, {
          object: 'list',
          data: [
            { id: 'lmstudio-community/llama-3.1-8b-instruct', object: 'model' },
            { id: 'qwen2.5-7b-instruct', object: 'model' },
          ],
        }),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [1234],
      fetchImpl: fetchMock,
    });

    expect(infos).toHaveLength(1);
    expect(infos[0].vendor).toBe('lm-studio');
    expect(infos[0].models).toEqual(['lmstudio-community/llama-3.1-8b-instruct', 'qwen2.5-7b-instruct']);
    expect(infos[0].endpoints).toEqual(['/v1/models']);
  });

  it('يستخدم /models كبديل عند 404 على /v1/models (مثل فكرة Atomic-Chat)', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:8080/models': async () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'llama.cpp-model-q4', object: 'model' }] }),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [8080],
      fetchImpl: fetchMock,
    });

    expect(infos).toHaveLength(1);
    expect(infos[0].vendor).toBe('llamacpp');
    expect(infos[0].models).toEqual(['llama.cpp-model-q4']);
    expect(infos[0].endpoints).toEqual(['/models']);
  });

  it('يستدل على Ollama من المنفذ حتى لو استجاب /v1/models فقط', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:11434/v1/models': async () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'llama3.2:latest', object: 'model' }] }),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [11434],
      fetchImpl: fetchMock,
    });

    expect(infos).toHaveLength(1);
    expect(infos[0].vendor).toBe('ollama');
  });

  it('يتجاوز المضيف/المنفذ الذي يرفض الاتصال دون إسقاط الفحص الكامل', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED: connect to 127.0.0.1:1234');
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [1234],
      fetchImpl: fetchMock,
    });

    expect(infos).toEqual([]);
  });

  it('يتجاوز الاستجابات غير-JSON (مثل صفحة HTML) دون تعطل', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<!doctype html><html>Ollama UI</html>', { status: 200 }),
    );

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [11434],
      fetchImpl: fetchMock,
    });

    expect(infos).toEqual([]);
  });

  it('يستخدم مهلة إجهاض ولا يعلق على استكشاف معلّق', async () => {
    const seenSignals: (AbortSignal | null | undefined)[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      seenSignals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    });

    const started = Date.now();
    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [11434],
      timeoutMs: 30,
      fetchImpl: fetchMock,
    });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(infos).toEqual([]);
    expect(seenSignals.some((s) => s?.aborted)).toBe(true);
  });

  it('يرصد منافذ متعددة ويعيدها مرتبة حسب المنفذ', async () => {
    const fetchMock = routingFetch({
      'http://127.0.0.1:8000/v1/models': async () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'Qwen/Qwen2.5-7B', object: 'model' }] }),
      'http://127.0.0.1:11434/api/version': async () => ollamaVersion(),
      'http://127.0.0.1:11434/api/tags': async () => ollamaTags(),
    });

    const infos = await discoverLocalLLMServers({
      hosts: ['127.0.0.1'],
      ports: [8000, 11434],
      fetchImpl: fetchMock,
    });

    expect(infos.map((i) => i.port)).toEqual([8000, 11434]);
    expect(infos.map((i) => i.vendor)).toEqual(['vllm', 'ollama']);
  });
});
