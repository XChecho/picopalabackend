import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function getRank(elo: number): string {
  if (elo >= 2500) return 'DIAMANTE';
  if (elo >= 2000) return 'PLATINO';
  if (elo >= 1500) return 'ORO';
  if (elo >= 1000) return 'PLATA';
  return 'BRONCE';
}

function getTrophies(elo: number): number {
  return Math.floor(elo / 10);
}

async function main() {
  console.log('Clearing existing data...');
  await prisma.eloHistory.deleteMany();
  await prisma.move.deleteMany();
  await prisma.match.deleteMany();
  await prisma.room.deleteMany();
  await prisma.stats.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.player.deleteMany();

  console.log('Hashing passwords...');
  const hashedPassword = await bcrypt.hash('password123', 10);

  console.log('Creating players...');
  const playersData = [
    { username: 'player1', email: 'player1@test.com', elo: 1000 },
    { username: 'player2', email: 'player2@test.com', elo: 1200 },
    { username: 'player3', email: 'player3@test.com', elo: 1500 },
    { username: 'player4', email: 'player4@test.com', elo: 2000 },
    { username: 'player5', email: 'player5@test.com', elo: 2500 },
  ];

  const players: Record<string, any> = {};
  for (const p of playersData) {
    players[p.username] = await prisma.player.create({
      data: {
        username: p.username,
        email: p.email,
        password: hashedPassword,
        elo: p.elo,
        trophies: getTrophies(p.elo),
        rank: getRank(p.elo),
      },
    });
  }
  console.log(`  Created ${Object.keys(players).length} players`);

  console.log('Creating stats...');
  const statsData = [
    {
      playerId: players.player1.id,
      totalGames: 10,
      wins: 5,
      losses: 4,
      draws: 1,
      bestScore: 180,
      currentStreak: 1,
      bestStreak: 3,
      avgTimePerGame: 120,
      totalPicos: 25,
      totalPalas: 32,
    },
    {
      playerId: players.player2.id,
      totalGames: 15,
      wins: 8,
      losses: 5,
      draws: 2,
      bestScore: 210,
      currentStreak: 2,
      bestStreak: 4,
      avgTimePerGame: 95,
      totalPicos: 38,
      totalPalas: 45,
    },
    {
      playerId: players.player3.id,
      totalGames: 20,
      wins: 12,
      losses: 6,
      draws: 2,
      bestScore: 250,
      currentStreak: 0,
      bestStreak: 5,
      avgTimePerGame: 80,
      totalPicos: 52,
      totalPalas: 60,
    },
    {
      playerId: players.player4.id,
      totalGames: 30,
      wins: 20,
      losses: 7,
      draws: 3,
      bestScore: 300,
      currentStreak: 3,
      bestStreak: 7,
      avgTimePerGame: 65,
      totalPicos: 80,
      totalPalas: 90,
    },
    {
      playerId: players.player5.id,
      totalGames: 40,
      wins: 28,
      losses: 8,
      draws: 4,
      bestScore: 350,
      currentStreak: 5,
      bestStreak: 10,
      avgTimePerGame: 55,
      totalPicos: 105,
      totalPalas: 118,
    },
  ];

  for (const s of statsData) {
    await prisma.stats.create({ data: s });
  }
  console.log(`  Created ${statsData.length} stats records`);

  console.log('Creating rooms...');
  const privateRoom = await prisma.room.create({
    data: {
      code: 'ABC123',
      type: 'PRIVATE',
      hostId: players.player3.id,
      guestId: players.player4.id,
      maxTurns: 10,
      status: 'CLOSED',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const globalRoom = await prisma.room.create({
    data: {
      code: 'XYZ789',
      type: 'GLOBAL',
      hostId: players.player1.id,
      guestId: players.player2.id,
      maxTurns: 10,
      status: 'IN_GAME',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  console.log('  Created 2 rooms');

  console.log('Creating matches...');
  const matchAI = await prisma.match.create({
    data: {
      mode: 'VERSUS_AI',
      status: 'FINISHED',
      player1Id: players.player1.id,
      player2Id: null,
      player1Number: '1234',
      player2Number: '5678',
      currentTurn: 5,
      turnCount: 5,
      maxTurns: 10,
      winnerId: players.player1.id,
      aiDifficulty: 'EASY',
      startedAt: new Date(Date.now() - 3600000),
      finishedAt: new Date(),
    },
  });

  const matchPrivate = await prisma.match.create({
    data: {
      mode: 'PRIVATE',
      status: 'FINISHED',
      player1Id: players.player3.id,
      player2Id: players.player4.id,
      player1Number: '3456',
      player2Number: '7890',
      currentTurn: 7,
      turnCount: 7,
      maxTurns: 10,
      winnerId: players.player3.id,
      roomId: privateRoom.id,
      startedAt: new Date(Date.now() - 7200000),
      finishedAt: new Date(Date.now() - 3600000),
    },
  });

  const matchGlobal = await prisma.match.create({
    data: {
      mode: 'GLOBAL',
      status: 'PLAYING',
      player1Id: players.player1.id,
      player2Id: players.player2.id,
      player1Number: '2468',
      player2Number: '1357',
      currentTurn: 3,
      turnCount: 2,
      maxTurns: 10,
      roomId: globalRoom.id,
      startedAt: new Date(Date.now() - 600000),
    },
  });

  await prisma.room.update({
    where: { id: privateRoom.id },
    data: { matchId: matchPrivate.id },
  });
  await prisma.room.update({
    where: { id: globalRoom.id },
    data: { matchId: matchGlobal.id },
  });
  console.log('  Created 3 matches');

  console.log('Creating moves...');
  const movesAI = [
    { matchId: matchAI.id, playerId: players.player1.id, turnNumber: 1, guess: '1111', palas: 1, picos: 2, isWin: false },
    { matchId: matchAI.id, playerId: players.player1.id, turnNumber: 2, guess: '2222', palas: 0, picos: 3, isWin: false },
    { matchId: matchAI.id, playerId: players.player1.id, turnNumber: 3, guess: '3456', palas: 2, picos: 1, isWin: false },
    { matchId: matchAI.id, playerId: players.player1.id, turnNumber: 4, guess: '4567', palas: 1, picos: 2, isWin: false },
    { matchId: matchAI.id, playerId: players.player1.id, turnNumber: 5, guess: '5678', palas: 4, picos: 0, isWin: true },
  ];

  const movesPrivate = [
    { matchId: matchPrivate.id, playerId: players.player3.id, turnNumber: 1, guess: '1234', palas: 0, picos: 2, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player4.id, turnNumber: 2, guess: '5678', palas: 1, picos: 1, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player3.id, turnNumber: 3, guess: '2345', palas: 2, picos: 0, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player4.id, turnNumber: 4, guess: '6789', palas: 0, picos: 3, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player3.id, turnNumber: 5, guess: '1239', palas: 1, picos: 1, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player4.id, turnNumber: 6, guess: '3456', palas: 0, picos: 0, isWin: false },
    { matchId: matchPrivate.id, playerId: players.player3.id, turnNumber: 7, guess: '7890', palas: 4, picos: 0, isWin: true },
  ];

  for (const m of [...movesAI, ...movesPrivate]) {
    await prisma.move.create({ data: m });
  }
  console.log(`  Created ${movesAI.length + movesPrivate.length} moves`);

  console.log('Creating ELO history...');
  await prisma.eloHistory.create({
    data: {
      playerId: players.player1.id,
      matchId: matchGlobal.id,
      oldElo: 980,
      newElo: 1000,
      oldTrophies: 98,
      newTrophies: 100,
      oldRank: 'BRONCE',
      newRank: 'BRONCE',
    },
  });

  await prisma.eloHistory.create({
    data: {
      playerId: players.player2.id,
      matchId: matchGlobal.id,
      oldElo: 1210,
      newElo: 1200,
      oldTrophies: 121,
      newTrophies: 120,
      oldRank: 'BRONCE',
      newRank: 'BRONCE',
    },
  });

  await prisma.eloHistory.create({
    data: {
      playerId: players.player3.id,
      matchId: matchPrivate.id,
      oldElo: 1470,
      newElo: 1500,
      oldTrophies: 147,
      newTrophies: 150,
      oldRank: 'BRONCE',
      newRank: 'BRONCE',
    },
  });

  await prisma.eloHistory.create({
    data: {
      playerId: players.player4.id,
      matchId: matchPrivate.id,
      oldElo: 2020,
      newElo: 2000,
      oldTrophies: 202,
      newTrophies: 200,
      oldRank: 'PLATA',
      newRank: 'PLATA',
    },
  });
  console.log('  Created 4 ELO history entries');

  console.log('Seed data created successfully!');
}

main()
  .catch((e) => {
    console.error('Error seeding data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
