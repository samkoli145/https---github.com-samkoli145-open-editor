import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnowballContext, SessionInstance, SessionManager, type SnowballKnowledgeItem } from '../src/agent-kernel/session';
import { KnowledgeLayer, SOURCE_RELIABILITY_WEIGHTS, PROMOTION_THRESHOLD, MAX_KNOWLEDGE_RECORDS } from '../src/host/snowball/knowledge-layer';
import type { KnowledgeEntry } from '../src/host/snowball/types';
import { SafeSystemStorageEngine } from '../src/system/storage';

describe('Snowball Context Injection (§4-7 / Cloud Guidelines)', () => {
  it('buildSnowballContext filters by minConfidence and limits entries', () => {
    const items: SnowballKnowledgeItem[] = [
      { key: 'prefers typescript strict', confidence: 0.99, tier: 'pattern' },
      { key: 'low trust pattern', confidence: 0.5, tier: 'pattern' },
      { key: 'xdg-open for desktop', confidence: 0.91, tier: 'pattern' }
    ];
    const ctx = buildSnowballContext(items, { minConfidence: 0.85, limit: 5 });
    expect(ctx).toContain('[SNOWBALL_MEMORY_CONTEXT]');
    expect(ctx).toContain('prefers typescript strict');
    expect(ctx).toContain('xdg-open for desktop');
    expect(ctx).not.toContain('low trust pattern');
  });

  it('buildSnowballContext returns empty string when nothing passes threshold', () => {
    const ctx = buildSnowballContext([{ key: 'x', confidence: 0.1, tier: 'pattern' }], { minConfidence: 0.85 });
    expect(ctx).toBe('');
  });

  it('buildSnowballContext enforces maxTokens cap', () => {
    const items: SnowballKnowledgeItem[] = [];
    for (let i = 0; i < 20; i++) {
      items.push({ key: 'some long pattern content number ' + i, confidence: 0.95, tier: 'context' });
    }
    const ctx = buildSnowballContext(items, { minConfidence: 0.85, maxTokens: 8 });
    const maxChars = 8 * 4;
    expect(ctx.length).toBeLessThanOrEqual(maxChars + 1 + '[/SNOWBALL_MEMORY_CONTEXT]'.length);
    expect(ctx.endsWith('[/SNOWBALL_MEMORY_CONTEXT]')).toBe(true);
  });

  it('SessionInstance.injectSnowballContext stores formatted context in metadata', () => {
    const session = new SessionInstance('s1', 'agent', {});
    const items: SnowballKnowledgeItem[] = [
      { key: 'user prefers vim', confidence: 0.98, tier: 'pattern' }
    ];
    const injected = session.injectSnowballContext(items, { minConfidence: 0.85 });
    expect(injected).toContain('user prefers vim');
    expect(session.metadata['snowballContext']).toBe(injected);
  });

  it('SessionManager creates sessions still working after injection API addition', () => {
    const mgr = new SessionManager();
    const created = mgr.createSession('ctx-1');
    expect(created.isOk).toBe(true);
    const session = mgr.getSession('ctx-1');
    expect(session).toBeDefined();
    expect(session!.injectSnowballContext([])).toBe('');
  });
});

describe('KnowledgeLayer Source Reliability & Eviction (§4-7 / Cloud Guidelines)', () => {
  const dir = join(tmpdir(), `nawat-snowball-${Date.now()}`);
  let storage: SafeSystemStorageEngine;
  let layer: KnowledgeLayer;

  beforeEach(() => {
    storage = new SafeSystemStorageEngine(dir);
    layer = new KnowledgeLayer(storage);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defines the source reliability weights table', () => {
    expect(SOURCE_RELIABILITY_WEIGHTS['user_interface']).toBe(1.0);
    expect(SOURCE_RELIABILITY_WEIGHTS['system_command']).toBe(0.9);
    expect(SOURCE_RELIABILITY_WEIGHTS['local_llm']).toBe(0.75);
    expect(SOURCE_RELIABILITY_WEIGHTS['external_cloud']).toBe(0.5);
    expect(PROMOTION_THRESHOLD).toBe(0.85);
    expect(MAX_KNOWLEDGE_RECORDS).toBe(2000);
  });

  it('weights confidence by source reliability on add', async () => {
    const res = await layer.add({
      tier: 'pattern',
      key: 'high-trust',
      data: { pattern: 'vscode' },
      confidence: 0.99,
      tags: ['extracted'],
      source: 'user_interface'
    });
    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.confidence).toBeCloseTo(0.99, 5);
    }

    const external = await layer.add({
      tier: 'pattern',
      key: 'external-low',
      data: { pattern: 'scraped' },
      confidence: 0.99,
      tags: ['extracted'],
      source: 'external_cloud'
    });
    expect(external.isOk).toBe(true);
    if (external.isOk) {
      expect(external.value.confidence).toBeCloseTo(0.99 * 0.5, 5);
    }
  });

  it('keeps the highest confidence on re-add across sources', async () => {
    await layer.add({
      tier: 'pattern', key: 'dup', data: { v: 1 }, confidence: 0.99, tags: [], source: 'user_interface'
    });
    const lower = await layer.add({
      tier: 'pattern', key: 'dup', data: { v: 2 }, confidence: 0.6, tags: [], source: 'external_cloud'
    });
    expect(lower.isOk).toBe(true);
    if (lower.isOk) {
      expect(lower.value.confidence).toBeGreaterThanOrEqual(0.99);
      expect(lower.value.accessCount).toBe(2);
    }
  });

  it('calculates exponential time decay: half-life 7 days halves the score', () => {
    const now = Date.now();
    const halfLifeMs = 7 * 24 * 3600 * 1000;
    const fresh: KnowledgeEntry = {
      id: 'fresh-1', tier: 'pattern', key: 'fresh_fact', confidence: 0.9, source: 'user',
      data: {}, accessCount: 10, lastAccessed: now, createdAt: now, updatedAt: now, tags: []
    };
    const old: KnowledgeEntry = {
      id: 'old-1', tier: 'pattern', key: 'old_fact', confidence: 0.9, source: 'user',
      data: {}, accessCount: 10, lastAccessed: now - halfLifeMs, createdAt: now - halfLifeMs, updatedAt: now - halfLifeMs, tags: []
    };
    const freshScore = layer.calculateEntryScore(fresh, now);
    const oldScore = layer.calculateEntryScore(old, now);
    expect(freshScore).toBeCloseTo(9.0, 1);
    expect(oldScore).toBeCloseTo(4.5, 1);
    expect(freshScore).toBeGreaterThan(oldScore);
  });

  it('protects pinned entries from eviction and evicts lowest score on overflow', async () => {
    const smallLayer = new KnowledgeLayer(storage, 1000, 3600000);
    (smallLayer as any).maxRecords = 5;

    for (let i = 0; i < 4; i++) {
      await smallLayer.add({
        tier: 'pattern', key: `pinned-${i}`, data: { i }, confidence: 0.5, tags: ['system_pinned'], source: 'system_command'
      });
    }
    for (let i = 0; i < 4; i++) {
      await smallLayer.add({
        tier: 'pattern', key: `volatile-${i}`, data: { i }, confidence: 0.1, tags: [], source: 'external_cloud'
      });
    }

    expect(smallLayer.totalCount()).toBeLessThanOrEqual(5);
    for (let i = 0; i < 4; i++) {
      const pinned = await smallLayer.findByKey(`pinned-${i}`, 'pattern');
      expect(pinned.isOk).toBe(true);
    }
    const remaining = (await smallLayer.query({ tier: 'pattern' })).filter(e => e.key.startsWith('volatile-'));
    expect(remaining.length).toBeLessThan(4);
  });
});
