import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PRISMA_LOG_CONFIG } from './prisma.types';

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
    @InjectPinoLogger(PrismaService.name)
    private readonly logger: PinoLogger,
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
      this.logger.info({ event }, 'prisma query');
    });
    this.$on('info', (event) => {
      this.logger.info({ event }, 'prisma info');
    });
    this.$on('warn', (event) => {
      this.logger.warn({ event }, 'prisma warn');
    });
    this.$on('error', (event) => {
      this.logger.error({ event }, 'prisma error');
    });
  }
}
