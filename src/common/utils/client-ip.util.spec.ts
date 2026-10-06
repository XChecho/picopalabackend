import { getClientIp } from "./client-ip.util";

const SECRET = "bff-shared-secret";
const req = (headers: Record<string, string | string[]>, ip = "10.0.0.9") => ({
  ip,
  headers,
});

describe("getClientIp", () => {
  it("uses X-Client-IP with a valid key", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET, "x-client-ip": "203.0.113.7" }),
        SECRET,
      ),
    ).toBe("203.0.113.7");
  });

  it("accepts IPv6", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET, "x-client-ip": "2001:db8::1" }),
        SECRET,
      ),
    ).toBe("2001:db8::1");
  });

  it("ignores X-Client-IP without the key", () => {
    expect(getClientIp(req({ "x-client-ip": "203.0.113.7" }), SECRET)).toBe(
      "10.0.0.9",
    );
  });

  it("ignores X-Client-IP with a wrong key", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": "nope", "x-client-ip": "203.0.113.7" }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
  });

  it("does not match a key of different length (even a prefix)", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET.slice(0, -1), "x-client-ip": "203.0.113.7" }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
    expect(
      getClientIp(
        req({ "x-bff-key": `${SECRET}x`, "x-client-ip": "203.0.113.7" }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
  });

  it("falls back to req.ip when X-Client-IP is not a valid IP", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET, "x-client-ip": "not-an-ip" }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET, "x-client-ip": "1.2.3.4, 5.6.7.8" }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
  });

  it("never trusts headers when no secret is configured", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": "", "x-client-ip": "203.0.113.7" }),
        undefined,
      ),
    ).toBe("10.0.0.9");
    expect(
      getClientIp(req({ "x-bff-key": "", "x-client-ip": "203.0.113.7" }), ""),
    ).toBe("10.0.0.9");
  });

  it("ignores repeated (array) headers", () => {
    expect(
      getClientIp(
        req({ "x-bff-key": SECRET, "x-client-ip": ["203.0.113.7", "1.1.1.1"] }),
        SECRET,
      ),
    ).toBe("10.0.0.9");
  });

  it("returns an empty string when there is no ip at all", () => {
    expect(getClientIp({ headers: {} }, SECRET)).toBe("");
  });
});
