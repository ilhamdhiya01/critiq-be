import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { ReposService } from './repos.service';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Provider, Role } from '../../generated/prisma/enums';

// Separate controller (not folded into ReposController) purely because its
// URL prefix is `.../integrations/:source/repos/...`, not `.../repos/...`
// — this is the wizard's step-2 lazy branch fetch for a repo that hasn't
// been connected yet (no Repository row exists to look up). ReposService
// stays the single owner of all branch-listing logic either way.
@Controller('orgs/:orgId/integrations/:source/repos/:providerRepoId')
export class IntegrationRepoBranchesController {
  constructor(private readonly reposService: ReposService) {}

  // Admin only — consistent with GET .../integrations/:source/candidates,
  // since only an Admin can reach the connect flow this feeds.
  @Get('branches')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Branches retrieved successfully')
  getBranches(
    @Param('orgId') orgId: string,
    @Param('source') source: string,
    @Param('providerRepoId') providerRepoId: string,
  ) {
    const provider = this.parseSource(source);
    return this.reposService.getBranchesForCandidate(
      orgId,
      provider,
      providerRepoId,
    );
  }

  private parseSource(source: string): Provider {
    const upper = source.toUpperCase();
    if (upper === Provider.GITHUB || upper === Provider.GITLAB) {
      return upper;
    }
    throw new BadRequestException(
      `Unknown source "${source}" — expected "github" or "gitlab".`,
    );
  }
}
