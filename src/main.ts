import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

// User's explicit choice, against the same-origin architecture CLAUDE.md
// otherwise calls for (see "Arsitektur domain & auth") — cross-port local
// dev (FE on :3002, BE on :3001) via CORS instead of a Next.js rewrites
// proxy. This requires the session cookie to be SameSite=None (see
// auth.controller.ts / organizations.controller.ts), which in turn requires
// Secure:true, which browsers only honor over HTTPS — hence the local mkcert
// cert below. None of this is needed if FE proxies /api/v1/* to the BE
// instead; that remains the documented default for anyone else running this
// project.
const certKeyPath = path.join(__dirname, '..', 'certs', 'localhost-key.pem');
const certPath = path.join(__dirname, '..', 'certs', 'localhost.pem');
const httpsOptions =
  fs.existsSync(certKeyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(certKeyPath), cert: fs.readFileSync(certPath) }
    : undefined;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    httpsOptions,
  });

  const logger: Logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  const configService = app.get(ConfigService);

  app.setGlobalPrefix('api/v1');
  app.useLogger(logger);
  app.use(cookieParser());

  app.enableCors({
    origin: configService.getOrThrow<string>('feUrl'),
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
