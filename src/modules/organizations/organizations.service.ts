import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SlugService } from '../../common/slug/slug.service';
import { Role } from '../../generated/prisma/enums';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugService: SlugService,
  ) {}

  async listForUser(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(userId: string, dto: CreateOrganizationDto) {
    return this.prisma.$transaction(async (tx) => {
      const slug = await this.slugService.generateUniqueOrgSlug(tx, dto.name);
      const organization = await tx.organization.create({
        data: { name: dto.name, slug, createdBy: userId },
      });
      await tx.membership.create({
        data: {
          userId,
          organizationId: organization.id,
          role: Role.ADMIN,
          status: 'ACTIVE',
          lastAccessedAt: new Date(),
        },
      });
      return organization;
    });
  }
}
