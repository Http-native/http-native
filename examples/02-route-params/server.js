/**
 * 02 — Route Parameters
 *
 * Demonstrates parameterized routes with :param syntax.
 * Parameters are extracted from the URL path and available
 * via req.params.
 *
 * Run:
 *   bun examples/02-route-params/server.js
 *
 * Test:
 *   curl http://localhost:3000/users/42
 *   curl http://localhost:3000/posts/7/comments/3
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Single parameter route.
 * GET /users/42 → { id: "42", type: "user" }
 */
app.get("/users/:id", (req, res) => {
    res.json({
        id: req.params.id,
        type: "user",
    });
});

/**
 * Multiple parameters in a single route.
 * GET /posts/7/comments/3 → { postId: "7", commentId: "3" }
 */
app.get("/posts/:postId/comments/:commentId", (req, res) => {
    res.json({
        postId: req.params.postId,
        commentId: req.params.commentId,
    });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
