import { GameMode, MatchResult, Player, PrismaClient, Rank } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function getRank(elo: number): Rank {
  if (elo >= 2500) return Rank.DIAMANTE;
  if (elo >= 2000) return Rank.PLATINO;
  if (elo >= 1500) return Rank.ORO;
  if (elo >= 1000) return Rank.PLATA;
  return Rank.BRONCE;
}

interface ISeedMove {
  guess: string;
  picos: number;
  palas: number;
}

interface ISeedParticipant {
  seat: number;
  player: Player | null;
  secretNumber: string;
  result?: MatchResult;
  eloBefore?: number;
  eloAfter?: number;
  moves: ISeedMove[];
}

async function createParticipant(matchId: string, p: ISeedParticipant): Promise<void> {
  const participant = await prisma.matchParticipant.create({
    data: {
      matchId,
      seat: p.seat,
      playerId: p.player?.id ?? null,
      isAi: p.player === null,
      secretNumber: p.secretNumber,
      result: p.result,
      attemptsUsed: p.moves.length,
      eloBefore: p.eloBefore,
      eloAfter: p.eloAfter,
      rankBefore: p.eloBefore !== undefined ? getRank(p.eloBefore) : undefined,
      rankAfter: p.eloAfter !== undefined ? getRank(p.eloAfter) : undefined,
    },
  });

  let turn = 1;
  for (const m of p.moves) {
    await prisma.move.create({
      data: {
        matchId,
        participantId: participant.id,
        turnNumber: turn,
        guess: m.guess,
        picos: m.picos,
        palas: m.palas,
        isWin: m.picos === 4,
      },
    });
    turn += 1;
  }
}

async function main(): Promise<void> {
  console.log('Clearing existing data...');
  await prisma.move.deleteMany();
  await prisma.matchParticipant.deleteMany();
  await prisma.match.deleteMany();
  await prisma.room.deleteMany();
  await prisma.playerStats.deleteMany();
  await prisma.device.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.player.deleteMany();

  console.log('Hashing passwords...');
  const passwordHash = await bcrypt.hash('password123', 12);

  console.log('Creating players...');
  const playersData = [
    { username: 'player1', email: 'player1@test.com', elo: 1000 },
    { username: 'player2', email: 'player2@test.com', elo: 1200 },
    { username: 'player3', email: 'player3@test.com', elo: 1500 },
    { username: 'player4', email: 'player4@test.com', elo: 2000 },
    { username: 'player5', email: 'player5@test.com', elo: 2500 },
  ];

  const players: Record<string, Player> = {};
  for (const p of playersData) {
    players[p.username] = await prisma.player.create({
      data: {
        username: p.username,
        email: p.email,
        passwordHash,
        elo: p.elo,
        rank: getRank(p.elo),
        emailVerifiedAt: new Date(),
      },
    });
  }
  console.log(`  Created ${Object.keys(players).length} players`);

  console.log('Creating stats...');
  const statsData = [
    { player: 'player1', games: 10, wins: 5, losses: 4, draws: 1, currentStreak: 1, bestStreak: 3, bestAttempts: 5, totalAttempts: 60, totalPicos: 25, totalPalas: 32, totalDurationSec: 1200 },
    { player: 'player2', games: 15, wins: 8, losses: 5, draws: 2, currentStreak: 2, bestStreak: 4, bestAttempts: 4, totalAttempts: 90, totalPicos: 38, totalPalas: 45, totalDurationSec: 1425 },
    { player: 'player3', games: 20, wins: 12, losses: 6, draws: 2, currentStreak: 0, bestStreak: 5, bestAttempts: 4, totalAttempts: 110, totalPicos: 52, totalPalas: 60, totalDurationSec: 1600 },
    { player: 'player4', games: 30, wins: 20, losses: 7, draws: 3, currentStreak: 3, bestStreak: 7, bestAttempts: 3, totalAttempts: 150, totalPicos: 80, totalPalas: 90, totalDurationSec: 1950 },
    { player: 'player5', games: 40, wins: 28, losses: 8, draws: 4, currentStreak: 5, bestStreak: 10, bestAttempts: 3, totalAttempts: 190, totalPicos: 105, totalPalas: 118, totalDurationSec: 2200 },
  ];

  for (const { player, ...s } of statsData) {
    await prisma.playerStats.create({
      data: { playerId: players[player].id, mode: GameMode.GLOBAL, ...s },
    });
  }
  console.log(`  Created ${statsData.length} stats records`);

  console.log('Creating rooms...');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const privateRoom = await prisma.room.create({
    data: {
      code: 'ABC123',
      hostId: players.player3.id,
      maxTurns: 10,
      status: 'CLOSED',
      expiresAt,
    },
  });
  console.log('  Created 1 room');

  console.log('Creating matches...');
  const matchAI = await prisma.match.create({
    data: {
      mode: 'VERSUS_AI',
      status: 'FINISHED',
      endReason: 'GUESSED',
      maxTurns: 10,
      aiDifficulty: 'EASY',
      startingSeat: 1,
      currentSeat: 1,
      startedAt: new Date(Date.now() - 3600000),
      finishedAt: new Date(),
    },
  });
  await createParticipant(matchAI.id, {
    seat: 1,
    player: players.player1,
    secretNumber: '1234',
    result: 'WIN',
    moves: [
      { guess: '1111', picos: 1, palas: 0 },
      { guess: '2222', picos: 1, palas: 0 },
      { guess: '3456', picos: 0, palas: 2 },
      { guess: '4567', picos: 0, palas: 1 },
      { guess: '1234', picos: 4, palas: 0 },
    ],
  });
  await createParticipant(matchAI.id, {
    seat: 2,
    player: null,
    secretNumber: '5678',
    result: 'LOSS',
    moves: [],
  });

  const matchPrivate = await prisma.match.create({
    data: {
      mode: 'PRIVATE',
      status: 'FINISHED',
      endReason: 'GUESSED',
      isRanked: false,
      maxTurns: 10,
      startingSeat: 1,
      currentSeat: 1,
      roomId: privateRoom.id,
      startedAt: new Date(Date.now() - 7200000),
      finishedAt: new Date(Date.now() - 3600000),
    },
  });
  await createParticipant(matchPrivate.id, {
    seat: 1,
    player: players.player3,
    secretNumber: '3456',
    result: 'WIN',
    eloBefore: 1470,
    eloAfter: 1500,
    moves: [
      { guess: '1234', picos: 0, palas: 2 },
      { guess: '2345', picos: 0, palas: 3 },
      { guess: '7890', picos: 4, palas: 0 },
    ],
  });
  await createParticipant(matchPrivate.id, {
    seat: 2,
    player: players.player4,
    secretNumber: '7890',
    result: 'LOSS',
    eloBefore: 2020,
    eloAfter: 2000,
    moves: [
      { guess: '5678', picos: 0, palas: 2 },
      { guess: '6789', picos: 0, palas: 3 },
    ],
  });

  const matchGlobal = await prisma.match.create({
    data: {
      mode: 'GLOBAL',
      status: 'PLAYING',
      isRanked: true,
      maxTurns: 10,
      startingSeat: 1,
      currentSeat: 1,
      turnDeadlineAt: new Date(Date.now() + 60000),
      startedAt: new Date(Date.now() - 600000),
    },
  });
  await createParticipant(matchGlobal.id, {
    seat: 1,
    player: players.player1,
    secretNumber: '2468',
    moves: [{ guess: '1357', picos: 0, palas: 0 }],
  });
  await createParticipant(matchGlobal.id, {
    seat: 2,
    player: players.player2,
    secretNumber: '1357',
    moves: [{ guess: '2468', picos: 0, palas: 0 }],
  });
  console.log('  Created 3 matches');

  console.log('Seed data created successfully!');
}

main()
  .catch((e: unknown) => {
    console.error('Error seeding data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
