import { timingSafeEqual } from 'crypto';
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { HealthService } from './health.service';

// Public on purpose (no @OrgAuth): load balancers, docker and uptime
// monitors call it without a session. Detail needs HEALTH_TOKEN.
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService,
  ) {}

  // 503 only when the app cannot serve at all (database or Redis down);
  // `degraded` (no worker) is still 200 — restarting the app would not help.
  @Get()
  @Header('Cache-Control', 'no-store')
  @ResponseMessage('Health checked')
  async check(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const health = await this.healthService.check(
      this.hasValidToken(authorization),
    );
    if (health.status === 'down') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }

  private hasValidToken(authorization: string | undefined): boolean {
    const token = this.configService.get<string>('health.token') ?? '';
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!token || !provided) {
      return false;
    }
    const expected = Buffer.from(token);
    const actual = Buffer.from(provided);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}
