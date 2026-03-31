/**
 * 14 — Request Validation
 *
 * Demonstrates the built-in validation middleware that works
 * with Zod, TypeBox, Yup, Joi, or any schema library with
 * .parse(), .safeParse(), or .validate() methods.
 *
 * This example uses a minimal inline schema for zero dependencies.
 * Replace with Zod/TypeBox in production.
 *
 * Run:
 *   bun examples/14-validation/server.js
 *
 * Test:
 *   # Valid request
 *   curl -X POST -H "Content-Type: application/json" \
 *     -d '{"name":"Alice","email":"alice@example.com"}' \
 *     http://localhost:3000/users
 *
 *   # Invalid request (missing email)
 *   curl -X POST -H "Content-Type: application/json" \
 *     -d '{"name":"Alice"}' \
 *     http://localhost:3000/users
 *
 *   # Valid params
 *   curl http://localhost:3000/users/42
 *
 *   # Invalid params (non-numeric)
 *   curl http://localhost:3000/users/abc
 */

import { createApp } from "@http-native/core";
import { validate } from "@http-native/core/validate";

const app = createApp();

/**
 * Minimal schema helper — mimics Zod's .parse() interface.
 * In production, use: import { z } from "zod";
 */
function createSchema(validator) {
    return {
        parse(data) {
            const result = validator(data);
            if (result.error) {
                const err = new Error(result.error);
                err.issues = [{ path: [], message: result.error }];
                throw err;
            }
            return result.value;
        },
    };
}

/**
 * Body schema — validates name (string) and email (string with @).
 */
const createUserSchema = createSchema((data) => {
    if (!data || typeof data !== "object") {
        return { error: "Body must be an object" };
    }
    if (!data.name || typeof data.name !== "string") {
        return { error: "name must be a non-empty string" };
    }
    if (!data.email || typeof data.email !== "string" || !data.email.includes("@")) {
        return { error: "email must be a valid email address" };
    }
    return { value: { name: data.name, email: data.email } };
});

/**
 * Params schema — validates that id is a numeric string.
 */
const numericIdSchema = createSchema((data) => {
    if (!data || !data.id || !/^\d+$/.test(data.id)) {
        return { error: "id must be a numeric string" };
    }
    return { value: { id: data.id } };
});

/**
 * POST /users — validates the request body before the handler runs.
 * If validation fails, a 400 response is sent automatically.
 */
app.post(
    "/users",
    validate({ body: createUserSchema }),
    (req, res) => {
        const { name, email } = req.validatedBody;
        res.status(201).json({
            id: 1,
            name,
            email,
            message: "User created successfully",
        });
    },
);

/**
 * GET /users/:id — validates route params.
 */
app.get(
    "/users/:id",
    validate({ params: numericIdSchema }),
    (req, res) => {
        res.json({
            id: req.validatedParams.id,
            name: "Alice",
            email: "alice@example.com",
        });
    },
);

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
