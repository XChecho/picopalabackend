import "./utils/redis-down-env"; // must stay first: AppModule snapshots env on import
import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./utils/app";
import {
  API,
  bearer,
  createDb,
  http,
  registerUser,
  truncateAll,
} from "./utils/helpers";

const join = (app: INestApplication, user: { accessToken: string }) =>
  http(app)
    .post(`${API}/room/global/join`)
    .set(bearer(user.accessToken))
    .send({ maxTurns: 20 });

describe("Global matchmaking without Redis (e2e)", () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createDb();
    await truncateAll(db);
    // Port with nothing listening: Redis is "down" for this app instance only.
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it("answers 503 with a generic message when Redis is unavailable (join and leave)", async () => {
    const user = await registerUser(app);

    const joined = await join(app, user);
    expect(joined.status).toBe(503);
    expect(joined.body.message).toBe("Matchmaking is unavailable");
    expect(joined.body.stack).toBeUndefined();
    expect(joined.text).not.toMatch(/ECONNREFUSED|63999|127\.0\.0\.1/);

    const left = await http(app)
      .delete(`${API}/room/global/leave`)
      .set(bearer(user.accessToken));
    expect(left.status).toBe(503);
  });

  it("keeps the rest of the API working", async () => {
    const user = await registerUser(app);
    const me = await http(app)
      .get(`${API}/player/me`)
      .set(bearer(user.accessToken));
    expect(me.status).toBe(200);
    expect((await http(app).get(`${API}/health`)).status).toBe(200);
  });

  it("requires authentication", async () => {
    expect(
      (await http(app).post(`${API}/room/global/join`).send({})).status,
    ).toBe(401);
  });
});
