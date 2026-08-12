/**
 * اكتشاف تلقائي لسيرفرات LLM المحلية عبر المنافذ النموذجية.
 *
 * الشروط النموذجية:
 *  - المنافذ المعروفة: Ollama 11434، LM Studio 1234، llama.cpp 8080، vLLM 8000،
 *    Jan 1337، KoboldCpp 5001، text-generation-webui 7860، LM Studio القديم 3001.
 *  - المضيفون الافتراضي: 127.0.0.1 ثم localhost.
 *  - البروتوكولات: Ollama الأصلية (/api/version ثم /api/tags) ثم واجهة
 *    OpenAI-المتوافقة (/v1/models ثم /models كبديل على 404) — مثل فكرة
 *    Atomic-Chat (get_local_http) لكن دون اعتماد خارجي.
 *  - مهلة لكل استكشاف (افتراضي 800ms) مع إجهاض AbortController، واستكشاف متزامن
 *    (افتراضي 8) بدل تسلسلي، وأي فشل فردي يُتخطى دون إسقاط الفحص الكامل.
 */

export type LocalLLMServerVendor =
  | 'ollama'
  | 'lm-studio'
  | 'llamacpp'
  | 'vllm'
  | 'jan'
  | 'openai-compatible';

export interface LocalLLMServerInfo {
  /** معرّف فريد مثل llm://127.0.0.1:11434 */
  id: string;
  /** اسم قصير مثل ollama@11434 */
  name: string;
  /** البائع المكتشف عبر البروتوكول أو المنفذ */
  vendor: LocalLLMServerVendor;
  /** عنوان أساسي مثل http://127.0.0.1:11434 (بدون شرطة زائدة) */
  baseUrl: string;
  port: number;
  /** إصدار السيرفر (مثال: Ollama /api/version) */
  version?: string;
  /** معرفات النماذج المكتشفة (فارغة إن لم تُحضَّر) */
  models: string[];
  /** نقاط النهاية التي استجابت فعلياً */
  endpoints: string[];
  /** طابع زمني للاكتشاف */
  discoveredAt: number;
}

export interface LocalServerDiscoveryOptions {
  /** المضيفون المراد فحصهم (افتراضي: ['127.0.0.1', 'localhost']) */
  hosts?: string[];
  /** المنافذ المراد فحصها (افتراضي: DEFAULT_LLM_SERVER_PORTS) */
  ports?: number[];
  /** مهلة كل استكشاف بالمللي ثانية (افتراضي 800) */
  timeoutMs?: number;
  /** عدد الاستكشافات المتزامنة (افتراضي 8) */
  concurrency?: number;
  /** حقن fetch لأغراض الاختبار */
  fetchImpl?: LocalFetchLike;
}

/** دالة fetch مقطّعة مقبولة في الوحدة (init اختياري كـ globalThis.fetch) */
export type LocalFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** المنافذ النموذجية لسيرفرات LLM المحلية */
export const DEFAULT_LLM_SERVER_PORTS = [
  11434, // Ollama
  1234, // LM Studio
  8080, // llama.cpp / LocalAI
  8000, // vLLM
  1337, // Jan
  5001, // KoboldCpp
  7860, // text-generation-webui
  3001, // LM Studio (منافذ أقدم)
];

/** المضيفون الافتراضي للفحص */
export const DEFAULT_LLM_SERVER_HOSTS = ['127.0.0.1', 'localhost'];

/** خريطة المنفذ → البائع عند اعتماد واجهة OpenAI-المتوافقة فقط */
export function vendorForPort(port: number): LocalLLMServerVendor {
  switch (port) {
    case 11434:
      return 'ollama';
    case 1234:
      return 'lm-studio';
    case 8080:
      return 'llamacpp';
    case 8000:
      return 'vllm';
    case 1337:
      return 'jan';
    default:
      return 'openai-compatible';
  }
}

function makeInfo(
  baseUrl: string,
  port: number,
  vendor: LocalLLMServerVendor,
  extra: { version?: string; models: string[]; endpoints: string[] },
): LocalLLMServerInfo {
  return {
    id: `llm://${baseUrl.replace(/^http:\/\//, '')}`,
    name: `${vendor}@${port}`,
    vendor,
    baseUrl,
    port,
    version: extra.version,
    models: extra.models,
    endpoints: extra.endpoints,
    discoveredAt: Date.now(),
  };
}

/** GET بنتيجة JSON مع مهلة إجهاض؛ أي فشل (اتصال/مهلة/حالة/بنية) → undefined */
async function fetchJson(
  fetchImpl: LocalFetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** نماذج Ollama: { models: [{ name }] } من /api/tags */
function extractOllamaModels(tags: unknown): string[] {
  if (!tags || typeof tags !== 'object') return [];
  const list = (tags as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof (m as { name?: unknown })?.name === 'string' ? (m as { name: string }).name : ''))
    .filter((s) => s.length > 0);
}

/** نماذج OpenAI-المتوافقة: { data: [{ id }] } من /v1/models أو /models */
function extractOpenAIModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const list = (payload as { data?: unknown }).data;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof (m as { id?: unknown })?.id === 'string' ? (m as { id: string }).id : ''))
    .filter((s) => s.length > 0);
}

/** استكشاف مضيف/منفذ واحد؛ يعيد null إن لم يستجب لأي نقطة معروفة */
async function probeServer(
  host: string,
  port: number,
  opts: { timeoutMs: number; fetchImpl: LocalFetchLike },
): Promise<LocalLLMServerInfo | null> {
  const baseUrl = `http://${host}:${port}`;

  // 1) بروتوكول Ollama الأصلي: /api/version ثم /api/tags
  const version = await fetchJson(opts.fetchImpl, `${baseUrl}/api/version`, opts.timeoutMs);
  if (version && typeof (version as { version?: unknown }).version === 'string') {
    const tags = await fetchJson(opts.fetchImpl, `${baseUrl}/api/tags`, opts.timeoutMs);
    return makeInfo(baseUrl, port, 'ollama', {
      version: (version as { version: string }).version,
      models: extractOllamaModels(tags),
      endpoints: ['/api/version', '/api/tags'],
    });
  }

  const tags = await fetchJson(opts.fetchImpl, `${baseUrl}/api/tags`, opts.timeoutMs);
  if (tags && Array.isArray((tags as { models?: unknown })?.models)) {
    return makeInfo(baseUrl, port, 'ollama', {
      models: extractOllamaModels(tags),
      endpoints: ['/api/tags'],
    });
  }

  // 2) واجهة OpenAI-المتوافقة: /v1/models ثم /models كبديل على 404
  const v1 = await fetchJson(opts.fetchImpl, `${baseUrl}/v1/models`, opts.timeoutMs);
  if (v1 && Array.isArray((v1 as { data?: unknown })?.data)) {
    return makeInfo(baseUrl, port, vendorForPort(port), {
      models: extractOpenAIModels(v1),
      endpoints: ['/v1/models'],
    });
  }

  const bare = await fetchJson(opts.fetchImpl, `${baseUrl}/models`, opts.timeoutMs);
  if (bare && Array.isArray((bare as { data?: unknown })?.data)) {
    return makeInfo(baseUrl, port, vendorForPort(port), {
      models: extractOpenAIModels(bare),
      endpoints: ['/models'],
    });
  }

  return null;
}

/**
 * مسح شامل للسيرفرات المحلية عبر المضيفين والمنافذ المعطاة (أو النموذجية).
 * يعيد السيرفرات المكتشفة مرتبة حسب المنفذ؛ يتجاوز أي فشل فردي دون خطأ جماعي.
 */
export async function discoverLocalLLMServers(
  options: LocalServerDiscoveryOptions = {},
): Promise<LocalLLMServerInfo[]> {
  const hosts = options.hosts ?? DEFAULT_LLM_SERVER_HOSTS;
  const ports = options.ports ?? DEFAULT_LLM_SERVER_PORTS;
  const timeoutMs = options.timeoutMs ?? 800;
  const fetchImpl: LocalFetchLike | undefined = options.fetchImpl;
  const concurrency = options.concurrency ?? 8;

  const impl: LocalFetchLike | undefined =
    fetchImpl ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as LocalFetchLike) : undefined);
  if (!impl) return [];

  const candidates: { host: string; port: number }[] = [];
  for (const host of hosts) {
    for (const port of ports) candidates.push({ host, port });
  }

  const results: LocalLLMServerInfo[] = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) break;
      const { host, port } = candidates[index];
      const info = await probeServer(host, port, { timeoutMs, fetchImpl: impl });
      if (info) results.push(info);
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  results.sort((a, b) => a.port - b.port);
  return results;
}
