/**
 * Test environment. Loaded through jest `setupFiles` before every suite.
 * Values are forced (not defaulted) so nothing from the shell or the project's
 * .env can redirect the tests to another database.
 */
export const TEST_DATABASE_URL =
  "postgresql://postgres:test@localhost:54340/pp_e2e?schema=public";
export const TEST_REDIS_PORT = 63990;

const forced: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL,
  DIRECT_URL: TEST_DATABASE_URL,
  NODE_ENV: "test",
  JWT_SECRET: "e2e-access-secret-0123456789abcdef-0123456789",
  JWT_REFRESH_SECRET: "e2e-refresh-secret-fedcba9876543210-9876543210",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  THROTTLE_TTL: "60000",
  THROTTLE_LIMIT: "100000",
  CORS_ORIGIN: "http://localhost:8081",
  CONTACT_IP_SALT: "e2e-contact-salt",
  BFF_SHARED_SECRET: "e2e-bff-shared-secret-0123456789",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: String(TEST_REDIS_PORT),
  REDIS_PASSWORD: "",
  CLOUDINARY_CLOUD_NAME: "e2e",
  CLOUDINARY_API_KEY: "e2e",
  CLOUDINARY_API_SECRET: "e2e",
  PORT: "0",
  APP_STORE_URL: "",
  PLAY_STORE_URL: "",
  APP_VERSION: "",
  APP_MIN_VERSION: "",
};

Object.assign(process.env, forced);
// Never verify against Cloudflare in tests (the fake CaptchaService is also injected).
delete process.env.TURNSTILE_SECRET_KEY;

if (!/@localhost:54340\//.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("E2E tests must only run against localhost:54340");
}
