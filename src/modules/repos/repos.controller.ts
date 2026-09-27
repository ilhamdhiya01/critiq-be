import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ReposService } from './repos.service';
import { UpdateScanConfigDto } from './dto/update-scan-config.dto';
import { CreateReposDto } from './dto/create-repos.dto';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import { AuthService } from '../auth/auth.service';
import type { JwtPayload } from '../auth/auth.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

@Controller('orgs/:orgId/repos')
export class ReposController {
  constructor(
    private readonly reposService: ReposService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Repositories retrieved successfully')
  list(@Param('orgId') orgId: string) {
    return this.reposService.list(orgId);
  }

  @Get(':id')
  @OrgAuth([])
  @ResponseMessage('Repository retrieved successfully')
  getDetail(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.reposService.getDetail(orgId, id);
  }

  @Get(':id/branches')
  @OrgAuth([])
  @ResponseMessage('Repository branches retrieved successfully')
  getBranches(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.reposService.getBranchesForRepo(orgId, id);
  }

  @Get(':id/scan-config')
  @OrgAuth([])
  @ResponseMessage('Scan config retrieved successfully')
  getScanConfig(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.reposService.getScanConfig(orgId, id);
  }

  // Admin only — changing which branches are scanned is a repo-config
  // mutation, same gating rationale as connecting/disconnecting.
  @Put(':id/scan-config')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Scan config updated successfully')
  updateScanConfig(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateScanConfigDto,
  ) {
    return this.reposService.updateScanConfig(orgId, id, dto);
  }

  // Admin only, same gating as every other repo-config mutation: this
  // enqueues real work against the org's provider rate limits.
  //
  // `?stale=1` is the mode this exists for — re-scan only the open PRs
  // whose last result predates the current ruleset. Without it, every open
  // PR is re-scanned. Deliberately admin-triggered per repo rather than
  // automatic on deploy, so a ruleset bump doesn't start a scan wave
  // across every organization at once.
  @Post(':id/rescan')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Rescan enqueued')
  rescan(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Query('stale') stale?: string,
  ) {
    return this.reposService.rescanOpenPulls(orgId, id, stale === '1');
  }

  // Finishing the wizard is an Admin action (F2), same as connecting a
  // GitLab/GitHub integration itself.
  @Post()
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Repositories connected')
  async createRepos(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Body() dto: CreateReposDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reposService.createRepos(orgId, dto);

    // Connecting the first repo flips Organization.onboardingCompleted
    // (ReposService.createRepos), which the session token carries — so the
    // token the caller holds is stale the moment this succeeds. Reissuing
    // here keeps the FE from bouncing a just-onboarded admin back into the
    // wizard until their next login.
    //
    // The flag is read back from the database rather than inferred from
    // `result.items`: it only flips inside the per-repo transaction, so a
    // request where every item failed (e.g. all already_connected) must
    // leave the token's value alone.
    const onboardingCompleted =
      await this.reposService.isOnboardingCompleted(orgId);
    if (onboardingCompleted !== req.user.onboardingCompleted) {
      // Fields are copied one by one rather than spread from req.user: that
      // object is a *decoded* token, so it also carries the registered `iat`
      // and `exp` claims, and jsonwebtoken refuses to sign a payload that
      // already has `exp` while JwtModule supplies `expiresIn` ("Bad
      // options.expiresIn option the payload already has an exp property").
      const token = this.authService.issueSessionToken({
        sub: req.user.sub,
        activeOrgId: req.user.activeOrgId,
        role: req.user.role,
        provider: req.user.provider,
        onboardingCompleted,
      });
      // Kept in sync with auth.controller.ts's session cookie settings.
      res.cookie('session', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000,
      });
    }

    return result;
  }
}
