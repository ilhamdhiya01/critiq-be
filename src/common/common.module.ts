import { Global, Module, ValidationPipe } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
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
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    },
  ],
  exports: [PrismaService, WinstonModule, ConfigModule, EncryptionService],
})
export class CommonModule {}
