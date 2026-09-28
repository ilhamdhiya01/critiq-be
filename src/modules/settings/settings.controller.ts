import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';
import type { JwtPayload } from '../auth/auth.service';
import { TestAiSettingsDto } from './dto/test-ai-settings.dto';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';
import { SettingsService } from './settings.service';

interface RequestWithSession extends Request {
  user: JwtPayload;
}

// Admin-only throughout: this is where the organization's AI credentials
// and its consent to send diffs to a provider live. Reviewer/Viewer get 403
// from OrgRolesGuard (step 2 opens a minimal read-only view).
@Controller('orgs/:orgId/settings/ai')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('AI settings retrieved successfully')
  getAi(@Param('orgId') orgId: string) {
    return this.settingsService.getAi(orgId);
  }

  @Put()
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('AI settings updated')
  updateAi(
    @Req() req: RequestWithSession,
    @Param('orgId') orgId: string,
    @Body() dto: UpdateAiSettingsDto,
  ) {
    return this.settingsService.updateAi(orgId, req.user.sub, dto);
  }

  // 200 whether or not the provider call succeeds — the outcome is the
  // body's `ok`; only a rate limit (429) or invalid input is an HTTP error.
  @Post('test')
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('AI connection tested')
  testAi(@Param('orgId') orgId: string, @Body() dto: TestAiSettingsDto) {
    return this.settingsService.testAi(orgId, dto);
  }
}
