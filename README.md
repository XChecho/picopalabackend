# Pico & Pala Backend

Backend API for **Pico & Pala**, a number deduction game built with NestJS.

## Tech Stack

- **Framework:** NestJS 10
- **Language:** TypeScript
- **Database:** PostgreSQL
- **ORM:** Prisma
- **WebSockets:** Socket.IO
- **Authentication:** JWT + Refresh Tokens
- **Cache/Queue:** Redis
- **Push Notifications:** Expo Push API

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### Installation

```bash
npm install
```

### Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Update the following variables:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/picopala?schema=public"
JWT_SECRET="your-secret-key"
JWT_REFRESH_SECRET="your-refresh-secret"
REDIS_HOST="localhost"
REDIS_PORT=6379
```

### Database Setup

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev

# (Optional) Open Prisma Studio
npx prisma studio
```

### Running the App

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

The API will be available at `http://localhost:3000/api/v1`.

## API Documentation

See [BACKEND.md](./BACKEND.md) for the complete API specification.

## Project Structure

```
src/
├── auth/              # Authentication module
├── player/            # Player profile & stats
├── match/             # Match management & WebSocket
├── room/              # Room creation & matchmaking
├── game/              # Game engine & AI logic
├── notification/      # Push notifications
├── stats/             # Statistics sync
├── common/            # Shared utilities
├── prisma/            # Prisma service
└── redis/             # Redis service
```

## Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## License

MIT
