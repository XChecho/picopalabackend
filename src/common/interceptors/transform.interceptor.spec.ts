import { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { TransformInterceptor } from "./transform.interceptor";

const makeContext = (type: string, statusCode = 201): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  }) as unknown as ExecutionContext;

describe("TransformInterceptor", () => {
  const interceptor = new TransformInterceptor<{ a: number }>();

  it("wraps http responses with status code and timestamp", async () => {
    const handler: CallHandler = { handle: () => of({ a: 1 }) };

    const result = await lastValueFrom(
      interceptor.intercept(makeContext("http"), handler),
    );

    expect(result.data).toEqual({ a: 1 });
    expect(result.statusCode).toBe(201);
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it("leaves non-http payloads untouched", async () => {
    const payload = { a: 2 };
    const handler: CallHandler = { handle: () => of(payload) };

    const result = await lastValueFrom(
      interceptor.intercept(makeContext("ws"), handler),
    );

    expect(result).toBe(payload);
  });
});
