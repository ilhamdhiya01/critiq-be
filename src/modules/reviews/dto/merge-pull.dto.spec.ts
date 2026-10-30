import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MergePullDto } from './merge-pull.dto';

const errorsFor = (body: Record<string, unknown>) =>
  validate(plainToInstance(MergePullDto, body));

describe('MergePullDto', () => {
  it('accepts no override and an override with a reason', async () => {
    expect(await errorsFor({ headSha: 'abc' })).toHaveLength(0);
    expect(
      await errorsFor({
        headSha: 'abc',
        overrideCritical: { reason: 'hotfix' },
      }),
    ).toHaveLength(0);
  });

  // @IsOptional would let these through unvalidated.
  it.each([[null], [true], [{}], [{ reason: '' }]])(
    'rejects overrideCritical %p',
    async (overrideCritical) => {
      expect(
        (await errorsFor({ headSha: 'abc', overrideCritical })).length,
      ).toBeGreaterThan(0);
    },
  );
});
