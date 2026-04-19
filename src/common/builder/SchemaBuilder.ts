export type SchemaNode = Record<string, unknown>;

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  format?: string;
  nullable?: boolean;
}

/** Options accepted by `SchemaBuilder.object()`. */
export interface ObjectOptions {
  /** Names of required properties. */
  required?: string[];
  nullable?: boolean;
  additionalProperties?: boolean;
}

/**
 * SchemaBuilder
 *
 * A small, instantiable DSL for constructing JSON Schema nodes.
 * Produces plain objects that are fully compatible with Fastify's AJV validator
 * and fast-json-stringify serialiser.
 *
 * Instantiated once inside `AuthSchemas` and stored as a private dependency.
 * Can be reused across any other schema class in the project.
 *
 * @example
 *   const S = new SchemaBuilder();
 *   S.string({ minLength: 8 })   // → { type: 'string', minLength: 8 }
 *   S.object({ id: S.string() }) // → { type: 'object', properties: { id: { type: 'string' } } }
 */
export class SchemaBuilder {
  /**
   * Produces a JSON Schema `string` node.
   * Only defined options are included in the output — no undefined keys.
   *
   * @param opts - Optional length constraints, format, and nullability.
   */
  string(opts: StringOptions = {}): SchemaNode {
    return {
      type: 'string',
      ...(opts.minLength !== undefined && { minLength: opts.minLength }),
      ...(opts.maxLength !== undefined && { maxLength: opts.maxLength }),
      ...(opts.format && { format: opts.format }),
      ...(opts.nullable && { nullable: true }),
    };
  }

  boolean(): SchemaNode {
    return { type: 'boolean' };
  }

  array(items: SchemaNode, opts: ObjectOptions = {}): SchemaNode {
    return {
      type: 'array',
      items,
      ...(opts.nullable && { nullable: true }),
      ...(opts.required && { required: opts.required }),
      ...(opts.additionalProperties !== undefined && {
        additionalProperties: opts.additionalProperties,
      }),
    };
  }

  /**
   * Produces a JSON Schema `object` node.
   *
   * @param properties - Map of property name → schema node.
   * @param opts       - Optional `required` list and `additionalProperties` flag.
   */
  object(
    properties: Record<string, SchemaNode>,
    opts: ObjectOptions = {},
  ): SchemaNode {
    return {
      type: 'object',
      properties,
      ...(opts.required && { required: opts.required }),
      ...(opts.additionalProperties !== undefined && {
        additionalProperties: opts.additionalProperties,
      }),
    };
  }
}

export default SchemaBuilder;
