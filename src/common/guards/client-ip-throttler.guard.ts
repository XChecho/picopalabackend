import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getClientIp, IClientIpRequest } from '../utils/client-ip.util';

/**
 * Throttler keyed on the real client IP when the request comes from the trusted web BFF.
 * Non-HTTP contexts (WebSocket gateways) have no `headers` on the request object, so they
 * fall back to the stock tracker instead of reading attacker-controlled data.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    if (!req || typeof req.headers !== 'object' || req.headers === null) {
      return super.getTracker(req);
    }
    return getClientIp(req as IClientIpRequest) || super.getTracker(req);
  }
}
