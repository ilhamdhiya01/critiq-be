import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ReposService } from './repos.service';
import { UpdateScanConfigDto } from './dto/update-scan-config.dto';
import { CreateReposDto } from './dto/create-repos.dto';
import { OrgAuth } from '../../common/decorators/org-auth.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { Role } from '../../generated/prisma/enums';

@Controller('orgs/:orgId/repos')
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

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

  // Finishing the wizard is an Admin action (F2), same as connecting a
  // GitLab/GitHub integration itself.
  @Post()
  @OrgAuth([Role.ADMIN])
  @ResponseMessage('Repositories connected')
  createRepos(@Param('orgId') orgId: string, @Body() dto: CreateReposDto) {
    return this.reposService.createRepos(orgId, dto);
  }
}
