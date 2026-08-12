import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Bootloader } from '../src/index';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ROUTES: Record<string, () => Response> = {
  'http://127.0.0.1:11434/api/version': () => jsonResponse(200, { version: '0.32.1' }),
  'http://127.0.0.1:11434/api/tags': () =>
    jsonResponse(200, {
      models: [
        { name: 'qwen2.5:0.5b', model: 'qwen2.5:0.5b' },
        { name: 'gemma3:12b', model: 'gemma3:12b' },
      ],
    }),
};

function routingFetch(url: string): Promise<Response> {
  const route = ROUTES[url];
  return Promise.resolve(route ? route() : new Response('not found', { status: 404 }));
}

describe('§4-4 — دمج الاكتشاف في إقلاع النواة (bootloader → AgentKernel)', () => {
  it('عند التفعيل: يُكتشف سيرفر Ollama الحي وتُكوَّن خلفيته تلقائياً (نماذج حية)', async () => {
    const bootloader = new Bootloader({
      profile: 'agent',
      enableLLMDiscovery: true,
      llmDiscovery: {
        hosts: ['127.0.0.1'],
        ports: [11434],
        timeoutMs: 500,
        fetchImpl: routingFetch,
      },
    });
    await bootloader.boot();

    expect(bootloader.discoveredLLMServers).toHaveLength(1);
    expect(bootloader.discoveredLLMServers[0].vendor).toBe('ollama');
    expect(bootloader.discoveredLLMServers[0].version).toBe('0.32.1');

    const models = bootloader.agentKernel!.llm.availableModels();
    expect(models).toContainEqual({ name: 'ollama@11434', model: 'qwen2.5:0.5b' });
    expect(models).toContainEqual({ name: 'deterministic', model: 'deterministic-v1' });

    // الخلفية الحتمية أولاً → لا اعتماد على الشبكة في الرد
    const chatRes = await bootloader.agentKernel!.chat('agent-1', [{ role: 'user', content: 'hi' }]);
    expect(chatRes.isOk).toBe(true);
    if (chatRes.isOk) expect(chatRes.value.content).toContain('Deterministic');

    await bootloader.shutdown();
  });

  it('عند غياب السيرفر (رفض الاتصال) لا تُضاف خلفية ولا يُسقط الاكتشاف الإقلاع', async () => {
    const bootloader = new Bootloader({
      profile: 'agent',
      enableLLMDiscovery: true,
      llmDiscovery: {
        hosts: ['127.0.0.1'],
        ports: [11434],
        timeoutMs: 200,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    await bootloader.boot();

    expect(bootloader.discoveredLLMServers).toEqual([]);
    const models = bootloader.agentKernel!.llm.availableModels();
    expect(models).toEqual([{ name: 'deterministic', model: 'deterministic-v1' }]);

    await bootloader.shutdown();
  });

  it('الافتراضي (بلا تفعيل): لا شبكة عند الإقلاع — خلفية واحدة فقط وتبقى ميزانية الأداء محفوظة', async () => {
    const bootloader = new Bootloader({ profile: 'agent' });
    await bootloader.boot();

    expect(bootloader.discoveredLLMServers).toEqual([]);
    expect(bootloader.agentKernel!.llm.availableModels()).toEqual([
      { name: 'deterministic', model: 'deterministic-v1' },
    ]);

    await bootloader.shutdown();
  });

  it('ملف الإعداد enableLLMDiscovery:true يُفعّل الاكتشاف (المجال معتمد)', async () => {
    const tmpDir = path.join(process.cwd(), '.tmp_llm_disc_cfg');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const cfgPath = path.join(tmpDir, 'disc.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ profile: 'agent', enableLLMDiscovery: true }));

    try {
      const bootloader = new Bootloader({
        configPath: cfgPath,
        llmDiscovery: {
          hosts: ['127.0.0.1'],
          ports: [11434],
          timeoutMs: 500,
          fetchImpl: routingFetch,
        },
      });
      await bootloader.boot();

      expect(bootloader.discoveredLLMServers).toHaveLength(1);
      expect(bootloader.agentKernel!.llm.availableModels()).toContainEqual({
        name: 'ollama@11434',
        model: 'qwen2.5:0.5b',
      });

      await bootloader.shutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
