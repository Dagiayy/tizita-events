import { z, ZodTypeAny } from 'zod';

/** Validates and returns typed input; ZodError is mapped to a 400 by AllExceptionsFilter. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

export const uuid = z.string().uuid();
export const locale = z.enum(['en', 'am']);
export const isoDate = z.string().datetime({ offset: true });
