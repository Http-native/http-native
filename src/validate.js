/**
 * http-native Validation Middleware
 *
 * Schema-agnostic: works with Zod, TypeBox, Yup, Joi, or any object
 * that exposes .parse(), .safeParse(), or .validate().
 *
 * @example
 *   import { validate } from "http-native/validate";
 *   import { z } from "zod";
 *
 *   app.post("/users", validate({
 *     body: z.object({ name: z.string(), email: z.string().email() }),
 *   }), async (req, res) => {
 *     const { name, email } = req.validatedBody;
 *     res.json({ ok: true, name, email });
 *   });
 */

/**
 * Create a validation middleware that parses and validates request
 * data against the provided schemas before the route handler runs.
 *
 * Validated results are placed on the request object:
 *   - req.validatedParams (if params schema provided)
 *   - req.validatedQuery  (if query schema provided)
 *   - req.validatedBody   (if body schema provided)
 *
 * @param {Object} schema
 * @param {Object} [schema.body]   - Schema to validate req.json() against
 * @param {Object} [schema.query]  - Schema to validate req.query against
 * @param {Object} [schema.params] - Schema to validate req.params against
 * @returns {Function} Async middleware: (req, res, next) => Promise<void>
 */
export function validate(schema = {}) {
  const { body: bodySchema, query: querySchema, params: paramsSchema } = schema;

  return async function validationMiddleware(req, res, next) {
    try {
      if (paramsSchema) {
        const result = parseSchema(paramsSchema, req.params, "params");
        if (result.error) {
          res.status(400).json({
            error: "Validation Error",
            field: "params",
            details: result.error,
          });
          return;
        }
        req.validatedParams = result.value;
      }

      if (querySchema) {
        const result = parseSchema(querySchema, req.query, "query");
        if (result.error) {
          res.status(400).json({
            error: "Validation Error",
            field: "query",
            details: result.error,
          });
          return;
        }
        req.validatedQuery = result.value;
      }

      if (bodySchema) {
        const bodyData = req.json();
        if (bodyData === null && bodySchema) {
          res.status(400).json({
            error: "Validation Error",
            field: "body",
            details: "Request body is required",
          });
          return;
        }

        const result = parseSchema(bodySchema, bodyData, "body");
        if (result.error) {
          res.status(400).json({
            error: "Validation Error",
            field: "body",
            details: result.error,
          });
          return;
        }
        req.validatedBody = result.value;
      }

      await next();
    } catch (error) {
      res.status(400).json({
        error: "Validation Error",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Parse data against a schema, supporting multiple schema-library formats:
 *   - Zod safeParse: schema.safeParse(data) → { success, data, error }
 *   - Zod / TypeBox parse: schema.parse(data) throws on failure
 *   - Joi validate: schema.validate(data) → { value, error }
 *
 * @param {Object} schema     - Schema object with .parse(), .safeParse(), or .validate()
 * @param {*}      data       - The data to validate
 * @param {string} _fieldName - Field name for diagnostics (reserved for future use)
 * @returns {{ value: *|null, error: *|null }}
 * @throws {TypeError} If the schema has no recognized parse method
 */
function parseSchema(schema, data, _fieldName) {
  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);
    if (result.success) {
      return { value: result.data, error: null };
    }
    const details = result.error?.issues
      ? result.error.issues.map((issue) => ({
          path: issue.path?.join(".") ?? "",
          message: issue.message,
        }))
      : result.error?.message ?? "Validation failed";
    return { value: null, error: details };
  }

  if (typeof schema.parse === "function") {
    try {
      const value = schema.parse(data);
      return { value, error: null };
    } catch (error) {
      if (error?.issues) {
        const details = error.issues.map((issue) => ({
          path: issue.path?.join(".") ?? "",
          message: issue.message,
        }));
        return { value: null, error: details };
      }
      return { value: null, error: error?.message ?? "Validation failed" };
    }
  }

  if (typeof schema.validate === "function") {
    const result = schema.validate(data);
    if (result.error) {
      const details = result.error.details
        ? result.error.details.map((detail) => ({
            path: detail.path?.join(".") ?? "",
            message: detail.message,
          }))
        : result.error.message ?? "Validation failed";
      return { value: null, error: details };
    }
    return { value: result.value, error: null };
  }

  throw new TypeError(
    "Schema must have a .parse(), .safeParse(), or .validate() method",
  );
}
