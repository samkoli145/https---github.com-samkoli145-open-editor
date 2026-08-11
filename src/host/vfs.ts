export class VirtualFileSystem {
  public isMounted: boolean = false;
  public isDisposed: boolean = false;

  constructor(public readonly root: string = '/vfs') {}

  public mount(): void {
    if (this.isDisposed) {
      throw new Error('Cannot mount disposed VFS');
    }
    this.isMounted = true;
  }

  public dispose(): void {
    this.isMounted = false;
    this.isDisposed = true;
  }
}
