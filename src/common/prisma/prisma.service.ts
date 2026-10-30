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
    // Only at LOG_LEVEL=debug, and never the bound parameters: they carry
    // live secrets (a GitHub install intent's state, invitation token
    // hashes) and personal data, and once went to every info log.
    if (this.logger.isDebugEnabled()) {
      this.$on('query', (event) => {
        this.logger.debug('prisma.query', {
          query: event.query,
          durationMs: event.duration,
        });
      });
    }
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
