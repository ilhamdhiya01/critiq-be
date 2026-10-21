import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function setup() {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const logError = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  const filter = new HttpExceptionFilter();
  const send = (exception: unknown) => {
    filter.catch(exception, host);
    const [body] = response.json.mock.calls[0] as [{ errors: unknown }];
    const [status] = response.status.mock.calls[0] as [number];
    return { status, errors: body.errors };
  };
  return { send, logError };
}

describe('HttpExceptionFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the status and message of an HTTP exception', () => {
    const { send, logError } = setup();
    expect(send(new NotFoundException('Organization not found.'))).toEqual({
      status: HttpStatus.NOT_FOUND,
      errors: [{ field: '', message: 'Organization not found.' }],
    });
    expect(logError).not.toHaveBeenCalled();
  });

  // ValidationPipe reports every failed constraint as an array.
  it('turns each validation message into its own error', () => {
    const { send } = setup();
    expect(
      send(new BadRequestException(['q must be a string', 'limit too big']))
        .errors,
    ).toEqual([
      { field: '', message: 'q must be a string' },
      { field: '', message: 'limit too big' },
    ]);
  });

  it('carries the field of a domain error', () => {
    const { send } = setup();
    expect(
      send(
        new UnprocessableEntityException({
          message: 'token_invalid',
          field: 'token',
        }),
      ).errors,
    ).toEqual([{ field: 'token', message: 'token_invalid' }]);
  });

  it('accepts a plain string body', () => {
    const { send } = setup();
    expect(send(new HttpException('Too many', 429))).toEqual({
      status: 429,
      errors: [{ field: '', message: 'Too many' }],
    });
  });

  it('falls back to a generic message for a body without one', () => {
    const { send } = setup();
    expect(send(new HttpException({ code: 'x' }, 409)).errors).toEqual([
      { field: '', message: 'Unexpected error' },
    ]);
  });

  // Internal details (SQL, stack, provider replies) stay in the log.
  it('answers 500 without the internal message for anything else', () => {
    const { send, logError } = setup();
    const error = new Error('relation "users" does not exist');
    expect(send(error)).toEqual({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errors: [{ field: '', message: 'Internal server error' }],
    });
    expect(logError).toHaveBeenCalledWith(error.stack);
  });

  it('logs a thrown non-error value as is', () => {
    const { send, logError } = setup();
    expect(send('boom').status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(logError).toHaveBeenCalledWith('boom');
  });
});
