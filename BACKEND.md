# BACKEND.md — Pico & Pala Backend Specification

> Especificación completa para construir el backend de Pico & Pala con NestJS. Este documento está diseñado para que un agente de código pueda construir el backend completo siguiendo estas especificaciones.

---

## 1. Stack Tecnológico

| Componente | Tecnología | Versión |
|------------|------------|---------|
| **Framework** | NestJS | ^10.x |
| **Lenguaje** | TypeScript | ^5.x |
| **Base de datos** | PostgreSQL | ^15.x |
| **ORM** | Prisma | ^5.x |
| **WebSockets** | Socket.IO | ^4.x |
| **Autenticación** | JWT + Refresh Tokens | passport-jwt |
| **Validación** | class-validator + class-transformer | Latest |
| **Push Notifications** | Firebase Cloud Messaging (FCM) / Expo Push | Latest |
| **Cache/Queue** | Redis | ^7.x |
| **Testing** | Jest + Supertest | Latest |

---

## 2. Estructura del Proyecto

```
backend/
├── src/
│   ├── auth/                    # Módulo de autenticación
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts
│   │   │   └── jwt-refresh.strategy.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   └── jwt-refresh.guard.ts
│   │   └── dto/
│   │       ├── register.dto.ts
│   │       ├── login.dto.ts
│   │       └── refresh-token.dto.ts
│   ├── player/                  # Módulo de jugadores
│   │   ├── player.module.ts
│   │   ├── player.controller.ts
│   │   ├── player.service.ts
│   │   └── dto/
│   │       └── update-player.dto.ts
│   ├── match/                   # Módulo de partidas
│   │   ├── match.module.ts
│   │   ├── match.controller.ts
│   │   ├── match.service.ts
│   │   ├── match.gateway.ts     # WebSocket gateway
│   │   └── dto/
│   │       ├── create-match.dto.ts
│   │       └── submit-move.dto.ts
│   ├── room/                    # Módulo de salas
│   │   ├── room.module.ts
│   │   ├── room.controller.ts
│   │   ├── room.service.ts
│   │   ├── room.gateway.ts      # WebSocket gateway para matchmaking
│   │   └── dto/
│   │       ├── create-room.dto.ts
│   │       └── join-room.dto.ts
│   ├── game/                    # Motor del juego (lógica pura)
│   │   ├── game.module.ts
│   │   ├── game.service.ts      # Generación de números, cálculo de feedback
│   │   └── ai/
│   │       ├── ai.service.ts    # Lógica de IA para Versus AI
│   │       ├── easy-ai.ts
│   │       ├── medium-ai.ts
│   │       └── hard-ai.ts
│   ├── notification/            # Módulo de notificaciones push
│   │   ├── notification.module.ts
│   │   └── notification.service.ts
│   ├── stats/                   # Módulo de estadísticas
│   │   ├── stats.module.ts
│   │   ├── stats.controller.ts
│   │   └── stats.service.ts
│   ├── common/                  # Utilidades compartidas
│   │   ├── decorators/
│   │   │   └── current-user.decorator.ts
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts
│   │   ├── interceptors/
│   │   │   └── transform.interceptor.ts
│   │   └── interfaces/
│   │       └── jwt-payload.interface.ts
│   ├── prisma/                  # Servicio Prisma
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── redis/                   # Servicio Redis
│   │   ├── redis.module.ts
│   │   └── redis.service.ts
│   ├── app.module.ts
│   └── main.ts
├── prisma/
│   └── schema.prisma            # Esquema de base de datos
├── test/
│   ├── app.e2e-spec.ts
│   └── jest-e2e.json
├── .env.example
├── .gitignore
├── nest-cli.json
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

---

## 3. Database Schema (Prisma)

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Player {
  id            String    @id @default(uuid())
  username      String    @unique
  email         String    @unique
  password      String
  avatar        String?
  language      String    @default("en")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  refreshTokens RefreshToken[]
  matchesAsP1   Match[]          @relation("Player1Matches")
  matchesAsP2   Match[]          @relation("Player2Matches")
  moves         Move[]
  roomsHosted   Room[]           @relation("HostedRooms")
  roomsJoined   Room[]           @relation("JoinedRooms")
  stats         Stats?

  @@map("players")
}

model RefreshToken {
  id        String   @id @default(uuid())
  token     String   @unique
  playerId  String
  expiresAt DateTime
  createdAt DateTime @default(now())

  player Player @relation(fields: [playerId], references: [id], onDelete: Cascade)

  @@map("refresh_tokens")
}

model Stats {
  id              String  @id @default(uuid())
  playerId        String  @unique
  totalGames      Int     @default(0)
  wins            Int     @default(0)
  losses          Int     @default(0)
  draws           Int     @default(0)
  bestScore       Int     @default(0)
  currentStreak   Int     @default(0)
  bestStreak      Int     @default(0)
  avgTimePerGame  Int     @default(0)
  totalPicos      Int     @default(0)
  totalPalas      Int     @default(0)

  player Player @relation(fields: [playerId], references: [id], onDelete: Cascade)

  @@map("stats")
}

model Match {
  id            String      @id @default(uuid())
  mode          GameMode
  status        MatchStatus @default(WAITING)
  player1Id     String
  player2Id     String?
  player1Number String
  player2Number String?
  currentTurn   Int         @default(1)
  turnCount     Int         @default(0)
  maxTurns      Int         @default(10)
  winnerId      String?
  roomId        String?
  aiDifficulty  Difficulty?
  startedAt     DateTime    @default(now())
  finishedAt    DateTime?
  createdAt     DateTime    @default(now())

  // Relations
  player1 Player @relation("Player1Matches", fields: [player1Id], references: [id])
  player2 Player? @relation("Player2Matches", fields: [player2Id], references: [id])
  room    Room?   @relation(fields: [roomId], references: [id])
  moves   Move[]

  @@map("matches")
}

model Move {
  id         String   @id @default(uuid())
  matchId    String
  playerId   String
  turnNumber Int
  guess      String
  palas      Int
  picos      Int
  isWin      Boolean  @default(false)
  createdAt  DateTime @default(now())

  match  Match  @relation(fields: [matchId], references: [id], onDelete: Cascade)
  player Player @relation(fields: [playerId], references: [id])

  @@map("moves")
}

model Room {
  id        String     @id @default(uuid())
  code      String     @unique
  type      RoomType
  hostId    String
  guestId   String?
  matchId   String?    @unique
  status    RoomStatus @default(WAITING)
  createdAt DateTime   @default(now())
  expiresAt DateTime

  // Relations
  host    Player @relation("HostedRooms", fields: [hostId], references: [id])
  guest   Player? @relation("JoinedRooms", fields: [guestId], references: [id])
  match   Match?  @relation(fields: [matchId], references: [id])

  @@map("rooms")
}

enum GameMode {
  VERSUS_AI
  PRIVATE
  GLOBAL
}

enum MatchStatus {
  WAITING
  PLAYING
  FINISHED
}

enum Difficulty {
  EASY
  MEDIUM
  HARD
}

enum RoomType {
  PRIVATE
  GLOBAL
}

enum RoomStatus {
  WAITING
  READY
  IN_GAME
  CLOSED
}
```

---

## 4. Environment Variables

```bash
# .env.example

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/picopala?schema=public"

# JWT
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_SECRET="your-super-secret-refresh-key-change-in-production"
JWT_REFRESH_EXPIRES_IN="7d"

# Redis
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_PASSWORD=""

# Firebase Cloud Messaging (para push notifications)
FIREBASE_PROJECT_ID="your-project-id"
FIREBASE_PRIVATE_KEY="your-private-key"
FIREBASE_CLIENT_EMAIL="your-client-email"

# App
PORT=3000
NODE_ENV=development
CORS_ORIGIN="http://localhost:8081"
```

---

## 5. API Endpoints

### 5.1 Authentication

#### POST `/api/v1/auth/register`
Crear cuenta de jugador.

**Request Body:**
```typescript
{
  username: string;      // 3-20 caracteres, alfanumérico
  email: string;         // Email válido
  password: string;      // Mínimo 8 caracteres
  language?: string;     // "en" | "es" (default: "en")
}
```

**Response (201):**
```typescript
{
  accessToken: string;
  refreshToken: string;
  player: {
    id: string;
    username: string;
    email: string;
    language: string;
    createdAt: string;
  }
}
```

**Errors:**
- `400` - Validation errors (username taken, invalid email, weak password)
- `409` - Username or email already exists

---

#### POST `/api/v1/auth/login`
Iniciar sesión.

**Request Body:**
```typescript
{
  username: string;
  password: string;
}
```

**Response (200):** Igual que register.

**Errors:**
- `401` - Invalid credentials

---

#### POST `/api/v1/auth/refresh`
Refrescar token de acceso.

**Request Body:**
```typescript
{
  refreshToken: string;
}
```

**Response (200):**
```typescript
{
  accessToken: string;
  refreshToken: string;
}
```

**Errors:**
- `401` - Invalid or expired refresh token

---

#### POST `/api/v1/auth/logout`
Cerrar sesión (invalidar refresh token).

**Headers:** `Authorization: Bearer <accessToken>`

**Response (200):**
```typescript
{
  message: "Logged out successfully"
}
```

---

### 5.2 Player

#### GET `/api/v1/player/me`
Obtener perfil del jugador autenticado.

**Headers:** `Authorization: Bearer <accessToken>`

**Response (200):**
```typescript
{
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  language: string;
  createdAt: string;
}
```

---

#### PATCH `/api/v1/player/me`
Actualizar perfil.

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  username?: string;
  avatar?: string;
  language?: string;
}
```

**Response (200):** Perfil actualizado.

**Errors:**
- `409` - Username already taken

---

#### GET `/api/v1/player/me/stats`
Obtener estadísticas del jugador.

**Headers:** `Authorization: Bearer <accessToken>`

**Response (200):**
```typescript
{
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  bestScore: number;
  currentStreak: number;
  bestStreak: number;
  avgTimePerGame: number;
  totalPicos: number;
  totalPalas: number;
}
```

---

#### GET `/api/v1/player/me/matches`
Historial de partidas del jugador.

**Headers:** `Authorization: Bearer <accessToken>`

**Query Params:**
```typescript
{
  limit?: number;    // Default: 20, Max: 100
  offset?: number;   // Default: 0
  mode?: GameMode;   // "VERSUS_AI" | "PRIVATE" | "GLOBAL"
  status?: MatchStatus; // "WAITING" | "PLAYING" | "FINISHED"
}
```

**Response (200):**
```typescript
{
  matches: Array<{
    id: string;
    mode: GameMode;
    status: MatchStatus;
    winnerId: string | null;
    turnCount: number;
    startedAt: string;
    finishedAt: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}
```

---

### 5.3 Match

#### POST `/api/v1/match`
Crear nueva partida (Versus AI).

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  mode: "VERSUS_AI";
  aiDifficulty: "EASY" | "MEDIUM" | "HARD";
  maxTurns?: number;  // Default: 10
}
```

**Response (201):**
```typescript
{
  id: string;
  mode: GameMode;
  status: MatchStatus;
  player1Id: string;
  player1Number: string;  // Número secreto generado
  currentTurn: number;
  turnCount: number;
  maxTurns: number;
  aiDifficulty: Difficulty;
  startedAt: string;
  createdAt: string;
}
```

---

#### GET `/api/v1/match/:id`
Obtener detalle de partida.

**Headers:** `Authorization: Bearer <accessToken>`

**Response (200):**
```typescript
{
  id: string;
  mode: GameMode;
  status: MatchStatus;
  player1Id: string;
  player2Id: string | null;
  currentTurn: number;
  turnCount: number;
  maxTurns: number;
  aiDifficulty: Difficulty | null;
  moves: Array<{
    id: string;
    playerId: string;
    turnNumber: number;
    guess: string;
    palas: number;
    picos: number;
    isWin: boolean;
    createdAt: string;
  }>;
  startedAt: string;
  finishedAt: string | null;
}
```

**Errors:**
- `403` - Player not authorized to view this match
- `404` - Match not found

---

#### POST `/api/v1/match/:id/move`
Enviar un movimiento/turno.

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  guess: string;  // 4 dígitos, 1-9, sin repetir
}
```

**Response (200):**
```typescript
{
  move: {
    id: string;
    matchId: string;
    playerId: string;
    turnNumber: number;
    guess: string;
    palas: number;
    picos: number;
    isWin: boolean;
    createdAt: string;
  };
  matchStatus: MatchStatus;
  nextTurn: number;
  aiMove?: {
    guess: string;
    palas: number;
    picos: number;
    isWin: boolean;
  };
}
```

**Errors:**
- `400` - Invalid guess (wrong format, repeated digits, contains 0)
- `403` - Not your turn
- `404` - Match not found
- `409` - Match already finished

---

### 5.4 Room (Private & Global)

#### POST `/api/v1/room/private`
Crear sala privada.

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  maxTurns?: number;  // Default: 10
}
```

**Response (201):**
```typescript
{
  id: string;
  code: string;       // Código de 6 caracteres (ej: "ABCD12")
  type: "PRIVATE";
  hostId: string;
  status: RoomStatus;
  expiresAt: string;  // 1 hora desde creación
  createdAt: string;
}
```

---

#### POST `/api/v1/room/private/join`
Unirse a sala privada.

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  code: string;  // Código de sala
}
```

**Response (200):**
```typescript
{
  room: {
    id: string;
    code: string;
    hostId: string;
    guestId: string;
    status: RoomStatus;
    matchId: string;
  };
  match: {
    id: string;
    mode: "PRIVATE";
    status: "PLAYING";
    player1Id: string;
    player2Id: string;
    currentTurn: number;
    maxTurns: number;
  };
}
```

**Errors:**
- `404` - Room not found
- `409` - Room is full or expired

---

#### POST `/api/v1/room/global/join`
Entrar a cola de matchmaking global.

**Headers:** `Authorization: Bearer <accessToken>`

**Request Body:**
```typescript
{
  maxTurns?: number;  // Default: 10
}
```

**Response (200):**
```typescript
{
  status: "queued";
  queuePosition: number;
  estimatedWait: number;  // Segundos estimados
}
```

**WebSocket Event (cuando se encuentra match):**
```typescript
{
  event: "match_found";
  data: {
    matchId: string;
    roomId: string;
    opponent: {
      id: string;
      username: string;
    };
  };
}
```

---

#### DELETE `/api/v1/room/global/leave`
Salir de cola de matchmaking.

**Headers:** `Authorization: Bearer <accessToken>`

**Response (200):**
```typescript
{
  message: "Left matchmaking queue"
}
```

---

## 6. WebSocket Events (Socket.IO)

### 6.1 Match Gateway (`/match`)

Para partidas en tiempo real (Global Room).

#### Client → Server

| Event | Payload | Descripción |
|-------|---------|-------------|
| `join_match` | `{ matchId: string }` | Unirse a sala de partida |
| `submit_move` | `{ matchId: string, guess: string }` | Enviar turno |
| `leave_match` | `{ matchId: string }` | Abandonar partida |

#### Server → Client

| Event | Payload | Descripción |
|-------|---------|-------------|
| `opponent_move` | `{ playerId: string, guess: string, palas: number, picos: number, isWin: boolean }` | Turno del oponente |
| `match_update` | `{ matchId: string, status: MatchStatus, currentTurn: number }` | Actualización de estado |
| `match_finished` | `{ matchId: string, winnerId: string \| null, reason: string }` | Partida terminada |
| `opponent_disconnected` | `{ playerId: string }` | Oponente se desconectó |
| `opponent_reconnected` | `{ playerId: string }` | Oponente reconectó |

### 6.2 Matchmaking Gateway (`/matchmaking`)

Para cola de matchmaking global.

#### Client → Server

| Event | Payload | Descripción |
|-------|---------|-------------|
| `join_queue` | `{ maxTurns: number }` | Entrar a cola |
| `leave_queue` | `{}` | Salir de cola |

#### Server → Client

| Event | Payload | Descripción |
|-------|---------|-------------|
| `queue_update` | `{ position: number, estimatedWait: number }` | Actualización de posición en cola |
| `match_found` | `{ matchId: string, roomId: string, opponent: { id: string, username: string } }` | Match encontrado |

---

## 7. Game Engine (Lógica del Juego)

### 7.1 Generación de Número Secreto

```typescript
function generateSecretNumber(): string {
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const selected: number[] = [];
  
  for (let i = 0; i < 4; i++) {
    const randomIndex = Math.floor(Math.random() * digits.length);
    selected.push(digits[randomIndex]);
    digits.splice(randomIndex, 1);
  }
  
  return selected.join('');
}
```

### 7.2 Cálculo de Feedback (Pala/Pico)

```typescript
interface MoveFeedback {
  palas: number;
  picos: number;
  isWin: boolean;
}

function calculateFeedback(guess: string, secret: string): MoveFeedback {
  let palas = 0;
  let picos = 0;
  
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) {
      palas++;
    } else if (secret.includes(guess[i])) {
      picos++;
    }
  }
  
  return {
    palas,
    picos,
    isWin: palas === 4
  };
}
```

### 7.3 Validación de Intento

```typescript
function validateGuess(guess: string): { valid: boolean; error?: string } {
  if (guess.length !== 4) {
    return { valid: false, error: 'Guess must be 4 digits' };
  }
  
  if (!/^[1-9]+$/.test(guess)) {
    return { valid: false, error: 'Digits must be between 1 and 9' };
  }
  
  const uniqueDigits = new Set(guess.split(''));
  if (uniqueDigits.size !== 4) {
    return { valid: false, error: 'Digits cannot repeat' };
  }
  
  return { valid: true };
}
```

### 7.4 IA para Versus AI

#### Easy (Aleatorio)
```typescript
function easyAIMove(usedGuesses: string[]): string {
  // Genera intentos aleatorios válidos
  // Evita repetir intentos anteriores
}
```

#### Medium (Eliminación básica)
```typescript
function mediumAIMove(moves: Move[]): string {
  // Mantiene lista de posibles números
  // Elimina posibilidades basándose en feedback anterior
  // Elige aleatoriamente de las posibilidades restantes
}
```

#### Hard (Algoritmo optimizado)
```typescript
function hardAIMove(moves: Move[]): string {
  // Usa algoritmo similar a Mastermind solver
  // Minimiza el espacio de posibilidades en cada turno
  // Implementación de Knuth's algorithm o similar
}
```

---

## 8. Offline-First Sync Strategy

### 8.1 Versus AI (100% Offline)
- No requiere backend para jugar.
- Al finalizar partida, si el jugador tiene cuenta, sincroniza stats con backend.
- Endpoint: `POST /api/v1/stats/sync` para sincronizar partidas offline.

### 8.2 Private Room (Async)
- Turnos asíncronos: cada jugador juega cuando pueda.
- Cola de movimientos pendientes en cliente.
- Al reconectar, envía movimientos pendientes.
- Push notification al oponente cuando hay turno nuevo.

### 8.3 Global Room (Real-time)
- WebSocket para sincronización en tiempo real.
- Si se pierde conexión, se guarda estado local.
- Reconexión automática con re-sync de estado.
- Timeout de 60 segundos: si no reconecta, pierde por abandono.

---

## 9. Push Notifications

### 9.1 Tipos de Notificaciones

| Tipo | Trigger | Payload |
|------|---------|---------|
| `OPPONENT_MOVE` | Oponente jugó su turno | `{ matchId, opponentUsername }` |
| `MATCH_FOUND` | Match encontrado (Global Room) | `{ matchId, opponentUsername }` |
| `ROOM_INVITE` | Invitación a sala privada | `{ roomId, code, hostUsername }` |

### 9.2 Expo Push Token

El cliente envía su Expo push token al backend:

```typescript
POST /api/v1/player/me/push-token
{
  "expoPushToken": "ExponentPushToken[xxxxxx]"
}
```

---

## 10. Security Considerations

1. **JWT con refresh tokens**: Access token corta vida (15min), refresh token larga vida (7 días).
2. **Números secretos**: No se envían al cliente rival. Solo el backend los conoce.
3. **Validación de intentos**: Backend valida formato y calcula feedback.
4. **Rate limiting**: Limitar requests a endpoints de juego para prevenir abuso.
5. **CORS**: Configurar origen permitido (Expo app).
6. **Helmet**: Usar `@nestjs/helmet` para headers de seguridad.
7. **Password hashing**: bcrypt con salt rounds = 10.

---

## 11. Testing

### 11.1 Unit Tests
- Game engine (generación de números, cálculo de feedback)
- AI logic (easy, medium, hard)
- Validation functions

### 11.2 Integration Tests
- Auth flow (register, login, refresh, logout)
- Match creation and moves
- Room creation and joining

### 11.3 E2E Tests
- Full game flow (Versus AI)
- Full game flow (Private Room)
- Matchmaking flow (Global Room)

---

## 12. Deployment

### 12.1 Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/main"]
```

### 12.2 Environment Variables (Production)
- Usar variables de entorno seguras (no commitear `.env`)
- Rotar JWT secrets periódicamente
- Usar connection pooling para PostgreSQL

### 12.3 Scaling
- Stateless backend (puede escalar horizontalmente)
- Redis para sesiones y cola de matchmaking
- PostgreSQL con read replicas si es necesario

---

## 13. Checklist para Agente de Código

- [ ] Inicializar proyecto NestJS con `nest new backend`
- [ ] Configurar Prisma con PostgreSQL
- [ ] Crear schema.prisma con todos los modelos
- [ ] Implementar módulo Auth (register, login, refresh, logout)
- [ ] Implementar módulo Player (perfil, stats, historial)
- [ ] Implementar módulo Game (engine, AI, feedback)
- [ ] Implementar módulo Match (crear partida, enviar turno)
- [ ] Implementar módulo Room (private, global)
- [ ] Implementar WebSocket gateways
- [ ] Implementar módulo Notification (push)
- [ ] Agregar validación con class-validator
- [ ] Agregar guards y decorators
- [ ] Configurar CORS, Helmet, rate limiting
- [ ] Escribir tests unitarios e integration
- [ ] Configurar Docker
- [ ] Documentar API con Swagger (opcional)
