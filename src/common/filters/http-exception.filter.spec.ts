import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";

const makeHost = (type: string) => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
};

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it("does not leak the message of unexpected errors (500)", () => {
    const { host, status, json } = makeHost("http");

    filter.catch(
      new Error(
        'Invalid `prisma.player.findMany()` invocation: column "passwordHash"',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toMatch(/prisma|passwordHash/);
    expect(body).not.toHaveProperty("stack");
  });

  it("maps exposed client http-errors (body-parser 413) without leaking details", () => {
    const { host, status, json } = makeHost("http");
    const error = Object.assign(new Error("request entity too large"), {
      status: 413,
      expose: true,
    });

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(json.mock.calls[0][0].message).toBe("Payload too large");
  });

  it("maps malformed JSON parser errors to a generic 400", () => {
    const { host, status, json } = makeHost("http");
    const error = Object.assign(
      new SyntaxError("Expected double-quoted property name"),
      {
        status: 400,
        expose: true,
      },
    );

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json.mock.calls[0][0].message).toBe("Bad request");
  });

  it("does not trust a 4xx status on errors that are not exposed", () => {
    const { host, status } = makeHost("http");
    const error = Object.assign(new Error("internal"), {
      status: 418,
      expose: false,
    });

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("handles non-Error throwables as 500 with the generic message", () => {
    const { host, status, json } = makeHost("http");

    filter.catch("a string was thrown", host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).toBe("Internal server error");
  });

  it("keeps status and message of HttpException with a string body", () => {
    const { host, status, json } = makeHost("http");

    filter.catch(new HttpException("Teapot", 418), host);

    expect(status).toHaveBeenCalledWith(418);
    expect(json.mock.calls[0][0]).toMatchObject({
      statusCode: 418,
      message: "Teapot",
    });
  });

  it("keeps the message of object bodies and ISO timestamp", () => {
    const { host, status, json } = makeHost("http");

    filter.catch(new ForbiddenException("Not your turn"), host);

    expect(status).toHaveBeenCalledWith(403);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe("Not your turn");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("passes through validation message arrays and errors maps", () => {
    const { host, json } = makeHost("http");

    filter.catch(
      new BadRequestException({
        message: ["email must be an email"],
        errors: { email: ["invalid"] },
      }),
      host,
    );

    const body = json.mock.calls[0][0];
    expect(body.message).toEqual(["email must be an email"]);
    expect(body.errors).toEqual({ email: ["invalid"] });
  });

  it("omits errors when the exception has none", () => {
    const { host, json } = makeHost("http");
    filter.catch(new BadRequestException("bad"), host);
    expect(json.mock.calls[0][0]).not.toHaveProperty("errors");
  });

  it("rethrows for non-http contexts (websockets)", () => {
    const { host, status } = makeHost("ws");
    const error = new Error("ws failure");

    expect(() => filter.catch(error, host)).toThrow(error);
    expect(status).not.toHaveBeenCalled();
  });

  it("rethrows non-Error values for non-http contexts", () => {
    const { host } = makeHost("ws");
    expect(() => filter.catch("oops", host)).toThrow();
  });
});
