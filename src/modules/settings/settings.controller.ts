import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
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

// Admin-only for writes and the test: this is where the organization's AI
// credentials and its consent to send diffs to a provider live.
// Reviewer/Viewer may GET a minimal view (provider, model, consent, locale)
// — enough for the PR page to explain why there is no AI summary.
@Controller('orgs/:orgId/settings/ai')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @OrgAuth([])
  @ResponseMessage('AI settings retrieved successfully')
  getAi(@Req() req: RequestWithSession, @Param('orgId') orgId: string) {
    return this.settingsService.getAiForMember(orgId, req.user.sub);
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
  @HttpCode(HttpStatus.OK)
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('AI connection tested')
  testAi(@Param('orgId') orgId: string, @Body() dto: TestAiSettingsDto) {
    return this.settingsService.testAi(orgId, dto);
  }
}
