import { Result } from '../kernel/core/result';
import { SafeSystemStorageEngine, computeFastChecksum } from '../system/storage';

export interface StorageRecord<T = any> {
  version: number;
  timestamp: number;
  checksum: string;
  payload: T;
}

export interface IStorageEngine {
  save<T>(key: string, data: T): Promise<Result<void, Error>>;
  load<T>(key: string): Promise<Result<T, Error>>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<Result<void, Error>>;
}

export const computeChecksum = computeFastChecksum;

export class SafeStorageEngine extends SafeSystemStorageEngine implements IStorageEngine {}
