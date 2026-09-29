import Ajv, { ValidateFunction } from 'ajv';
import { JsonSchema } from './ai-provider.interface';

// A model's tool input is untrusted until it matches the schema we asked
// for — even with native tool calling, fields can go missing or change type.
const ajv = new Ajv({ allErrors: false, strict: false });
const compiled = new WeakMap<JsonSchema, ValidateFunction>();

export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate(value);
}
