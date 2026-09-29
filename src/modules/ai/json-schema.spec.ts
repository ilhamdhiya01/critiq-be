import { toStrictSchema } from './json-schema';

describe('toStrictSchema', () => {
  it('requires every property, forbids extras, and makes optionals nullable', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        note: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { file: { type: 'string' }, line: { type: 'integer' } },
            required: ['file'],
          },
        },
      },
      required: ['summary', 'findings'],
    });

    expect(strict.required).toEqual(['summary', 'note', 'findings']);
    expect(strict.additionalProperties).toBe(false);
    const properties = strict.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.note.type).toEqual(['string', 'null']);
    expect(properties.summary.type).toBe('string');

    const item = properties.findings.items as Record<string, unknown>;
    expect(item.required).toEqual(['file', 'line']);
    expect(item.additionalProperties).toBe(false);
    expect(
      (item.properties as Record<string, Record<string, unknown>>).line.type,
    ).toEqual(['integer', 'null']);
  });
});
