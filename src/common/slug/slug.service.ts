import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class SlugService {
  private slugify(input: string): string {
    return (
      input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'org'
    );
  }

  async generateUniqueOrgSlug(tx: TxClient, seed: string): Promise<string> {
    const base = this.slugify(seed);
    let candidate = base;
    let suffix = 0;

    while (await tx.organization.findUnique({ where: { slug: candidate } })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }

    return candidate;
  }
}
