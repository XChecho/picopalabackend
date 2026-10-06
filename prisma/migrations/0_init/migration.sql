-- CreateEnum
CREATE TYPE "Language" AS ENUM ('ES', 'EN', 'PT');

-- CreateEnum
CREATE TYPE "Rank" AS ENUM ('BRONCE', 'PLATA', 'ORO', 'PLATINO', 'DIAMANTE');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('VERSUS_AI', 'PRIVATE', 'GLOBAL');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('WAITING', 'PLAYING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EndReason" AS ENUM ('GUESSED', 'MAX_TURNS', 'ABANDONED', 'TIMEOUT', 'RESIGNED');

-- CreateEnum
CREATE TYPE "MatchSource" AS ENUM ('ONLINE', 'OFFLINE_SYNC');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('WIN', 'LOSS', 'DRAW');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('WAITING', 'IN_GAME', 'CLOSED', 'EXPIRED');

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "username" VARCHAR(24) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT,
    "avatarUrl" TEXT,
    "language" "Language" NOT NULL DEFAULT 'ES',
    "elo" INTEGER NOT NULL DEFAULT 1000,
    "rank" "Rank" NOT NULL DEFAULT 'PLATA',
    "lastSeenAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "pushToken" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'WAITING',
    "endReason" "EndReason",
    "source" "MatchSource" NOT NULL DEFAULT 'ONLINE',
    "clientMatchId" UUID,
    "isRanked" BOOLEAN NOT NULL DEFAULT false,
    "maxTurns" SMALLINT NOT NULL DEFAULT 12,
    "aiDifficulty" "Difficulty",
    "startingSeat" SMALLINT,
    "currentSeat" SMALLINT,
    "turnDeadlineAt" TIMESTAMP(3),
    "roomId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_participants" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "seat" SMALLINT NOT NULL,
    "playerId" UUID,
    "isAi" BOOLEAN NOT NULL DEFAULT false,
    "secretNumber" CHAR(4),
    "result" "MatchResult",
    "attemptsUsed" SMALLINT NOT NULL DEFAULT 0,
    "eloBefore" INTEGER,
    "eloAfter" INTEGER,
    "rankBefore" "Rank",
    "rankAfter" "Rank",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moves" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "turnNumber" SMALLINT NOT NULL,
    "guess" CHAR(4) NOT NULL,
    "picos" SMALLINT NOT NULL,
    "palas" SMALLINT NOT NULL,
    "isWin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "hostId" UUID NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'WAITING',
    "maxTurns" SMALLINT NOT NULL DEFAULT 12,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_stats" (
    "playerId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "games" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "bestAttempts" SMALLINT,
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "totalPicos" INTEGER NOT NULL DEFAULT 0,
    "totalPalas" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSec" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_stats_pkey" PRIMARY KEY ("playerId","mode")
);

-- CreateIndex
CREATE UNIQUE INDEX "players_username_key" ON "players"("username");

-- CreateIndex
CREATE UNIQUE INDEX "players_email_key" ON "players"("email");

-- CreateIndex
CREATE INDEX "players_elo_idx" ON "players"("elo");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_playerId_idx" ON "sessions"("playerId");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "devices_pushToken_key" ON "devices"("pushToken");

-- CreateIndex
CREATE INDEX "devices_playerId_idx" ON "devices"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "matches_clientMatchId_key" ON "matches"("clientMatchId");

-- CreateIndex
CREATE UNIQUE INDEX "matches_roomId_key" ON "matches"("roomId");

-- CreateIndex
CREATE INDEX "matches_status_mode_idx" ON "matches"("status", "mode");

-- CreateIndex
CREATE INDEX "matches_finishedAt_idx" ON "matches"("finishedAt");

-- CreateIndex
CREATE INDEX "match_participants_playerId_createdAt_idx" ON "match_participants"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "match_participants_matchId_seat_key" ON "match_participants"("matchId", "seat");

-- CreateIndex
CREATE UNIQUE INDEX "match_participants_matchId_playerId_key" ON "match_participants"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "moves_matchId_createdAt_idx" ON "moves"("matchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "moves_participantId_guess_key" ON "moves"("participantId", "guess");

-- CreateIndex
CREATE UNIQUE INDEX "moves_participantId_turnNumber_key" ON "moves"("participantId", "turnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "rooms_hostId_idx" ON "rooms"("hostId");

-- CreateIndex
CREATE INDEX "rooms_status_expiresAt_idx" ON "rooms"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "match_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Domain rules enforced by the database (not expressible in Prisma schema)
ALTER TABLE "match_participants"
  ADD CONSTRAINT "match_participants_seat_check" CHECK ("seat" IN (1, 2)),
  ADD CONSTRAINT "match_participants_secret_check" CHECK ("secretNumber" IS NULL OR "secretNumber" ~ '^[1-9]{4}$'),
  ADD CONSTRAINT "match_participants_ai_check" CHECK (("isAi" AND "playerId" IS NULL) OR (NOT "isAi"));

ALTER TABLE "moves"
  ADD CONSTRAINT "moves_guess_check" CHECK ("guess" ~ '^[1-9]{4}$'),
  ADD CONSTRAINT "moves_picos_check" CHECK ("picos" BETWEEN 0 AND 4),
  ADD CONSTRAINT "moves_palas_check" CHECK ("palas" BETWEEN 0 AND 4 AND "picos" + "palas" <= 4),
  ADD CONSTRAINT "moves_turn_check" CHECK ("turnNumber" >= 1);

ALTER TABLE "matches"
  ADD CONSTRAINT "matches_max_turns_check" CHECK ("maxTurns" BETWEEN 1 AND 30),
  ADD CONSTRAINT "matches_seat_check" CHECK (("startingSeat" IS NULL OR "startingSeat" IN (1, 2)) AND ("currentSeat" IS NULL OR "currentSeat" IN (1, 2)));
