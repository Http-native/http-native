// Create a basic HTTP server
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello from Bun!");
  },
});

console.log(`Listening on ${server.url}`);
