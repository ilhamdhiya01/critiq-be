import { Prisma } from '../../generated/prisma/client';

export const PRISMA_LOG_CONFIG: Prisma.LogDefinition[] = [
  {
    emit: 'event',
    level: 'info',
  },
  {
    emit: 'event',
    level: 'warn',
  },
  {
    emit: 'event',
    level: 'error',
  },
  {
    emit: 'event',
    level: 'query',
  },
];
