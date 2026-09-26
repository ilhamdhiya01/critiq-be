import { Global, Module, ValidationPipe } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ConfigModule } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { validationSchema } from '../config/validation.schema';
import configuration from '../config/configuration';
import { EncryptionService } from './encryption/encryption.service';
import { SlugService } from './slug/slug.service';

@Global()
@Module({
  imports: [
    WinstonModule.forRoot({
      format: winston.format.json(),
      transports: [
        // LOG_LEVEL is read straight from the environment rather than
        // ConfigService: this module is what *provides* ConfigModule, so
        // nothing injectable exists yet at this point. Defaults to 'info',
        // which includes PrismaService's per-query events — useful in a
        // server, noise in a one-shot CLI script, hence the override.
        new winston.transports.Console({
          level: process.env.LOG_LEVEL ?? 'info',
        }),
      ],
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: validationSchema,
      load: [configuration],
    }),
  ],
  providers: [
    PrismaService,
    EncryptionService,
    SlugService,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    },
  ],
  exports: [
    PrismaService,
    WinstonModule,
    ConfigModule,
    EncryptionService,
    SlugService,
  ],
})
export class CommonModule {}
