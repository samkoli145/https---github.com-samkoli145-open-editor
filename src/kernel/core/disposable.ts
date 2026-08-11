export interface Disposable {
  dispose(): void;
}

/**
 * دالة مساعدة لتحويل دالة التنظيف إلى كائن Disposable
 */
export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private toDispose = new Set<Disposable>();
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * إضافة كائن قابل للتخلص منه إلى المتجر مع ربط التنظيف التلقائي عند التخلص الفردي
   */
  add<T extends Disposable>(disposable: T): T {
    if (this.isDisposed) {
      disposable.dispose();
      return disposable;
    }

    const originalDispose = disposable.dispose.bind(disposable);
    let disposed = false;
    disposable.dispose = () => {
      if (disposed) return;
      disposed = true;
      this.toDispose.delete(disposable);
      originalDispose();
    };

    this.toDispose.add(disposable);
    return disposable;
  }

  /**
   * حذف كائن محدد من متجر التنظيف بدون استدعاء dispose() عليه
   */
  delete(disposable: Disposable): void {
    this.toDispose.delete(disposable);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const item of this.toDispose) {
      try {
        item.dispose();
      } catch (e) {
        console.error('Error disposing resource:', e);
      }
    }
    this.toDispose.clear();
  }
}

