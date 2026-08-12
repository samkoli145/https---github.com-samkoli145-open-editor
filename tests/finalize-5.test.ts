import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, SessionManager, ContextModel, DEFAULT_TOKEN_COUNTER } from '../src/index';
import { PersistentIndexer, type VFSFileIndexEntry } from '../src/index';
import { isAbsolute } from 'node:path';

describe('§5-ح — أخطاء مستمعي SessionInstance.emitStream لا تُبتلع', () => {
  it('يوجّه خطأ المستمع إلى EventBus (session:stream:error) ويواصل البث لباقي المستمعين', () => {
    const bus = new EventBus();
    const errors: any[] = [];
    bus.on('session:stream:error', (data: any) => errors.push(data), []);

    const manager = new SessionManager(bus);
    const createRes = manager.createSession('sess_hat', 'agent_alpha');
    expect(createRes.isOk).toBe(true);
    if (!createRes.isOk) return;

    const session = createRes.value;
    const receivedMsgs: any[] = [];
    session.onStream(() => { throw new Error('listener exploded'); });
    session.onStream((msg: any) => receivedMsgs.push(msg));

    session.emitStream('stream', { text: 'ok' });

    // المستمع الثاني ما زال استلم الرسالة
    expect(receivedMsgs.length).toBe(1);
    expect(receivedMsgs[0].msgType).toBe('stream');
    // والخطأ صار مرئياً عبر EventBus لا مدفوناً
    expect(errors.length).toBe(1);
    expect(errors[0].payload.sessionId).toBe('sess_hat');
    expect(errors[0].payload.msgType).toBe('stream');
    expect(errors[0].payload.error).toContain('listener exploded');
  });
});

describe('§5-ك — عدّاد توكنات معياري قابل للحقن (ContextModel)', () => {
  it('يستخدم DEFAULT_TOKEN_COUNTER (كلمات + نصف علامات الترقيم) لا طول/4', () => {
    const text = 'hello world, how are you?';
    // 5 كلمات مفصولة + 2 علامات ترقيم × 0.5 = 6
    expect(DEFAULT_TOKEN_COUNTER(text)).toBe(6);
    expect(DEFAULT_TOKEN_COUNTER('')).toBe(0);
  });

  it('يقبل عدّاداً محقوناً في estimateTokens', () => {
    const model = new ContextModel({ tokenCounter: () => 42 });
    model.append('user', 'ignored content');
    model.append('assistant', 'more ignored');
    expect(model.estimateTokens()).toBe(84);
  });

  it('يمكن تبديل العدّاد بعد الإنشاء عبر setTokenCounter', () => {
    const model = new ContextModel();
    model.append('user', 'x');
    expect(model.estimateTokens()).toBe(DEFAULT_TOKEN_COUNTER('x'));
    model.setTokenCounter(() => 5);
    expect(model.estimateTokens()).toBe(5);
  });
});

describe('§5-طـ — PersistentIndexer يخزّن هدف السيملينك ويرفض الهروب عند التسجيل', () => {
  it('يرفض تسجيل سيملينك هدفه خارج جذر الفهرس (هروب)', () => {
    const indexer = new PersistentIndexer('/vfs');
    const res = indexer.registerFile('/vfs/escape_link', 'link', 'h', 0o755, 1000, 1000, 'symlink', '/etc/hostname');
    expect(res.isErr).toBe(true);
    if (res.isErr) {
      expect(res.error.message).toContain('ESECURITY');
    }
  });

  it('يخزّن الهدف ويسجّله لسيملينك داخل الجذر', () => {
    const indexer = new PersistentIndexer('/vfs');
    const res = indexer.registerFile('/vfs/inside_link', 'link', 'h2', 0o755, 1000, 1000, 'symlink', '/vfs/src/main.ts');
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      const entry = res.value;
      expect(entry.type).toBe('symlink');
      expect(entry.linkTarget).toBe('/vfs/src/main.ts');
    }

    const targetRes = indexer.resolveLinkTarget('/vfs/inside_link');
    expect(targetRes.isOk).toBe(true);
    if (targetRes.isOk) {
      expect(targetRes.value).toBe('/vfs/src/main.ts');
    }
  });

  it('رفض الهروب يمنع إدراج العقدة في الفهرس أصلاً', () => {
    const indexer = new PersistentIndexer('/vfs');
    indexer.registerFile('/vfs/bad_link', 'link', 'h3', 0o755, 1000, 1000, 'symlink', '/etc/passwd');
    const entries: VFSFileIndexEntry[] = indexer.getAllEntries();
    expect(entries.some((e) => e.path === '/vfs/bad_link')).toBe(false);
  });

  it('يرفض سيملينك بعيد مطلق لا تحت الجذر حتى لو كان نسبياً يهرب', () => {
    const indexer = new PersistentIndexer('/vfs');
    const res = indexer.registerFile('/vfs/deep/nested/link', 'link', 'h4', 0o755, 1000, 1000, 'symlink', '../../../../etc/passwd');
    expect(res.isErr).toBe(true);
  });

  it('linkTarget محفوظ في snapshot (serialize/deserialize)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nawat-index-f5-'));
    const indexPath = join(tmp, 'index.json');
    try {
      const indexer = new PersistentIndexer('/vfs', indexPath);
      indexer.registerFile('/vfs/src/target.ts', 'export {}', 'h5', 0o644, 1000, 1000);
      indexer.registerFile('/vfs/target_link', 'link', 'h6', 0o755, 1000, 1000, 'symlink', '/vfs/src/target.ts');
      const saved = indexer.syncToDisk();
      expect(saved.isOk).toBe(true);

      const reloaded = new PersistentIndexer('/vfs', indexPath);
      const targetRes = reloaded.resolveLinkTarget('/vfs/target_link');
      expect(targetRes.isOk).toBe(true);
      if (targetRes.isOk) {
        expect(targetRes.value).toBe('/vfs/src/target.ts');
      }
      expect(isAbsolute('/vfs/src/target.ts')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
