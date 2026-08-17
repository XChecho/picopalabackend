import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  private readonly logger = new Logger(RedisService.name);
  private isConnected = false;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;

    try {
      this.client = new Redis({
        host,
        port,
        password,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.warn('Redis not available, continuing without cache');
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
      });

      this.client.on('error', (err) => {
        if (!this.isConnected) {
          this.logger.warn(`Redis connection failed: ${err.message}. Continuing without cache.`);
        }
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis connected');
      });

      this.client.connect().catch(() => {
        this.logger.warn('Redis not available, continuing without cache');
      });
    } catch (error) {
      this.logger.warn('Redis initialization failed, continuing without cache');
      this.client = null;
    }
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  getClient(): Redis | null {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch {
      // Silently fail - Redis is optional
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.del(key);
    } catch {
      // Silently fail - Redis is optional
    }
  }
}
