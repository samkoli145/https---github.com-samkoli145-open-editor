import { describe, it, expect } from 'vitest';
import {
  LRUCache,
  SafeStorageEngine,
  computeChecksum,
  SessionManager,
  ResourceQuotaGuard
} from '../src/agent-kernel/index';

describe('Architecture Enhancements - Cache, Storage, Session, & Quota', () => {

  // -------------------------------------------------------------------
  // 1. O(1) LRU Cache & Sub-10ms Latency Budget
  // -------------------------------------------------------------------
  describe('LRUCache Sub-10ms Latency Budget', () => {
    it('evicts least recently used items when maxSize is exceeded', () => {
      const cache = new LRUCache<string, string>({ maxSize: 3 });
      cache.set('k1', 'v1');
      cache.set('k2', 'v2');
      cache.set('k3', 'v3');

      // Refresh k1
      expect(cache.get('k1')).toBe('v1');

      // Adding k4 should evict k2
      cache.set('k4', 'v4');

      expect(cache.has('k1')).toBe(true);
      expect(cache.has('k2')).toBe(false); // evicted
      expect(cache.has('k3')).toBe(true);
      expect(cache.has('k4')).toBe(true);
    });

    it('honors TTL expiration on cached items', async () => {
      const cache = new LRUCache<string, string>({ defaultTtlMs: 20 });
      cache.set('short', 'temp');

      expect(cache.get('short')).toBe('temp');

      // Wait 30ms
      await new Promise(r => setTimeout(r, 30));

      expect(cache.get('short')).toBeUndefined(); // expired
    });

    it('tracks hit/miss metrics accurately for sub-10ms monitoring', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });
      cache.set('a', 100);

      cache.get('a'); // hit
      cache.get('b'); // miss

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(1);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRatio).toBe(0.5);
    });
  });

  // -------------------------------------------------------------------
  // 2. Safe Storage Engine & Integrity Checksum Validation
  // -------------------------------------------------------------------
  describe('Safe Storage Engine Checksum Integrity', () => {
    it('computes deterministic checksum for strings', () => {
      const hash1 = computeChecksum('{"state":"ok"}');
      const hash2 = computeChecksum('{"state":"ok"}');
      const hash3 = computeChecksum('{"state":"corrupted"}');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });

    it('saves and restores data safely with valid checksum', async () => {
      const storage = new SafeStorageEngine();
      const stateData = { agentId: 'ag-1', notes: ['n1', 'n2'], v: 2 };

      const saveRes = await storage.save('snapshot_1', stateData);
      expect(saveRes.isOk).toBe(true);

      const loadRes = await storage.load<typeof stateData>('snapshot_1');
      expect(loadRes.isOk).toBe(true);
      if (loadRes.isOk) {
        expect(loadRes.value.agentId).toBe('ag-1');
        expect(loadRes.value.notes.length).toBe(2);
      }
    });

    it('rejects corrupted snapshot payload on checksum mismatch', async () => {
      const storage = new SafeStorageEngine();
      await storage.save('snap_corrupt', { secret: 'data' });

      // Directly tamper raw store content to simulate disk bit-rot or bad write
      const storeMap = (storage as any).store as Map<string, string>;
      const raw = storeMap.get('snap_corrupt')!;
      const parsed = JSON.parse(raw);
      parsed.payload.secret = 'TAMPERED_DATA'; // mutate payload without updating checksum
      storeMap.set('snap_corrupt', JSON.stringify(parsed));

      const loadRes = await storage.load('snap_corrupt');
      expect(loadRes.isErr).toBe(true);
      if (loadRes.isErr) {
        expect(loadRes.error.message).toContain('ECORRUPT');
      }
    });
  });

  // -------------------------------------------------------------------
  // 3. Jupyter/Ansible Stateful Session Manager & Live Output Streaming
  // -------------------------------------------------------------------
  describe('SessionManager (Jupyter/Ansible Interactive Sessions)', () => {
    it('creates isolated sessions and streams execute_request and display_data', () => {
      const manager = new SessionManager();
      const createRes = manager.createSession('sess_101', 'agent_alpha');

      expect(createRes.isOk).toBe(true);
      if (createRes.isOk) {
        const session = createRes.value;

        const receivedMsgs: any[] = [];
        session.onStream((msg: any) => receivedMsgs.push(msg));

        session.emitStream('stream', { text: 'Running task...' });
        session.emitStream('display_data', { chart: [1, 2, 3] });

        expect(receivedMsgs.length).toBe(2);
        expect(receivedMsgs[0].msgType).toBe('stream');
        expect(receivedMsgs[1].msgType).toBe('display_data');
      }
    });

    it('handles interrupt_request cleanly to stop hanging execution', () => {
      const manager = new SessionManager();
      manager.createSession('sess_interrupt', 'agent_beta');

      const interruptRes = manager.interruptSession('sess_interrupt', 'Execution timeout');
      expect(interruptRes.isOk).toBe(true);

      const session = manager.getSession('sess_interrupt');
      expect(session?.state).toBe('interrupted');
    });
  });

  // -------------------------------------------------------------------
  // 4. Resource Quota Guard & Hard Termination (OOM/Rogue Agent Protection)
  // -------------------------------------------------------------------
  describe('Resource Quota Guard & OOM Isolation', () => {
    it('enforces maximum memory budget and triggers EOM error', () => {
      const guard = new ResourceQuotaGuard();
      guard.setQuota('ag_rogue', { maxMemoryBytes: 1000 });

      expect(guard.trackMemory('ag_rogue', 500).isOk).toBe(true);

      const oomRes = guard.trackMemory('ag_rogue', 1500);
      expect(oomRes.isErr).toBe(true);
      if (oomRes.isErr) {
        expect(oomRes.error.message).toContain('EOM');
      }
    });

    it('enforces rate limits on syscall count and error thresholds', () => {
      const guard = new ResourceQuotaGuard();
      guard.setQuota('ag_rate', { maxSyscallsPerMinute: 2, maxErrorThreshold: 3 });

      expect(guard.trackSyscall('ag_rate').isOk).toBe(true);
      expect(guard.trackSyscall('ag_rate').isOk).toBe(true);

      const rateRes = guard.trackSyscall('ag_rate');
      expect(rateRes.isErr).toBe(true);
      if (rateRes.isErr) {
        expect(rateRes.error.message).toContain('EQUOTA_EXCEEDED');
      }

      // Test error threshold
      guard.trackError('ag_rate');
      guard.trackError('ag_rate');
      const errRes = guard.trackError('ag_rate');
      expect(errRes.isErr).toBe(true);
      if (errRes.isErr) {
        expect(errRes.error.message).toContain('EKILLED');
      }
    });
  });
});
