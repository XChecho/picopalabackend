import { Reflector } from "@nestjs/core";
import { ThrottlerModuleOptions, ThrottlerStorage } from "@nestjs/throttler";
import { ClientIpThrottlerGuard } from "./client-ip-throttler.guard";

const SECRET = "bff-shared-secret";

class Probe extends ClientIpThrottlerGuard {
  track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

describe("ClientIpThrottlerGuard.getTracker", () => {
  let guard: Probe;
  const previous = process.env.BFF_SHARED_SECRET;

  beforeEach(() => {
    process.env.BFF_SHARED_SECRET = SECRET;
    guard = new Probe(
      { throttlers: [{ ttl: 1000, limit: 1 }] } as ThrottlerModuleOptions,
      {} as ThrottlerStorage,
      new Reflector(),
    );
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.BFF_SHARED_SECRET;
    else process.env.BFF_SHARED_SECRET = previous;
  });

  it("uses X-Client-IP when the BFF key is valid", async () => {
    await expect(
      guard.track({
        ip: "10.0.0.1",
        headers: { "x-bff-key": SECRET, "x-client-ip": "198.51.100.4" },
      }),
    ).resolves.toBe("198.51.100.4");
  });

  it("uses req.ip when the key is missing", async () => {
    await expect(
      guard.track({
        ip: "10.0.0.1",
        headers: { "x-client-ip": "198.51.100.4" },
      }),
    ).resolves.toBe("10.0.0.1");
  });

  it("uses req.ip when the key has a different length", async () => {
    await expect(
      guard.track({
        ip: "10.0.0.1",
        headers: { "x-bff-key": "short", "x-client-ip": "198.51.100.4" },
      }),
    ).resolves.toBe("10.0.0.1");
  });

  it("uses req.ip when X-Client-IP is invalid", async () => {
    await expect(
      guard.track({
        ip: "10.0.0.1",
        headers: { "x-bff-key": SECRET, "x-client-ip": "garbage" },
      }),
    ).resolves.toBe("10.0.0.1");
  });

  it("delegates to the base tracker for non-HTTP (WebSocket) contexts", async () => {
    // A socket-like object has no `headers`: must not throw nor read forged data.
    await expect(guard.track({ ip: "10.0.0.2" })).resolves.toBe("10.0.0.2");
    await expect(guard.track({})).resolves.toBeUndefined();
  });
});
