-- AlterTable
ALTER TABLE "match_participants" ADD COLUMN     "disconnectedAt" TIMESTAMP(3),
ADD COLUMN     "missedTurns" SMALLINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "matches_status_turnDeadlineAt_idx" ON "matches"("status", "turnDeadlineAt");

-- CreateIndex
CREATE INDEX "match_participants_disconnectedAt_idx" ON "match_participants"("disconnectedAt");
