import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { RoomStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MatchService } from "./match.service";
import { DISCONNECT_GRACE_MS, SCHEDULER_INTERVAL_MS } from "./match.constants";

/**
 * Resolves expired server clocks (secret selection, turns, disconnects, rooms).
 * All state lives in the database, so a restart or a page reload never
 * resets a clock. Assumes a single backend instance; concurrent resolution is
 * still safe because every transition is claimed atomically.
 */
@Injectable()
export class MatchSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly matchService: MatchService,
    private readonly prismaService: PrismaService,
  ) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === "test") return;
    // Opt out on extra replicas: only one instance should run the clocks.
    if (process.env.SCHEDULER_ENABLED === "false") return;
    try {
      await this.matchService.resetClocksAfterRestart();
    } catch (error) {
      this.logger.error(`Clock reset failed: ${(error as Error).message}`);
    }
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; overlapping passes are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Each phase is isolated so one failing phase never starves the rest.
      await this.phase("setup", () =>
        this.resolveAll(
          () => this.matchService.findDueMatchIds("WAITING"),
          (id) => this.matchService.completeSetup(id),
          "setup",
        ),
      );
      await this.phase("turns", () =>
        this.resolveAll(
          () => this.matchService.findDueMatchIds("PLAYING"),
          (id) => this.matchService.autoPlayTurn(id),
          "turn",
        ),
      );
      await this.phase("abandoned", () => this.forfeitAbandoned());
      await this.phase("rooms", () => this.expireRooms());
    } finally {
      this.running = false;
    }
  }

  private async phase(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Scheduler ${name} phase failed: ${(error as Error).message}`,
      );
    }
  }

  private async resolveAll(
    find: () => Promise<string[]>,
    resolve: (matchId: string) => Promise<boolean>,
    label: string,
  ): Promise<void> {
    for (const matchId of await find()) {
      try {
        await resolve(matchId);
      } catch (error) {
        this.logger.warn(
          `Could not resolve ${label} of match ${matchId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async forfeitAbandoned(): Promise<void> {
    const abandoned =
      await this.matchService.findAbandonedPlayers(DISCONNECT_GRACE_MS);
    for (const { matchId, playerId } of abandoned) {
      try {
        await this.matchService.resolveAbandoned(matchId, playerId);
      } catch (error) {
        this.logger.warn(
          `Could not forfeit match ${matchId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async expireRooms(): Promise<void> {
    await this.prismaService.room.updateMany({
      where: { status: RoomStatus.WAITING, expiresAt: { lte: new Date() } },
      data: { status: RoomStatus.EXPIRED },
    });
  }
}
