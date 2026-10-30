import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  Injectable,
  Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard, IAuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { OAUTH_STATE_FAILURE } from './oauth-state.store';

// The OAuth `state` did not match the browser that started the login.
export class OAuthStateMismatchException extends Error {}

// AuthGuard for a provider's login callback that tells a state mismatch
// apart from any other refusal, so it can become a redirect (the callback
// is a browser navigation — a JSON 401 would be a dead end).
export function OAuthCallbackGuard(provider: string): Type<IAuthGuard> {
  @Injectable()
  class Guard extends AuthGuard(provider) {
    handleRequest<TUser>(
      err: unknown,
      user: TUser,
      info: unknown,
      context: ExecutionContext,
      status?: unknown,
    ): TUser {
      if (
        !err &&
        !user &&
        (info as { message?: unknown } | undefined)?.message ===
          OAUTH_STATE_FAILURE
      ) {
        throw new OAuthStateMismatchException();
      }
      return super.handleRequest(err, user, info, context, status);
    }
  }
  return Guard;
}

// Back to the FE login page, which says the attempt expired.
@Catch(OAuthStateMismatchException)
export class OAuthStateMismatchFilter implements ExceptionFilter {
  constructor(private readonly configService: ConfigService) {}

  catch(_exception: OAuthStateMismatchException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const feUrl = this.configService.getOrThrow<string>('feUrl');
    res.redirect(`${feUrl}/login?error=oauth_state`);
  }
}
