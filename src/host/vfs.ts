import { SafeStorageEngine } from '../agent-kernel/storage';
import { Result, ok, err } from '../kernel/core/result';

export class VirtualFileSystem {
  public isMounted: boolean = false;
  public isDisposed: boolean = false;

  private storage: SafeStorageEngine;
  private inMemoryFiles = new Map<string, string>();

  constructor(public readonly root: string = '/vfs') {
    this.storage = new SafeStorageEngine(root);
  }

  public mount(): void {
    if (this.isDisposed) {
      throw new Error('Cannot mount disposed VFS');
    }
    this.isMounted = true;
  }

  public dispose(): void {
    this.isMounted = false;
    this.isDisposed = true;
    this.inMemoryFiles.clear();
  }

  public async writeFile(path: string, content: string): Promise<Result<void, Error>> {
    if (!this.isMounted || this.isDisposed) {
      return err(new Error('ENOTREADY: VFS is not mounted'));
    }
    const fullPath = path.startsWith('/') ? path : `${this.root}/${path}`;
    this.inMemoryFiles.set(fullPath, content);
    return await this.storage.save(fullPath, content);
  }

  public async readFile(path: string): Promise<Result<string, Error>> {
    if (!this.isMounted || this.isDisposed) {
      return err(new Error('ENOTREADY: VFS is not mounted'));
    }
    const fullPath = path.startsWith('/') ? path : `${this.root}/${path}`;
    if (this.inMemoryFiles.has(fullPath)) {
      return ok(this.inMemoryFiles.get(fullPath)!);
    }
    return await this.storage.load<string>(fullPath);
  }

  public async exists(path: string): Promise<boolean> {
    const fullPath = path.startsWith('/') ? path : `${this.root}/${path}`;
    if (this.inMemoryFiles.has(fullPath)) return true;
    return await this.storage.exists(fullPath);
  }

  public async deleteFile(path: string): Promise<Result<void, Error>> {
    const fullPath = path.startsWith('/') ? path : `${this.root}/${path}`;
    this.inMemoryFiles.delete(fullPath);
    return await this.storage.delete(fullPath);
  }

  public listFiles(): string[] {
    return Array.from(this.inMemoryFiles.keys());
  }
}
