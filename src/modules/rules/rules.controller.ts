import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role, RuleTier } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';
import { UpdateRuleTierDto } from './dto/rules.dto';
import { RulesService } from './rules.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// The quality profile (Rules & Profiles). Every member may read it — the PR
// page explains what was checked — only an Admin may change it.
@Controller('orgs/:orgId/rules')
export class RulesController {
  constructor(private readonly rulesService: RulesService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('Rules retrieved successfully')
  get(@Param('orgId') orgId: string) {
    return this.rulesService.get(orgId);
  }

  @Patch()
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Rule updated')
  update(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Body() dto: UpdateRuleTierDto,
  ) {
    return this.rulesService.setTier(
      orgId,
      { userId: req.user.sub, role: Role.ADMIN },
      dto.tier.toUpperCase() as RuleTier,
      dto.enabled,
    );
  }
}
