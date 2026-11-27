import { RequestValidationError } from '@hk/platform/errors';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates and converts one part of a request with a Zod schema. On failure
 * it throws RequestValidationError, which becomes a 400 that lists every
 * invalid field.
 *
 *   @Post()
 *   create(@Body(new ZodValidationPipe(createInvoiceSchema)) input: CreateInvoice) {}
 *
 * The handler receives the schema's output, so defaults and transforms have
 * been applied and unknown keys are gone (unless the schema keeps them).
 */
export class ZodValidationPipe<Schema extends z.ZodType>
  implements PipeTransform<unknown, z.output<Schema>>
{
  constructor(private readonly schema: Schema) {}

  transform(value: unknown): z.output<Schema> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new RequestValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }
}
