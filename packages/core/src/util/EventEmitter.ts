/** Minimal typed event emitter. No dependencies, no leaks. */
export class EventEmitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(name, fn);
  }

  once<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): () => void {
    const off = this.on(name, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): void {
    this.handlers.get(name)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        // A listener throwing must never take down the render loop.
        console.error(`[kg3d] listener for "${String(name)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
