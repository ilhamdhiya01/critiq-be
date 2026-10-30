import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { SlugService } from '../../common/slug/slug.service';
import { Role } from '../../generated/prisma/enums';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

// Any signed-in user can create organizations; bounded so it cannot be used
// to flood the table (CLAUDE.md "Keamanan").
const ORG_CREATE_RATE_LIMIT = 10;
const ORG_CREATE_RATE_WINDOW_SECONDS = 3600;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugService: SlugService,
    private readonly realtime: RealtimePublisher,
    private readonly rateLimiter: RateLimiterService,
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
    const allowed = await this.rateLimiter.tryConsume(
      `ratelimit:org-create:user:${userId}`,
      ORG_CREATE_RATE_LIMIT,
      ORG_CREATE_RATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'name', message: 'org_create_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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
    const updated = await this.prisma.$transaction(async (tx) => {
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
    await this.realtime.publish({
      type: 'settings.updated',
      orgId,
      area: 'organization',
    });
    return updated;
  }
}
