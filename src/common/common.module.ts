import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { ConfigModule } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { validationSchema } from '../config/validation.schema';
import configuration from '../config/configuration';
import { EncryptionService } from './encryption/encryption.service';

@Global()
@Module({
  imports: [
    WinstonModule.forRoot({
      format: winston.format.json(),
      transports: [new winston.transports.Console()],
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
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
  exports: [PrismaService, WinstonModule, ConfigModule, EncryptionService],
})
export class CommonModule {}
