-- AlterTable
ALTER TABLE "rooms" ADD COLUMN "rematchOfMatchId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "rooms_rematchOfMatchId_key" ON "rooms"("rematchOfMatchId");
