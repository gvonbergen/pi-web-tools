import { Type, type TSchema } from "typebox";

/**
 * Google-compatible string enum schema, identical in behavior to
 * `StringEnum` from `@earendil-works/pi-ai` (which pi bundles as a peer).
 * Replicated locally so unit tests and the type-checker do not require the
 * pi runtime packages; the produced schema is exactly
 * `{ type: "string", enum: values }` either way.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TSchema {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default !== undefined ? { default: options.default } : {}),
  });
}
