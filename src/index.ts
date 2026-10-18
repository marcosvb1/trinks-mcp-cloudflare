import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env";
import { registerTrinksTools } from "./tools";
import { verifyAccessJwt } from "./access";
import { ConfigError, loadUnidades } from "./trinks-client";

const MCP_ROUTE = "/mcp";

/**
 * Build a fresh server per request. Required by @modelcontextprotocol/sdk 1.26+:
 * a shared/global McpServer can leak one client's responses to another.
 */
function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "trinks-mcp-server", version: "0.2.0" });
  registerTrinksTools(server, env, loadUnidades(env));
  return server;
}

/** Length-checked, constant-time-ish compare so we don't leak the secret via timing. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function unauthorized(message = "Unauthorized"): Response {
  return jsonRpcError(401, -32001, message);
}

/**
 * Authorize a request. Two modes, decided by config:
 *   - Cloudflare Access (prod): if ACCESS_* is set, require a valid Access JWT.
 *   - Shared secret (dev): else require the `x-mcp-secret` header.
 * Fails closed if neither is configured.
 * Returns null when allowed, or a 401 Response when denied.
 */
async function authorize(request: Request, env: Env): Promise<Response | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const email = await verifyAccessJwt(request, env);
    return email ? null : unauthorized("Missing or invalid Cloudflare Access token");
  }
  const expected = env.MCP_SHARED_SECRET;
  const provided = request.headers.get("x-mcp-secret") ?? "";
  if (expected && secretMatches(provided, expected)) return null;
  return unauthorized();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe — unauthenticated, leaks nothing.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("trinks-mcp-server up\n", { status: 200 });
    }

    if (url.pathname !== MCP_ROUTE) {
      return new Response("Not found\n", { status: 404 });
    }

    const denied = await authorize(request, env);
    if (denied) return denied;

    let server: McpServer;
    try {
      server = createServer(env);
    } catch (err) {
      // Only reached by authorized callers, so naming the bad setting is fine.
      if (err instanceof ConfigError) return jsonRpcError(500, -32603, err.message);
      throw err;
    }
    return createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);
  },
};
