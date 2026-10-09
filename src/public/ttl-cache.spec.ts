import { TtlCache } from "./ttl-cache";

describe("TtlCache", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("loads once and serves the cached value within the TTL", async () => {
    const cache = new TtlCache<number>(1000);
    const loader = jest.fn().mockResolvedValue(42);

    expect(await cache.getOrLoad("k", loader)).toBe(42);
    jest.advanceTimersByTime(999);
    expect(await cache.getOrLoad("k", loader)).toBe(42);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads once the TTL has elapsed", async () => {
    const cache = new TtlCache<number>(1000);
    const loader = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await cache.getOrLoad("k", loader);
    jest.advanceTimersByTime(1000);

    expect(await cache.getOrLoad("k", loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps independent entries per key", async () => {
    const cache = new TtlCache<string>(1000);
    await cache.getOrLoad("a", async () => "A");
    await cache.getOrLoad("b", async () => "B");

    expect(await cache.getOrLoad("a", async () => "other")).toBe("A");
    expect(await cache.getOrLoad("b", async () => "other")).toBe("B");
  });

  it("evicts the oldest entry when the size cap is reached", async () => {
    const cache = new TtlCache<string>(10_000, 2);
    await cache.getOrLoad("a", async () => "A");
    await cache.getOrLoad("b", async () => "B");
    await cache.getOrLoad("c", async () => "C");

    const loaderA = jest.fn().mockResolvedValue("A2");
    const loaderC = jest.fn().mockResolvedValue("C2");
    expect(await cache.getOrLoad("a", loaderA)).toBe("A2");
    expect(await cache.getOrLoad("c", loaderC)).toBe("C");
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderC).not.toHaveBeenCalled();
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>(1000);
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(7);

    await expect(cache.getOrLoad("k", loader)).rejects.toThrow("fail");
    expect(await cache.getOrLoad("k", loader)).toBe(7);
  });
});
