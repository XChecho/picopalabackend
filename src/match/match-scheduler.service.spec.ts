import { Logger } from "@nestjs/common";
import { RoomStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MatchSchedulerService } from "./match-scheduler.service";
import { MatchService } from "./match.service";

describe("MatchSchedulerService", () => {
  let scheduler: MatchSchedulerService;
  let matches: {
    findDueMatchIds: jest.Mock;
    completeSetup: jest.Mock;
    autoPlayTurn: jest.Mock;
    findAbandonedPlayers: jest.Mock;
    resolveAbandoned: jest.Mock;
  };
  let prisma: { room: { updateMany: jest.Mock } };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    matches = {
      findDueMatchIds: jest.fn().mockResolvedValue([]),
      completeSetup: jest.fn().mockResolvedValue(true),
      autoPlayTurn: jest.fn().mockResolvedValue(true),
      findAbandonedPlayers: jest.fn().mockResolvedValue([]),
      resolveAbandoned: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      room: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    scheduler = new MatchSchedulerService(
      matches as unknown as MatchService,
      prisma as unknown as PrismaService,
    );
  });

  it("resolves due setups, due turns, abandoned players and stale rooms", async () => {
    matches.findDueMatchIds.mockImplementation(async (status: string) =>
      status === "WAITING" ? ["w1"] : ["p1", "p2"],
    );
    matches.findAbandonedPlayers.mockResolvedValue([
      { matchId: "m9", playerId: "gone" },
    ]);

    await scheduler.tick();

    expect(matches.completeSetup).toHaveBeenCalledWith("w1");
    expect(matches.autoPlayTurn.mock.calls).toEqual([["p1"], ["p2"]]);
    expect(matches.resolveAbandoned).toHaveBeenCalledWith("m9", "gone");
    expect(prisma.room.updateMany).toHaveBeenCalledWith({
      where: {
        status: RoomStatus.WAITING,
        expiresAt: { lte: expect.any(Date) },
      },
      data: { status: RoomStatus.EXPIRED },
    });
  });

  it("keeps going when one match fails to resolve", async () => {
    matches.findDueMatchIds.mockImplementation(async (status: string) =>
      status === "PLAYING" ? ["bad", "good"] : [],
    );
    matches.autoPlayTurn.mockRejectedValueOnce(new Error("boom"));

    await scheduler.tick();

    expect(matches.autoPlayTurn).toHaveBeenCalledTimes(2);
  });

  it("skips a pass while the previous one is still running", async () => {
    let release: () => void = () => undefined;
    matches.findDueMatchIds.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (release = () => resolve([]))),
    );

    const first = scheduler.tick();
    await scheduler.tick();
    expect(matches.findDueMatchIds).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it("still resolves abandoned players and rooms when the turn phase fails", async () => {
    matches.findDueMatchIds.mockRejectedValue(new Error("db down"));
    matches.findAbandonedPlayers.mockResolvedValue([
      { matchId: "m9", playerId: "gone" },
    ]);

    await scheduler.tick();

    expect(matches.resolveAbandoned).toHaveBeenCalledWith("m9", "gone");
    expect(prisma.room.updateMany).toHaveBeenCalled();
  });
});
