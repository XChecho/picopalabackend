import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    private prismaService: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    const existingPlayer = await this.prismaService.player.findFirst({
      where: {
        OR: [
          { username: registerDto.username },
          { email: registerDto.email },
        ],
      },
    });

    if (existingPlayer) {
      if (existingPlayer.username === registerDto.username) {
        throw new ConflictException('Username already exists');
      }
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 10);

    const player = await this.prismaService.player.create({
      data: {
        username: registerDto.username,
        email: registerDto.email,
        password: hashedPassword,
        language: registerDto.language || 'en',
      },
    });

    await this.prismaService.stats.create({
      data: {
        playerId: player.id,
      },
    });

    const tokens = await this.generateTokens(player.id, player.username);

    await this.saveRefreshToken(player.id, tokens.refreshToken);

    return {
      ...tokens,
      player: {
        id: player.id,
        username: player.username,
        email: player.email,
        language: player.language,
        createdAt: player.createdAt,
      },
    };
  }

  async login(loginDto: LoginDto) {
    const player = await this.prismaService.player.findUnique({
      where: { username: loginDto.username },
    });

    if (!player) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, player.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(player.id, player.username);

    await this.saveRefreshToken(player.id, tokens.refreshToken);

    return {
      ...tokens,
      player: {
        id: player.id,
        username: player.username,
        email: player.email,
        language: player.language,
        createdAt: player.createdAt,
      },
    };
  }

  async refreshTokens(playerId: string, refreshToken: string) {
    const storedToken = await this.prismaService.refreshToken.findUnique({
      where: { token: refreshToken },
    });

    if (!storedToken || storedToken.playerId !== playerId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (storedToken.expiresAt < new Date()) {
      await this.prismaService.refreshToken.delete({
        where: { id: storedToken.id },
      });
      throw new UnauthorizedException('Refresh token expired');
    }

    const player = await this.prismaService.player.findUnique({
      where: { id: playerId },
    });

    if (!player) {
      throw new UnauthorizedException('Player not found');
    }

    await this.prismaService.refreshToken.delete({
      where: { id: storedToken.id },
    });

    const tokens = await this.generateTokens(player.id, player.username);

    await this.saveRefreshToken(player.id, tokens.refreshToken);

    return tokens;
  }

  async logout(playerId: string, refreshToken: string) {
    await this.prismaService.refreshToken.deleteMany({
      where: {
        playerId,
        token: refreshToken,
      },
    });

    return { message: 'Logged out successfully' };
  }

  private async generateTokens(playerId: string, username: string) {
    const payload: JwtPayload = { sub: playerId, username };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async saveRefreshToken(playerId: string, token: string) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.prismaService.refreshToken.create({
      data: {
        token,
        playerId,
        expiresAt,
      },
    });
  }
}
