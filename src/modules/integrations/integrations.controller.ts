import { Body, Controller, Param, Post } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { Role } from '../../generated/prisma/enums';

@Controller('orgs/:orgId/integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('gitlab')
  @OrgAuth([Role.ADMIN])
  connectGitlab(@Param('orgId') orgId: string, @Body() dto: ConnectGitlabDto) {
    return this.integrationsService.connectGitlab(orgId, dto);
  }
}
