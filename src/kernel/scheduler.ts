import { Disposable } from './core/disposable';
import { Priority } from './core/types';

export interface Task {
  id: string;
  run: () => void | Promise<void>;
  priority?: Priority;
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastExecuted = new Map<string, number>();
  private pendingTasks = new Map<string, Task>();

  /**
   * تأجيل تنفيذ المهمة حتى يتوقف استدعاؤها لمدّة ms (Debounce)
   */
  debounce(
    task: Task,
    ms: number,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    const isNewRegistration = !this.timers.has(task.id) && !this.pendingTasks.has(task.id);

    if (this.timers.has(task.id)) {
      clearTimeout(this.timers.get(task.id)!);
    }

    this.pendingTasks.set(task.id, task);

    const timerId = setTimeout(() => {
      this.timers.delete(task.id);
      const latestTask = this.pendingTasks.get(task.id);
      this.pendingTasks.delete(task.id);
      if (latestTask) {
        this.executeTask(latestTask);
      }
    }, ms);

    this.timers.set(task.id, timerId);

    const disposable: Disposable = {
      dispose: () => {
        if (this.pendingTasks.get(task.id) === task) {
          this.pendingTasks.delete(task.id);
          if (this.timers.has(task.id)) {
            clearTimeout(this.timers.get(task.id)!);
            this.timers.delete(task.id);
          }
        }
      },
    };

    if (owner && isNewRegistration) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  /**
   * خنق استدعاء المهمة بحيث لا تُنفّذ أكثر من مرّة واحدة كل ms (Throttle) مع التنسيق بين المهام المتتالية
   */
  throttle(
    task: Task,
    ms: number,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    const isNewRegistration = !this.timers.has(task.id) && !this.pendingTasks.has(task.id);
    const now = Date.now();
    const last = this.lastExecuted.get(task.id) ?? 0;
    const remaining = ms - (now - last);

    if (remaining <= 0) {
      if (this.timers.has(task.id)) {
        clearTimeout(this.timers.get(task.id)!);
        this.timers.delete(task.id);
      }
      this.pendingTasks.delete(task.id);
      this.lastExecuted.set(task.id, now);
      this.executeTask(task);
    } else {
      // دائماً نحفظ أحدث مهمة لتنفيذها عند انتهاء النافذة الزمنية
      this.pendingTasks.set(task.id, task);

      if (!this.timers.has(task.id)) {
        const timerId = setTimeout(() => {
          this.timers.delete(task.id);
          const latestTask = this.pendingTasks.get(task.id);
          this.pendingTasks.delete(task.id);
          this.lastExecuted.set(task.id, Date.now());
          if (latestTask) {
            this.executeTask(latestTask);
          }
        }, remaining);
        this.timers.set(task.id, timerId);
      }
    }

    const disposable: Disposable = {
      dispose: () => {
        if (this.pendingTasks.get(task.id) === task) {
          this.pendingTasks.delete(task.id);
          if (this.timers.has(task.id)) {
            clearTimeout(this.timers.get(task.id)!);
            this.timers.delete(task.id);
          }
        }
      },
    };

    if (owner && isNewRegistration) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  /**
   * إلغاء مؤقت مهمة محددة بمعرّفها
   */
  cancel(taskId: string): void {
    if (this.timers.has(taskId)) {
      clearTimeout(this.timers.get(taskId)!);
      this.timers.delete(taskId);
    }
    this.pendingTasks.delete(taskId);
  }

  /**
   * إلغاء جميع المؤقتات النشطة
   */
  cancelAll(): void {
    for (const timerId of this.timers.values()) {
      clearTimeout(timerId);
    }
    this.timers.clear();
    this.lastExecuted.clear();
    this.pendingTasks.clear();
  }

  /**
   * عدد المؤقتات النشطة حالياً
   */
  getActiveCount(): number {
    return this.timers.size;
  }

  private executeTask(task: Task): void {
    try {
      const result = task.run();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((e) => {
          console.error(`[Scheduler] Async error in task '${task.id}':`, e);
        });
      }
    } catch (e) {
      console.error(`[Scheduler] Synchronous error in task '${task.id}':`, e);
    }
  }
}

