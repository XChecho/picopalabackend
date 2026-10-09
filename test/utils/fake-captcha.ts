import { ForbiddenException, Injectable } from "@nestjs/common";

export const OK_CAPTCHA = "ok-token";
export const BAD_CAPTCHA = "bad-token";

/** Stand-in for CaptchaService: never touches the network. */
@Injectable()
export class FakeCaptchaService {
  readonly calls: Array<{ token: string | undefined; remoteIp?: string }> = [];

  async verify(token: string | undefined, remoteIp?: string): Promise<void> {
    this.calls.push({ token, remoteIp });
    if (token !== OK_CAPTCHA) {
      throw new ForbiddenException("Captcha verification failed");
    }
  }
}
