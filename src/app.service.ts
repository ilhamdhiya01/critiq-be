import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@Injectable()
export class AppService {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private logger: Logger) {}
  getHello(): string {
    this.logger.info('Hello World!');
    return 'Hello World!';
  }
}
