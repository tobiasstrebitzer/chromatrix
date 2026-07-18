# @chromatrix/gateway (placeholder)

NestJS + `@silkweave/nestjs` server. **Not built yet** — scaffolded after spike **S1** proves the
mitigating CDP mux (see `docs/PRD.md` §6, §7).

Key constraint when it is built: the **CDP WebSocket mux must be mounted on the underlying `http.Server`
that Nest wraps**, so raw CDP frames bypass Nest's DI/interceptor/guard pipeline. Nest handles only the
management + MCP Action HTTP/MCP endpoints (provision identity, allocate tab → scoped CDP URL, health,
takeover). This mirrors Steel's Fastify separation; we keep the raw path deliberately outside Nest.
