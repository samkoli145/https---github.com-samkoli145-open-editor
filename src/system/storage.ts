import { Result, ok, err } from '../kernel/core/result';
import { sanitizePath } from './vfs/path-sanitizer';

export interface SystemStorageRecord<T = any> {
  version: number;
  timestamp: number;
  checksum: string;
  key: string;
  payload: T;
}

export interface ISystemStorageEngine {
  save<T>(key: string, data: T): Promise<Result<void, Error>>;
  load<T>(key: string): Promise<Result<T, Error>>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<Result<void, Error>>;
  clear(): void;
}

/**
 * Robust non-cryptographic / FNV-1a checksum fallback generator
 */
export function computeFastChecksum(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Production-grade Safe Storage Engine with Atomic Writes,
 * Path Traversal Key Sanitization, Checksum Validation, and Corruption Bounds.
 */
export class SafeSystemStorageEngine implements ISystemStorageEngine {
  private store = new Map<string, string>();
  private maxRecords = 2000;

  constructor(public readonly storageRoot = '/vfs/storage') {}

  public async save<T>(key: string, data: T): Promise<Result<void, Error>> {
    const sanitizeRes = sanitizePath(key, this.storageRoot);
    if (!sanitizeRes.isOk) {
      return err(new Error(`ESECURITY_VIOLATION: Invalid storage key path '${key}': ${sanitizeRes.error.message}`));
    }

    const sanitizedKey = sanitizeRes.value;

    if (!this.store.has(sanitizedKey) && !this.store.has(key) && this.store.size >= this.maxRecords) {
      return err(new Error(`ESTORAGE_FULL: Storage capacity limit (${this.maxRecords} records) reached`));
    }

    try {
      const payloadStr = JSON.stringify(data);
      const checksum = computeFastChecksum(payloadStr);

      const record: SystemStorageRecord<T> = {
        version: 1,
        timestamp: Date.now(),
        checksum,
        key: sanitizedKey,
        payload: data
      };

      const serializedRecord = JSON.stringify(record);

      // Atomic swap pattern (Write to temp buffer before updating store map)
      const tempBuffer = serializedRecord;
      if (tempBuffer.length === 0) {
        return err(new Error(`ESTORAGE_WRITE: Atomic buffer serialization failed for '${key}'`));
      }

      this.store.set(sanitizedKey, tempBuffer);
      this.store.set(key, tempBuffer);
      return ok(undefined);
    } catch (e: any) {
      return err(new Error(`ESTORAGE_WRITE: Failed to save storage record '${key}': ${e.message}`));
    }
  }

  public async load<T>(key: string): Promise<Result<T, Error>> {
    const sanitizeRes = sanitizePath(key, this.storageRoot);
    const sanitizedKey = sanitizeRes.isOk ? sanitizeRes.value : key;
    
    if (!sanitizeRes.isOk && !this.store.has(key)) {
      return err(new Error(`ESECURITY_VIOLATION: Invalid storage key path '${key}': ${sanitizeRes.error.message}`));
    }

    const raw = this.store.get(key) || this.store.get(sanitizedKey);
    if (!raw) {
      return err(new Error(`ENOENT: Storage record '${key}' not found`));
    }

    try {
      const record = JSON.parse(raw) as SystemStorageRecord<T>;
      if (!record || typeof record !== 'object' || !record.checksum || record.payload === undefined) {
        return err(new Error(`ECORRUPT: Storage record '${key}' is missing required snapshot schema metadata`));
      }

      const payloadStr = JSON.stringify(record.payload);
      const expectedChecksum = computeFastChecksum(payloadStr);

      if (record.checksum !== expectedChecksum) {
        return err(new Error(`ECORRUPT: Storage record '${key}' checksum mismatch! Expected ${record.checksum}, calculated ${expectedChecksum}.`));
      }

      return ok(record.payload);
    } catch (e: any) {
      if (e.message?.startsWith('ECORRUPT')) {
        return err(e);
      }
      return err(new Error(`ESTORAGE_READ: Corrupted record '${key}': ${e.message}`));
    }
  }

  public async exists(key: string): Promise<boolean> {
    const sanitizeRes = sanitizePath(key, this.storageRoot);
    const sanitizedKey = sanitizeRes.isOk ? sanitizeRes.value : key;
    return this.store.has(key) || this.store.has(sanitizedKey);
  }

  public async delete(key: string): Promise<Result<void, Error>> {
    const sanitizeRes = sanitizePath(key, this.storageRoot);
    const sanitizedKey = sanitizeRes.isOk ? sanitizeRes.value : key;
    if (!this.store.has(sanitizedKey) && !this.store.has(key)) {
      return err(new Error(`ENOENT: Record '${key}' not found`));
    }
    this.store.delete(sanitizedKey);
    this.store.delete(key);
    return ok(undefined);
  }

  public async append<T>(key: string, item: T): Promise<Result<void, Error>> {
    const existingRes = await this.load<T[]>(key);
    const list: T[] = existingRes.isOk && Array.isArray(existingRes.value) ? existingRes.value : [];
    list.push(item);
    if (list.length > this.maxRecords) {
      list.shift();
    }
    return this.save<T[]>(key, list);
  }

  public async list<T>(keyPrefix: string): Promise<Result<T[], Error>> {
    const listRes = await this.load<T[]>(keyPrefix);
    if (listRes.isOk && Array.isArray(listRes.value)) {
      return listRes;
    }
    const matching: T[] = [];
    for (const [k] of this.store.entries()) {
      if (k.startsWith(keyPrefix)) {
        const itemRes = await this.load<T>(k);
        if (itemRes.isOk) {
          matching.push(itemRes.value);
        }
      }
    }
    return ok(matching);
  }

  public clear(): void {
    this.store.clear();
  }
}
