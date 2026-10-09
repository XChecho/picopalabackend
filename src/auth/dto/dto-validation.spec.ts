import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdatePlayerDto } from "../../player/dto/update-player.dto";
import { WaitlistDto } from "../../public/dto/waitlist.dto";
import { ContactDto } from "../../public/dto/contact.dto";
import { LeaderboardQueryDto } from "../../public/dto/leaderboard-query.dto";
import { UsernameParamDto } from "../../public/dto/username-param.dto";
import { SubmitMoveDto } from "../../match/dto/submit-move.dto";
import { JoinRoomDto } from "../../room/dto/join-room.dto";
import { SyncStatsDto } from "../../stats/dto/sync-stats.dto";
import { MobileLoginDto } from "./mobile-login.dto";
import { MobileRegisterDto } from "./mobile-register.dto";
import { WebLoginDto } from "./web-login.dto";
import { WebRegisterDto } from "./web-register.dto";

type Ctor<T> = new () => T;

const check = async <T extends object>(
  cls: Ctor<T>,
  plain: Record<string, unknown>,
): Promise<{ instance: T; failed: string[] }> => {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, failed: errors.map((e) => e.property).sort() };
};

const validRegister = {
  username: "Alice99",
  email: "alice@example.com",
  password: "password123",
  captchaToken: "tok",
};

describe("WebRegisterDto", () => {
  it("accepts a valid payload", async () => {
    expect((await check(WebRegisterDto, validRegister)).failed).toEqual([]);
  });

  it("trims and lowercases the email", async () => {
    const { instance, failed } = await check(WebRegisterDto, {
      ...validRegister,
      email: "  Alice@Example.COM ",
    });
    expect(failed).toEqual([]);
    expect(instance.email).toBe("alice@example.com");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(21)],
    ["with underscore", "ali_ce"],
    ["with space", "ali ce"],
    ["with accents", "álice"],
  ])("rejects a username %s", async (_label, username) => {
    expect(
      (await check(WebRegisterDto, { ...validRegister, username })).failed,
    ).toEqual(["username"]);
  });

  it.each([3, 20])("accepts a username of %i characters", async (len) => {
    expect(
      (
        await check(WebRegisterDto, {
          ...validRegister,
          username: "a".repeat(len),
        })
      ).failed,
    ).toEqual([]);
  });

  it.each([
    ["7 chars", "a".repeat(7)],
    ["73 chars", "a".repeat(73)],
  ])("rejects a password with %s", async (_label, password) => {
    expect(
      (await check(WebRegisterDto, { ...validRegister, password })).failed,
    ).toEqual(["password"]);
  });

  it.each([8, 72])("accepts a password of %i characters", async (len) => {
    expect(
      (
        await check(WebRegisterDto, {
          ...validRegister,
          password: "a".repeat(len),
        })
      ).failed,
    ).toEqual([]);
  });

  it("rejects invalid emails and language", async () => {
    expect(
      (
        await check(WebRegisterDto, {
          ...validRegister,
          email: "nope",
          language: "fr",
        })
      ).failed,
    ).toEqual(["email", "language"]);
  });

  it.each(["WEB", "IOS"])(
    "rejects a client-declared platform %s",
    async (platform) => {
      expect(
        (await check(WebRegisterDto, { ...validRegister, platform })).failed,
      ).toEqual(["platform"]);
    },
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too long", "t".repeat(2049)],
    ["not a string", 42],
  ])("rejects a %s captchaToken", async (_label, captchaToken) => {
    expect(
      (await check(WebRegisterDto, { ...validRegister, captchaToken })).failed,
    ).toEqual(["captchaToken"]);
  });

  it("accepts a captchaToken of 2048 characters", async () => {
    expect(
      (
        await check(WebRegisterDto, {
          ...validRegister,
          captchaToken: "t".repeat(2048),
        })
      ).failed,
    ).toEqual([]);
  });

  it("rejects non-whitelisted properties such as elo or role", async () => {
    expect(
      (await check(WebRegisterDto, { ...validRegister, elo: 3000 })).failed,
    ).toEqual(["elo"]);
  });

  it("does not crash on a non-string email", async () => {
    expect(
      (await check(WebRegisterDto, { ...validRegister, email: 123 })).failed,
    ).toEqual(["email"]);
  });
});

describe("WebLoginDto", () => {
  it("accepts valid credentials", async () => {
    expect(
      (await check(WebLoginDto, { username: "alice", password: "password123" }))
        .failed,
    ).toEqual([]);
  });

  it("rejects short usernames and out-of-range passwords", async () => {
    expect(
      (await check(WebLoginDto, { username: "al", password: "short" })).failed,
    ).toEqual(["password", "username"]);
    expect(
      (
        await check(WebLoginDto, {
          username: "alice",
          password: "a".repeat(73),
        })
      ).failed,
    ).toEqual(["password"]);
  });
});

describe("WebLoginDto platform", () => {
  it("rejects a platform field", async () => {
    expect(
      (
        await check(WebLoginDto, {
          username: "alice",
          password: "password123",
          platform: "WEB",
        })
      ).failed,
    ).toEqual(["platform"]);
  });
});

describe("Mobile auth DTOs", () => {
  const { captchaToken: _omit, ...mobileRegister } = validRegister;
  void _omit;

  it.each(["IOS", "ANDROID"])("accepts platform %s", async (platform) => {
    expect(
      (await check(MobileRegisterDto, { ...mobileRegister, platform })).failed,
    ).toEqual([]);
    expect(
      (
        await check(MobileLoginDto, {
          username: "alice",
          password: "password123",
          platform,
        })
      ).failed,
    ).toEqual([]);
  });

  it.each(["WEB", "ios", "WINDOWS", undefined])(
    "rejects platform %p",
    async (platform) => {
      expect(
        (await check(MobileRegisterDto, { ...mobileRegister, platform }))
          .failed,
      ).toEqual(["platform"]);
      expect(
        (
          await check(MobileLoginDto, {
            username: "alice",
            password: "password123",
            platform,
          })
        ).failed,
      ).toEqual(["platform"]);
    },
  );

  it("does not accept a captchaToken and keeps the shared rules", async () => {
    expect(
      (
        await check(MobileRegisterDto, {
          ...mobileRegister,
          platform: "IOS",
          captchaToken: "x",
          username: "a_b",
        })
      ).failed,
    ).toEqual(["captchaToken", "username"]);
    expect(
      (
        await check(MobileRegisterDto, {
          ...mobileRegister,
          platform: "ANDROID",
          email: " Bob@Example.COM ",
        })
      ).instance.email,
    ).toBe("bob@example.com");
  });
});

describe("UpdatePlayerDto", () => {
  it("accepts an empty payload (all fields optional)", async () => {
    expect((await check(UpdatePlayerDto, {})).failed).toEqual([]);
  });

  it("accepts a Cloudinary https avatar", async () => {
    expect(
      (
        await check(UpdatePlayerDto, {
          avatar: "https://res.cloudinary.com/demo/image/upload/a.png",
        })
      ).failed,
    ).toEqual([]);
  });

  it.each([
    "http://res.cloudinary.com/demo/a.png",
    "https://evil.com/a.png",
    "https://res.cloudinary.com.evil.com/a.png",
    "https://evil.com/res.cloudinary.com/a.png",
    "javascript:alert(1)",
    "res.cloudinary.com/a.png",
    "not a url",
  ])("rejects the avatar %s", async (avatar) => {
    expect((await check(UpdatePlayerDto, { avatar })).failed).toEqual([
      "avatar",
    ]);
  });

  it("rejects avatars longer than 2048 characters", async () => {
    const avatar = `https://res.cloudinary.com/${"a".repeat(2048)}`;
    expect((await check(UpdatePlayerDto, { avatar })).failed).toEqual([
      "avatar",
    ]);
  });

  it("applies the same username and language rules as register", async () => {
    expect(
      (await check(UpdatePlayerDto, { username: "a_b", language: "xx" }))
        .failed,
    ).toEqual(["language", "username"]);
  });
});

describe("SubmitMoveDto", () => {
  it.each(["1234", "9876"])("accepts %s", async (guess) => {
    expect((await check(SubmitMoveDto, { guess })).failed).toEqual([]);
  });

  it.each(["123", "12345", "1230", "abcd", ""])("rejects %p", async (guess) => {
    expect((await check(SubmitMoveDto, { guess })).failed).toEqual(["guess"]);
  });
});

describe("JoinRoomDto", () => {
  it("trims and uppercases the room code", async () => {
    const { instance, failed } = await check(JoinRoomDto, { code: " ab12cd " });
    expect(failed).toEqual([]);
    expect(instance.code).toBe("AB12CD");
  });

  it("rejects codes with the wrong length", async () => {
    expect((await check(JoinRoomDto, { code: "ABC" })).failed).toEqual([
      "code",
    ]);
  });
});

describe("Public DTOs", () => {
  it("WaitlistDto normalises the email and validates the locale", async () => {
    const ok = await check(WaitlistDto, {
      email: " A@B.com ",
      locale: "es",
      captchaToken: "t",
    });
    expect(ok.failed).toEqual([]);
    expect(ok.instance.email).toBe("a@b.com");
    expect(
      (
        await check(WaitlistDto, {
          email: "a@b.com",
          locale: "fr",
          captchaToken: "t",
        })
      ).failed,
    ).toEqual(["locale"]);
  });

  it("ContactDto collapses whitespace and lowercases the email", async () => {
    const { instance, failed } = await check(ContactDto, {
      name: "  Ann   Lee ",
      email: " ANN@X.com",
      subject: "Hello    there",
      message: "line1\r\n\r\n\r\n\r\nline2   with   spaces ",
      captchaToken: "t",
    });
    expect(failed).toEqual([]);
    expect(instance.name).toBe("Ann Lee");
    expect(instance.email).toBe("ann@x.com");
    expect(instance.subject).toBe("Hello there");
    expect(instance.message).toBe("line1\n\nline2 with spaces");
  });

  it("Waitlist and Contact DTOs require a captchaToken", async () => {
    expect((await check(WaitlistDto, { email: "a@b.com" })).failed).toEqual([
      "captchaToken",
    ]);
    expect(
      (
        await check(ContactDto, {
          name: "n",
          email: "a@b.com",
          subject: "s",
          message: "m",
          captchaToken: "t".repeat(2049),
        })
      ).failed,
    ).toEqual(["captchaToken"]);
  });

  it("ContactDto rejects empty and oversized fields", async () => {
    const { failed } = await check(ContactDto, {
      name: "   ",
      email: "a@b.com",
      subject: "x".repeat(151),
      message: "m".repeat(5001),
      captchaToken: "t",
    });
    expect(failed).toEqual(["message", "name", "subject"]);
  });

  it("LeaderboardQueryDto coerces numbers, applies defaults and enforces bounds", async () => {
    const ok = await check(LeaderboardQueryDto, { limit: "50", offset: "5" });
    expect(ok.failed).toEqual([]);
    expect(ok.instance).toMatchObject({ limit: 50, offset: 5 });
    expect((await check(LeaderboardQueryDto, {})).instance).toMatchObject({
      limit: 20,
      offset: 0,
    });
    expect(
      (await check(LeaderboardQueryDto, { limit: "101", offset: "-1" })).failed,
    ).toEqual(["limit", "offset"]);
  });

  it("UsernameParamDto accepts safe usernames only", async () => {
    expect(
      (await check(UsernameParamDto, { username: "a.b-c_9" })).failed,
    ).toEqual([]);
    expect(
      (await check(UsernameParamDto, { username: "../etc" })).failed,
    ).toEqual(["username"]);
    expect(
      (await check(UsernameParamDto, { username: "a".repeat(25) })).failed,
    ).toEqual(["username"]);
  });
});

describe("SyncStatsDto", () => {
  const match = {
    clientMatchId: "11111111-1111-4111-8111-111111111111",
    aiDifficulty: "EASY",
    result: "WIN",
    attemptsUsed: 5,
    totalPicos: 8,
    totalPalas: 6,
    durationSec: 100,
  };

  it("accepts a valid batch", async () => {
    expect((await check(SyncStatsDto, { matches: [match] })).failed).toEqual(
      [],
    );
  });

  it("rejects empty and oversized batches", async () => {
    expect((await check(SyncStatsDto, { matches: [] })).failed).toEqual([
      "matches",
    ]);
    expect(
      (await check(SyncStatsDto, { matches: Array(51).fill(match) })).failed,
    ).toEqual(["matches"]);
  });

  it("rejects out-of-range nested values", async () => {
    const { failed } = await check(SyncStatsDto, {
      matches: [{ ...match, attemptsUsed: 21, clientMatchId: "not-a-uuid" }],
    });
    expect(failed).toEqual(["matches"]);
  });
});
