import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

export interface ApiError {
  field: string;
  message: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.resolveStatus(exception);
    const errors = this.resolveErrors(exception);

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
    }

    response.status(status).json({ errors });
  }

  private resolveStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private resolveErrors(exception: unknown): ApiError[] {
    if (exception instanceof HttpException) {
      return this.normalizeHttpExceptionResponse(exception.getResponse());
    }
    return [{ field: '', message: 'Internal server error' }];
  }

  private normalizeHttpExceptionResponse(body: string | object): ApiError[] {
    if (typeof body === 'string') {
      return [{ field: '', message: body }];
    }

    const anyBody = body as {
      message?: string | string[];
      field?: string;
    };

    if (Array.isArray(anyBody.message)) {
      return anyBody.message.map((message) => ({ field: '', message }));
    }

    if (typeof anyBody.message === 'string') {
      return [{ field: anyBody.field ?? '', message: anyBody.message }];
    }

    return [{ field: '', message: 'Unexpected error' }];
  }
}
