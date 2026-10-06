import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "../../src/app.module";
import { HttpExceptionFilter } from "../../src/common/filters/http-exception.filter";
import { TransformInterceptor } from "../../src/common/interceptors/transform.interceptor";
import { parseCorsOrigins } from "../../src/common/utils/cors.util";

/**
 * Builds the app exactly like src/main.ts (minus the console banner); it listens on an
 * ephemeral loopback port. Config is read from process.env when AppModule is first imported
 * (ConfigModule snapshots it), so env tweaks must happen before importing this module.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });

  app.set("trust proxy", 1);
  app.use(helmet());
  app.useBodyParser("json", { limit: "100kb" });
  app.useBodyParser("urlencoded", { limit: "100kb", extended: true });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableCors({ origin: parseCorsOrigins(), credentials: true });

  // Listen once on an ephemeral loopback port: avoids supertest re-binding a port per request.
  await app.listen(0, "127.0.0.1");
  return app;
}
