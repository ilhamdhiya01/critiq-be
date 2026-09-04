import { Body, Controller, Post } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { Auth } from '../../common/decorators/auth.decorator';
import { Role } from '../../generated/prisma/enums';

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('gitlab')
  @Auth([Role.ADMIN])
  connectGitlab(@Body() dto: ConnectGitlabDto) {
    return this.integrationsService.connectGitlab(dto);
  }
}
