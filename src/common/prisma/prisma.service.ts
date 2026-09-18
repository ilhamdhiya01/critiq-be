import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PRISMA_LOG_CONFIG } from './prisma.types';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@Injectable()
export class PrismaService
  extends PrismaClient<
    {
      log: Prisma.LogDefinition[];
      adapter: NonNullable<Prisma.PrismaClientOptions['adapter']>;
    },
    Prisma.LogLevel
  >
  implements OnModuleInit
{
  constructor(
    configService: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super({
      log: PRISMA_LOG_CONFIG,
      adapter: new PrismaPg({
        connectionString: configService.get<string>('DATABASE_URL'),
      }),
    });
  }

  onModuleInit() {
    this.$on('query', (event) => {
      this.logger.info(event);
    });
    this.$on('info', (event) => {
      this.logger.info(event);
    });
    this.$on('warn', (event) => {
      this.logger.warn(event);
    });
    this.$on('error', (event) => {
      this.logger.error(event);
    });
  }
}
