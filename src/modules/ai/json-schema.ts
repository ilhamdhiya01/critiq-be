import { JsonSchema } from './ai-provider.interface';

// OpenAI `strict: true` function calling only accepts a schema where every
// object lists all of its properties as required and forbids extra ones.
// An optional property keeps its meaning by becoming nullable instead.
// Callers keep writing ordinary JSON Schema; only the OpenAI adapters send
// this variant.
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };

  const properties = schema.properties as
    Record<string, JsonSchema> | undefined;
  if (schema.type === 'object' && properties) {
    const required = new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    const strictProperties: Record<string, JsonSchema> = {};
    for (const [name, property] of Object.entries(properties)) {
      const strict = toStrictSchema(property);
      if (!required.has(name) && typeof strict.type === 'string') {
        strict.type = [strict.type, 'null'];
      }
      strictProperties[name] = strict;
    }
    out.properties = strictProperties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }

  if (schema.items && typeof schema.items === 'object') {
    out.items = toStrictSchema(schema.items as JsonSchema);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      out[key] = (schema[key] as JsonSchema[]).map(toStrictSchema);
    }
  }
  return out;
}
