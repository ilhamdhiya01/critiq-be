import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchQueryDto } from './search.dto';

const errorsFor = (query: Record<string, unknown>) =>
  validate(plainToInstance(SearchQueryDto, query));

describe('SearchQueryDto', () => {
  it('accepts text and a limit up to 10', async () => {
    expect(await errorsFor({ q: 'pay', limit: '10' })).toHaveLength(0);
  });

  it.each([
    [{}],
    [{ q: '   ' }],
    [{ q: 'x'.repeat(101) }],
    [{ q: 'pay', limit: '11' }],
    [{ q: 'pay', limit: '0' }],
  ])('rejects %p', async (query) => {
    expect((await errorsFor(query)).length).toBeGreaterThan(0);
  });

  it('trims the text', () => {
    expect(plainToInstance(SearchQueryDto, { q: '  pay ' }).q).toBe('pay');
  });
});
