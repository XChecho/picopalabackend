import { corsOriginResolver, parseCorsOrigins } from "./cors.util";

describe("cors.util", () => {
  const original = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (original === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = original;
  });

  describe("parseCorsOrigins", () => {
    it("splits, trims and drops empty entries", () => {
      expect(parseCorsOrigins(" https://a.com , ,https://b.com,, ")).toEqual([
        "https://a.com",
        "https://b.com",
      ]);
    });

    it.each([undefined, "", "  ", " , "])(
      "falls back to the local default for %p",
      (raw) => {
        expect(parseCorsOrigins(raw)).toEqual(["http://localhost:8081"]);
      },
    );

    it("returns a fresh array for the default so callers cannot mutate it", () => {
      parseCorsOrigins("").push("http://evil.com");
      expect(parseCorsOrigins("")).toEqual(["http://localhost:8081"]);
    });

    it("reads process.env.CORS_ORIGIN when no argument is passed", () => {
      process.env.CORS_ORIGIN = "https://x.com";
      expect(parseCorsOrigins()).toEqual(["https://x.com"]);
    });
  });

  describe("corsOriginResolver", () => {
    const resolve = (origin: string | undefined) => {
      const cb = jest.fn();
      corsOriginResolver(origin, cb);
      return cb;
    };

    it("allows requests without Origin (native clients)", () => {
      expect(resolve(undefined)).toHaveBeenCalledWith(null, true);
    });

    it("allows listed origins and rejects the rest", () => {
      process.env.CORS_ORIGIN = "https://a.com,https://b.com";
      expect(resolve("https://b.com")).toHaveBeenCalledWith(null, true);
      expect(resolve("https://evil.com")).toHaveBeenCalledWith(null, false);
    });

    it("allows everything with a wildcard", () => {
      process.env.CORS_ORIGIN = "*";
      expect(resolve("https://anything.com")).toHaveBeenCalledWith(null, true);
    });

    it("evaluates the variable lazily on each request", () => {
      process.env.CORS_ORIGIN = "https://a.com";
      expect(resolve("https://b.com")).toHaveBeenCalledWith(null, false);
      process.env.CORS_ORIGIN = "https://b.com";
      expect(resolve("https://b.com")).toHaveBeenCalledWith(null, true);
    });
  });
});
