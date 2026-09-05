import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger: Logger = app.get(WINSTON_MODULE_NEST_PROVIDER);

  app.setGlobalPrefix('api/v1');
  app.useLogger(logger);
  app.use(cookieParser());

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
