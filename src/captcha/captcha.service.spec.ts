import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CaptchaService } from "./captcha.service";

const URL_ = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const build = (env: Record<string, string | undefined>) =>
  new CaptchaService({
    get: (k: string) => env[k],
  } as unknown as ConfigService);

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe("CaptchaService", () => {
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  const original = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = original;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("posts secret, response and remoteip as urlencoded and resolves on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await expect(
      build({ TURNSTILE_SECRET_KEY: "sec" }).verify("tok", "1.2.3.4"),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(init.body);
    expect(params.get("secret")).toBe("sec");
    expect(params.get("response")).toBe("tok");
    expect(params.get("remoteip")).toBe("1.2.3.4");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits remoteip when unknown", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await build({ TURNSTILE_SECRET_KEY: "sec" }).verify("tok");
    expect(
      new URLSearchParams(fetchMock.mock.calls[0][1].body).has("remoteip"),
    ).toBe(false);
  });

  it("throws 403 when Turnstile rejects the token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    );
    const err = await build({ TURNSTILE_SECRET_KEY: "sec" })
      .verify("bad")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Captcha verification failed");
  });

  it("throws 403 without calling Turnstile when the token is missing", async () => {
    await expect(
      build({ TURNSTILE_SECRET_KEY: "sec" }).verify(undefined),
    ).rejects.toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed with a generic 503 on network errors (no internals leaked)", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:443"));
    const err = await build({ TURNSTILE_SECRET_KEY: "sec" })
      .verify("tok")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe("Captcha unavailable");
    expect(JSON.stringify(err.getResponse())).not.toContain("ECONNREFUSED");
  });

  it.each([
    ["non-2xx", jsonResponse({}, 500)],
    ["missing success flag", jsonResponse({ foo: 1 })],
    ["null body", jsonResponse(null)],
  ])("fails closed with 503 on %s", async (_l, res) => {
    fetchMock.mockResolvedValue(res);
    await expect(
      build({ TURNSTILE_SECRET_KEY: "sec" }).verify("tok"),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("fails closed with 503 on invalid JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    await expect(
      build({ TURNSTILE_SECRET_KEY: "sec" }).verify("tok"),
    ).rejects.toThrow("Captcha unavailable");
  });

  it("aborts after 3 seconds and answers 503", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(new Error("aborted")),
          );
        }),
    );
    const promise = build({ TURNSTILE_SECRET_KEY: "sec" })
      .verify("tok")
      .catch((e) => e);
    await jest.advanceTimersByTimeAsync(2999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    const err = await promise;
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe("Captcha unavailable");
  });

  it("accepts without a secret outside production and warns only once", async () => {
    const service = build({ NODE_ENV: "development" });
    await service.verify(undefined);
    await service.verify("anything");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts without a secret when NODE_ENV is unset", async () => {
    await expect(build({}).verify("x")).resolves.toBeUndefined();
  });

  it("rejects with 503 without a secret in production", async () => {
    await expect(
      build({ NODE_ENV: "production" }).verify("tok"),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
