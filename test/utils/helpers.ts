import { INestApplication } from "@nestjs/common";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import * as request from "supertest";
import { TEST_DATABASE_URL } from "./env";

export const API = "/api/v1";
export const PASSWORD = "Sup3rSecret!";
export const BFF_KEY = "e2e-bff-shared-secret-0123456789";

let ipCounter = 0;

/**
 * Unique client IP per call. The app runs with `trust proxy 1`, so the throttler
 * keys on X-Forwarded-For; this keeps per-route limits (5/min register...) from
 * colliding across tests. Rate-limit tests pass a fixed IP on purpose.
 */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface ITestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export function http(app: INestApplication) {
  const address = app.getHttpServer().address() as AddressInfo;
  return request(`http://127.0.0.1:${address.port}`);
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

let userSeq = 0;

export function uniqueName(prefix = "user"): string {
  userSeq += 1;
  // Alphanumeric, <= 20 chars.
  return `${prefix}${Date.now().toString(36)}${userSeq}`.slice(0, 20);
}

export async function registerUser(
  app: INestApplication,
  overrides: Partial<{
    username: string;
    email: string;
    password: string;
  }> = {},
): Promise<ITestUser> {
  const username = overrides.username ?? uniqueName();
  const email = overrides.email ?? `${username.toLowerCase()}@example.com`;
  const password = overrides.password ?? PASSWORD;

  const res = await http(app)
    .post(`${API}/web/auth/register`)
    .set("X-Forwarded-For", freshIp())
    .send({ username, email, password, captchaToken: "ok-token" });

  if (res.status !== 201) {
    throw new Error(
      `registerUser failed: ${res.status} ${JSON.stringify(res.body)} ${res.text} ${JSON.stringify(res.headers)}`,
    );
  }
  return {
    id: res.body.data.player.id,
    username,
    email,
    password,
    accessToken: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
  };
}

export async function loginUser(
  app: INestApplication,
  username: string,
  password = PASSWORD,
) {
  return http(app)
    .post(`${API}/web/auth/login`)
    .set("X-Forwarded-For", freshIp())
    .send({ username, password });
}

/** Direct DB access for fixtures/cleanup. Always points at the disposable test DB. */
export function createDb(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
}

export async function truncateAll(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Serialized JSON search used to prove secrets never leak. */
export function containsText(body: unknown, needle: string): boolean {
  return JSON.stringify(body).includes(needle);
}
