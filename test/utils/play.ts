import { INestApplication } from "@nestjs/common";
import { API, ITestUser, bearer, http } from "./helpers";
import { Solver } from "./solver";

export interface IMoveResult {
  guess: string;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supertest response bodies are untyped
  body: any;
}

export interface IPlayOutcome {
  matchId: string;
  moves: IMoveResult[];
  /** Every HTTP body seen while playing (create + moves), for leak scanning. */
  bodies: unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supertest response bodies are untyped
  finalBody: any;
  won: boolean;
}

export async function createAiMatch(
  app: INestApplication,
  user: ITestUser,
  body: Record<string, unknown> = { mode: "VERSUS_AI", maxTurns: 20 },
) {
  return http(app)
    .post(`${API}/match`)
    .set(bearer(user.accessToken))
    .send(body);
}

export function submitMove(
  app: INestApplication,
  user: ITestUser,
  matchId: string,
  guess: unknown,
) {
  return http(app)
    .post(`${API}/match/${matchId}/move`)
    .set(bearer(user.accessToken))
    .send({ guess });
}

/** Plays an already created match with the feedback-driven solver until it finishes. */
export async function playMatch(
  app: INestApplication,
  user: ITestUser,
  matchId: string,
  bodies: unknown[] = [],
): Promise<IPlayOutcome> {
  const solver = new Solver();
  const moves: IMoveResult[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supertest response bodies are untyped
  let finalBody: any = null;

  for (let turn = 0; turn < 25; turn++) {
    const guess = solver.next();
    const res = await submitMove(app, user, matchId, guess);
    moves.push({ guess, status: res.status, body: res.body });
    bodies.push(res.body);
    if (res.status !== 201) {
      throw new Error(`move failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const data = res.body.data;
    solver.observe(guess, { picos: data.move.picos, palas: data.move.palas });
    if (data.matchStatus === "FINISHED") {
      finalBody = data;
      break;
    }
  }

  if (!finalBody) throw new Error("match did not finish");
  return {
    matchId,
    moves,
    bodies,
    finalBody,
    won: finalBody.winnerId === user.id,
  };
}

/**
 * The AI plays random guesses (EASY), so with ~1/3000 odds per turn it can
 * win first. Retry with a fresh match to keep the suite deterministic.
 */
export async function playAiUntilWin(
  app: INestApplication,
  user: ITestUser,
  maxAttempts = 5,
): Promise<IPlayOutcome> {
  for (let i = 0; i < maxAttempts; i++) {
    const created = await createAiMatch(app, user);
    if (created.status !== 201) {
      throw new Error(
        `create failed: ${created.status} ${JSON.stringify(created.body)}`,
      );
    }
    const outcome = await playMatch(app, user, created.body.data.id, [
      created.body,
    ]);
    if (outcome.won) return outcome;
  }
  throw new Error("AI beat the solver too many times");
}

/**
 * Walks a JSON body and fails if `secret` shows up anywhere other than in a
 * `guess` field (the winning guess equals the rival's secret by definition),
 * or if any secret-bearing key of the rival is present.
 */
export function assertNoSecretLeak(
  body: unknown,
  secret: string,
  forbiddenKeys: string[] = [],
): void {
  const visit = (node: unknown, path: string, key: string): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, key));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "secretNumber" || forbiddenKeys.includes(k)) {
          throw new Error(`forbidden key "${k}" at ${path}`);
        }
        visit(v, `${path}.${k}`, k);
      }
      return;
    }
    if (String(node) === secret && key !== "guess") {
      throw new Error(`secret ${secret} leaked at ${path}`);
    }
  };
  visit(body, "$", "");
}
