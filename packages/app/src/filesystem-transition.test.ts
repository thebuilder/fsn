import { describe, expect, it, vi } from "vitest";
import { LatestSourceTransition } from "./filesystem-transition";

type Source = { name: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestSourceTransition", () => {
  it("commits only the latest prepared source and disposes every abandoned owner once", async () => {
    const disposed: Source[] = [];
    const transition = new LatestSourceTransition<Source>((source) => {
      disposed.push(source);
    });
    const initial = { name: "initial" };
    const first = { name: "first" };
    const latest = { name: "latest" };
    const firstReady = deferred();
    const latestReady = deferred();
    const commit = vi.fn(() => ({ status: "activated" as const, previous: initial }));

    const firstResult = transition.replace(first, () => firstReady.promise, commit);
    const latestResult = transition.replace(latest, () => latestReady.promise, commit);
    firstReady.resolve();
    await expect(firstResult).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();

    latestReady.resolve();
    await expect(latestResult).resolves.toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(disposed).toEqual([first, initial]);

    await transition.dispose(first);
    await transition.dispose(initial);
    expect(disposed).toEqual([first, initial]);
  });

  it("disposes a candidate whose preparation fails", async () => {
    const disposed: Source[] = [];
    const transition = new LatestSourceTransition<Source>((source) => {
      disposed.push(source);
    });
    const candidate = { name: "broken" };

    await expect(transition.replace(candidate, () => {
      throw new Error("unreadable");
    }, () => ({ status: "activated", previous: { name: "unused" } }))).rejects.toThrow("unreadable");
    expect(disposed).toEqual([candidate]);
  });

  it("invalidates preparation during teardown", async () => {
    const disposed: Source[] = [];
    const transition = new LatestSourceTransition<Source>((source) => {
      disposed.push(source);
    });
    const candidate = { name: "pending" };
    const ready = deferred();
    const result = transition.replace(candidate, () => ready.promise, () => ({ status: "activated", previous: { name: "unused" } }));

    transition.invalidate();
    ready.resolve();

    await expect(result).resolves.toBe(false);
    expect(disposed).toEqual([candidate]);
  });

  it("releases the previous owner even when settling the committed source fails", async () => {
    const disposed: Source[] = [];
    const transition = new LatestSourceTransition<Source>((source) => {
      disposed.push(source);
    });
    const previous = { name: "previous" };
    const candidate = { name: "candidate" };

    await expect(transition.replace(
      candidate,
      () => undefined,
      () => ({ status: "activated", previous, settled: Promise.reject(new Error("render failed")) }),
    )).rejects.toThrow("render failed");
    expect(disposed).toEqual([previous]);
  });

  it("disposes a prepared candidate exactly once when activation is rejected", async () => {
    const disposed: Source[] = [];
    const transition = new LatestSourceTransition<Source>((source) => {
      disposed.push(source);
    });
    const candidate = { name: "rejected" };

    await expect(transition.replace(
      candidate,
      () => undefined,
      () => ({ status: "rejected" }),
    )).resolves.toBe(false);
    await transition.dispose(candidate);

    expect(disposed).toEqual([candidate]);
  });
});
