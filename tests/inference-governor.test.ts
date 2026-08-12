import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InferenceGovernor,
  InferenceMutex,
  DefaultResourceProbe,
  type ResourceProbe,
} from '../src/agent-kernel/inference-governor';
import { LLMCore, OllamaBackend } from '../src/agent-kernel/llm-core';
import { ResourceQuotaGuard } from '../src/agent-kernel/quota';

class FakeProbe implements ResourceProbe {
  constructor(
    private freeMb: number,
    private modelSizeMb: number,
  ) {}

  async getAvailableVramMb(): Promise<number> {
    return this.freeMb;
  }

  async getModelSizeMb(): Promise<number> {
    return this.modelSizeMb;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('§4-7 — Inference Governor (حوكمة موارد الاستدلال)', () => {
  describe('InferenceMutex — قفل استدلال أحادي', () => {
    it('يسمح باستدلال واحد فقط في نفس اللحظة ويُسلِّم القفل لطالب التالي', async () => {
      const mutex = new InferenceMutex();

      const release1 = await mutex.acquire(100);
      const second = mutex.acquire(100);
      const third = mutex.acquire(100);

      let released = false;
      second.then((r) => {
        released = true;
        r();
      });

      expect(released).toBe(false);
      release1();

      const release2 = await second;
      expect(released).toBe(true);
      release2();

      const release3 = await third;
      release3();
    });

    it('يرفض طالباً تجاوز مهلة الانتظار بـ ERR_INFERENCE_BUSY', async () => {
      const mutex = new InferenceMutex();
      const release = await mutex.acquire(5000);

      await expect(mutex.acquire(30)).rejects.toThrow('ERR_INFERENCE_BUSY');
      release();
    });
  });

  describe('DefaultResourceProbe — وضع التراجع الآمن (Fallback Passive Mode)', () => {
    it('يعيد رقماً موجباً للذاكرة الحرة حتى في غياب nvidia-smi (تقدير آمن 8192MB)', async () => {
      const probe = new DefaultResourceProbe();
      const freeMb = await probe.getAvailableVramMb();
      expect(typeof freeMb).toBe('number');
      expect(freeMb).toBeGreaterThan(0);
    });

    it('يعيد 0 (بلا دليل) لحجم النموذج عند تعذر /api/show — لا رفض حدسي', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      );
      const probe = new DefaultResourceProbe();
      const size = await probe.getModelSizeMb('llama3.2', 'http://127.0.0.1:11434');
      expect(size).toBe(0);
      vi.unstubAllGlobals();
    });
  });

  describe('InferenceGovernor — فحص VRAM والسياسات', () => {
    it('يقبل نموذجاً ضمن هامش الأمان ويعيد دالة تحرير', async () => {
      const governor = new InferenceGovernor(new FakeProbe(8000, 2000));
      const res = await governor.acquireInferenceSlot('llama3.2');
      expect(res.isOk).toBe(true);
      if (res.isOk) {
        res.value();
      }
    });

    it('يرفض نموذجاً يتجاوز هامش الأمان بـ ERR_VRAM_OVERFLOW', async () => {
      const governor = new InferenceGovernor(new FakeProbe(4000, 4000));
      const res = await governor.acquireInferenceSlot('llama3.2:70b');
      expect(res.isErr).toBe(true);
      if (res.isErr) expect(res.error.message).toContain('ERR_VRAM_OVERFLOW');
    });

    it('يُنتج keep_alive مطابقاً لـ idleTimeoutMs (افتراضي 5 دقائق)', () => {
      const governor = new InferenceGovernor(new FakeProbe(8000, 2000));
      expect(governor.getKeepAliveParam()).toBe('5m');
    });

    it('يُفرغ النموذج الخامل عبر /api/generate باحتفاظ keep_alive=0', async () => {
      const unloadMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
        expect(url).toBe('http://127.0.0.1:11434/api/generate');
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ model: 'llama3.2', keep_alive: 0 });
        return jsonResponse(200, { done: true });
      });
      vi.stubGlobal('fetch', unloadMock);

      const governor = new InferenceGovernor(new FakeProbe(8000, 2000), { idleTimeoutMs: 60 });
      const res = await governor.acquireInferenceSlot('llama3.2');
      expect(res.isOk).toBe(true);

      await new Promise((r) => setTimeout(r, 150));
      expect(unloadMock).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe('التكامل مع LLMCore — بوابة الحاكم قبل النفاذ', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init.body));
        return jsonResponse(200, {
          model: body.model,
          message: { role: 'assistant', content: 'ok' },
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        });
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('يمرر keep_alive للحاكم في جسم طلب ollama عبر LLMCore', async () => {
      const governor = new InferenceGovernor(new FakeProbe(8000, 2000));
      const core = new LLMCore({
        backends: [new OllamaBackend({ fetchImpl: fetchMock })],
        governor,
      });

      const res = await core.chat([{ role: 'user', content: 'مرحبا' }]);
      expect(res.isOk).toBe(true);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body.keep_alive).toBe('5m');
      expect(body.stream).toBe(false);
    });

    it('يرفض الاستدلال بـ ERR_VRAM_OVERFLOW قبل أي طلب شبكة', async () => {
      const governor = new InferenceGovernor(new FakeProbe(1000, 4000));
      const core = new LLMCore({
        backends: [new OllamaBackend({ fetchImpl: fetchMock })],
        governor,
      });

      const res = await core.chat([{ role: 'user', content: 'كبير جدا' }]);
      expect(res.isErr).toBe(true);
      if (res.isErr) expect(res.error.message).toContain('ERR_VRAM_OVERFLOW');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ResourceQuotaGuard — حصة VRAM للوكيل (إضافة توافقية)', () => {
    it('السلوك الافتراضي لا يتأثر بغياب سقف VRAM', () => {
      const guard = new ResourceQuotaGuard();
      expect(guard.checkInferenceQuota('agent-a', 999999).isOk).toBe(true);
    });

    it('يرفض استدلالاً يتجاوز سقف VRAM المعيَّن للوكيل بـ EVRAM_QUOTA', () => {
      const guard = new ResourceQuotaGuard();
      guard.setQuota('agent-a', { maxVramUsageMb: 4096 });
      const res = guard.checkInferenceQuota('agent-a', 5000);
      expect(res.isErr).toBe(true);
      if (res.isErr) expect(res.error.message).toContain('EVRAM_QUOTA');

      expect(guard.checkInferenceQuota('agent-a', 4096).isOk).toBe(true);
      expect(guard.checkInferenceQuota('agent-b', 5000).isOk).toBe(true);
    });
  });
});
