import { validateEnv } from "./env.validation";

const LONG_A = "a".repeat(32);
const LONG_B = "b".repeat(32);

const base = (): Record<string, unknown> => ({
  DATABASE_URL: "postgres://localhost/db",
  JWT_SECRET: "secret-one",
  JWT_REFRESH_SECRET: "secret-two",
});

const prod = (overrides: Record<string, unknown> = {}) => ({
  ...base(),
  NODE_ENV: "production",
  JWT_SECRET: LONG_A,
  JWT_REFRESH_SECRET: LONG_B,
  CONTACT_IP_SALT: "salt",
  CORS_ORIGIN: "https://picopala.com",
  ...overrides,
});

describe("validateEnv", () => {
  it("returns the config untouched when valid in development", () => {
    const config = base();
    expect(validateEnv(config)).toBe(config);
  });

  it.each(["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"])(
    "fails when %s is missing",
    (key) => {
      const config = base();
      delete config[key];
      expect(() => validateEnv(config)).toThrow(
        `Missing required environment variables: ${key}`,
      );
    },
  );

  it("lists every missing variable at once", () => {
    expect(() => validateEnv({})).toThrow(
      "Missing required environment variables: DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET",
    );
  });

  it("treats empty strings as missing", () => {
    expect(() => validateEnv({ ...base(), JWT_SECRET: "" })).toThrow(
      /JWT_SECRET/,
    );
  });

  it("rejects identical access and refresh secrets", () => {
    expect(() =>
      validateEnv({
        ...base(),
        JWT_SECRET: "same",
        JWT_REFRESH_SECRET: "same",
      }),
    ).toThrow("JWT_SECRET and JWT_REFRESH_SECRET must be different");
  });

  describe("production", () => {
    it("accepts a fully configured environment", () => {
      expect(() => validateEnv(prod())).not.toThrow();
    });

    it("accepts secrets of exactly 32 characters", () => {
      expect(() => validateEnv(prod())).not.toThrow();
    });

    it("rejects a short JWT_SECRET", () => {
      expect(() => validateEnv(prod({ JWT_SECRET: "short" }))).toThrow(
        "JWT_SECRET must be at least 32 characters in production",
      );
    });

    it("reports both secrets when both are short", () => {
      expect(() =>
        validateEnv(prod({ JWT_SECRET: "a", JWT_REFRESH_SECRET: "b" })),
      ).toThrow(
        "JWT_SECRET, JWT_REFRESH_SECRET must be at least 32 characters in production",
      );
    });

    it("requires CONTACT_IP_SALT", () => {
      expect(() => validateEnv(prod({ CONTACT_IP_SALT: undefined }))).toThrow(
        "CONTACT_IP_SALT is required in production",
      );
    });

    it("requires CORS_ORIGIN", () => {
      expect(() => validateEnv(prod({ CORS_ORIGIN: "" }))).toThrow(
        "CORS_ORIGIN is required in production",
      );
    });

    it("does not enforce production rules in other environments", () => {
      expect(() =>
        validateEnv({ ...base(), NODE_ENV: "development" }),
      ).not.toThrow();
    });
  });
});
