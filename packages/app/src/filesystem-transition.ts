/**
 * Serializes ownership changes while allowing expensive preparation to overlap.
 * Only the newest prepared candidate may commit; every abandoned source is disposed once.
 */
export class LatestSourceTransition<T extends object> {
  private revision = 0;
  private readonly disposed = new WeakSet<T>();

  constructor(private readonly disposeSource: (source: T) => void | Promise<void>) {}

  async replace(
    candidate: T,
    prepare: (candidate: T) => void | Promise<void>,
    activate: (candidate: T) => { status: "rejected" } | { status: "activated"; previous: T; settled?: Promise<void> },
  ): Promise<boolean> {
    const revision = (this.revision += 1);
    try {
      await prepare(candidate);
    } catch (error) {
      await this.dispose(candidate);
      throw error;
    }

    if (revision !== this.revision) {
      await this.dispose(candidate);
      return false;
    }

    const activation = activate(candidate);
    if (activation.status === "rejected") {
      await this.dispose(candidate);
      return false;
    }

    const { previous, settled } = activation;
    try {
      await settled;
    } finally {
      if (previous !== candidate) await this.dispose(previous);
    }
    return true;
  }

  invalidate(): void {
    this.revision += 1;
  }

  async dispose(source: T): Promise<void> {
    if (this.disposed.has(source)) return;
    this.disposed.add(source);
    await this.disposeSource(source);
  }
}
