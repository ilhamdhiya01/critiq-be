import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';
import { WebResponse } from '../types/web-response';

const DEFAULT_MESSAGE = 'Success';

// Wraps every controller return value as { data, message } — mirrors
// HttpExceptionFilter's { errors: [...] } shape on the failure side, so
// callers get one consistent envelope regardless of outcome. Controllers
// keep returning plain values/DTOs; only endpoints using @Res() for manual
// redirects (OAuth callbacks) bypass this entirely, since there's no return
// value for the interceptor to touch in that case.
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  WebResponse<T>
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<WebResponse<T>> {
    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_MESSAGE;

    return next.handle().pipe(map((data) => ({ data, message })));
  }
}
