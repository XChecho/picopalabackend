import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 3000;

interface ITurnstileResponse {
  success?: unknown;
  "error-codes"?: unknown;
}

@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);
  private devWarned = false;

  constructor(private readonly configService: ConfigService) {}

  /** Resolves when the token is valid; throws 403 if rejected, 503 if it cannot be verified. */
  async verify(token: string | undefined, remoteIp?: string): Promise<void> {
    const secret = this.configService.get<string>("TURNSTILE_SECRET_KEY");

    if (!secret) {
      if (this.configService.get<string>("NODE_ENV") !== "production") {
        if (!this.devWarned) {
          this.devWarned = true;
          this.logger.warn(
            "TURNSTILE_SECRET_KEY is not set: captcha verification is DISABLED (development mode)",
          );
        }
        return;
      }
      this.logger.error("TURNSTILE_SECRET_KEY is missing in production");
      throw this.unavailable();
    }

    if (!token) {
      throw this.failed();
    }

    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) {
      body.set("remoteip", remoteIp);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let result: ITurnstileResponse;
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.error(`Turnstile siteverify answered HTTP ${res.status}`);
        throw this.unavailable();
      }
      result = (await res.json()) as ITurnstileResponse;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Turnstile siteverify failed: ${reason}`);
      throw this.unavailable();
    } finally {
      clearTimeout(timer);
    }

    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.success !== "boolean"
    ) {
      this.logger.error("Turnstile siteverify returned an invalid payload");
      throw this.unavailable();
    }
    if (!result.success) {
      this.logger.warn(
        `Turnstile rejected token: ${JSON.stringify(result["error-codes"] ?? [])}`,
      );
      throw this.failed();
    }
  }

  private failed(): ForbiddenException {
    return new ForbiddenException("Captcha verification failed");
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException("Captcha unavailable");
  }
}
