import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { originCheck } from './common/middleware/origin-check.middleware';

// User's explicit choice, against the same-origin architecture CLAUDE.md
// otherwise calls for (see "Arsitektur domain & auth") — cross-port local
// dev (FE on :3002, BE on :3001) via CORS instead of a Next.js rewrites
// proxy. The session cookie is Secure, which browsers only honor over HTTPS
// — hence the local mkcert cert below. https://localhost:3002 and
// https://localhost:3001 are the same site, so the default SameSite=Lax
// works; only an FE served over plain http needs SESSION_COOKIE_SAMESITE=none
// (session-cookie.ts). None of this is needed if FE proxies /api/v1/* to the BE
// instead; that remains the documented default for anyone else running this
// project.
// __dirname at runtime is dist/src (see tsconfig.json's outDir + this
// file's location under src/), so the project root — where certs/ actually
// lives — is two levels up, not one. This was silently wrong before: a
// missing cert file just makes httpsOptions undefined with no error, so
// the server quietly fell back to plain HTTP instead of failing loudly.
const certKeyPath = path.join(
  __dirname,
  '..',
  '..',
  'certs',
  'localhost-key.pem',
);
const certPath = path.join(__dirname, '..', '..', 'certs', 'localhost.pem');
const httpsOptions =
  fs.existsSync(certKeyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(certKeyPath), cert: fs.readFileSync(certPath) }
    : undefined;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    httpsOptions,
    // WebhooksController needs the raw request body (Buffer, before Nest's
    // default express.json() parses it) to verify GitHub's
    // X-Hub-Signature-256 HMAC — recomputing the HMAC from a re-serialized
    // JSON object risks whitespace/key-ordering differences from what
    // GitHub actually signed, which would make every signature mismatch.
    // This makes `req.rawBody` available globally; only the webhook routes
    // use it.
    rawBody: true,
  });

  const logger: Logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  const configService = app.get(ConfigService);

  const feUrl = configService.getOrThrow<string>('feUrl');

  app.setGlobalPrefix('api/v1');
  app.useLogger(logger);
  app.disable('x-powered-by');
  // Defaults suit a JSON + SSE API (CLAUDE.md "Keamanan"); the FE sets its
  // own page headers.
  app.use(helmet());
  app.use(cookieParser());
  // Before every route: a cookie-authenticated mutation must come from the
  // FE's origin (CSRF).
  app.use(originCheck(feUrl));

  app.enableCors({
    origin: feUrl,
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
