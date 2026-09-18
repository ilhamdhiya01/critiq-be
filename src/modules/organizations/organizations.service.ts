import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SlugService } from '../../common/slug/slug.service';
import { Role } from '../../generated/prisma/enums';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

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

  // Since PRD v1.4/D3, an organization never starts with an integration —
  // GitLab credentials are org-level access tokens submitted explicitly by
  // an Admin (see the integrations module), not something a user can carry
  // over from their own login. No exceptions, no auto-provisioning here.
  //
  // Every call always creates a brand-new organization (D1: one user can
  // create/belong to many organizations — org switcher's "New organization"
  // relies on this). If the FE's onboarding wizard needs to let a user
  // revise the name after Continue was already pressed once (e.g. Back then
  // forward again), that's a rename of the org already created — the FE
  // should call `update()` (PATCH /orgs/:orgId) with the returned
  // organization id instead of calling `create()` again.
  async create(userId: string, dto: CreateOrganizationDto) {
    return this.prisma.$transaction(async (tx) => {
      const slug = await this.slugService.generateUniqueOrgSlug(tx, dto.name);
      const organization = await tx.organization.create({
        data: { name: dto.name, slug, createdBy: userId },
      });
      const membership = await tx.membership.create({
        data: {
          userId,
          organizationId: organization.id,
          role: Role.ADMIN,
          status: 'ACTIVE',
          lastAccessedAt: new Date(),
        },
      });

      return { organization, role: membership.role };
    });
  }

  async update(orgId: string, dto: UpdateOrganizationDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.organization.findUnique({
        where: { id: orgId },
      });
      if (!existing) {
        throw new NotFoundException('Organization not found.');
      }

      const slug = await this.slugService.generateUniqueOrgSlug(
        tx,
        dto.name,
        orgId,
      );

      return tx.organization.update({
        where: { id: orgId },
        data: { name: dto.name, slug },
      });
    });
  }
}
