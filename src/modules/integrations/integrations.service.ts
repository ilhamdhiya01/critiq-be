import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { ConnectGitlabDto } from './dto/connect-gitlab.dto';
import { GitlabConnectionResponseDto } from './dto/gitlab-connection-response.dto';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
  ) {}

  async connectGitlab(
    organizationId: string,
    dto: ConnectGitlabDto,
  ): Promise<GitlabConnectionResponseDto> {
    this.logger.info(
      `attempting to connect GitLab instance: org=${organizationId} instanceUrl=${dto.instanceUrl}`,
    );
    await this.verifyGitlabToken(dto.instanceUrl, dto.personalAccessToken);

    const encryptedPat = this.encryptionService.encrypt(
      dto.personalAccessToken,
    );

    const existing = await this.prisma.gitlabConnection.findFirst({
      where: { organizationId, instanceUrl: dto.instanceUrl },
    });

    const connection = existing
      ? await this.prisma.gitlabConnection.update({
          where: { id: existing.id },
          data: { encryptedPat },
        })
      : await this.prisma.gitlabConnection.create({
          data: { organizationId, instanceUrl: dto.instanceUrl, encryptedPat },
        });

    return new GitlabConnectionResponseDto(connection);
  }

  private async verifyGitlabToken(
    instanceUrl: string,
    personalAccessToken: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.get(`${instanceUrl}/api/v4/user`, {
          headers: { 'PRIVATE-TOKEN': personalAccessToken },
        }),
      );
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new UnprocessableEntityException(
          'Could not authenticate with GitLab using the provided instance URL and token.',
        );
      }
      throw error;
    }
  }
}
