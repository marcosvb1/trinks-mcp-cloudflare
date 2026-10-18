/** Secrets Store binding — value must be read with `await binding.get()`. */
export interface SecretsStoreSecret {
  get(): Promise<string>;
}

export interface Env {
  // ── Trinks credentials: one of two modes ──────────────────────────────────
  // Multi-unit → TRINKS_UNIDADES maps each unit (a separate Trinks account) to
  // its establishment id and the name of the binding holding its API key:
  //   { "matriz": { "estabelecimentoId": "123", "apiKey": "TRINKS_MATRIZ_APIKEY" } }
  // The key binding can be a Worker secret or a Secrets Store binding.
  // Single unit → leave TRINKS_UNIDADES unset and use the two vars below.

  /** Unit map — a JSON object in `wrangler.jsonc` vars, or a JSON string in `.dev.vars`. */
  TRINKS_UNIDADES?: string | Record<string, unknown>;
  /** Default unit when a tool call omits `unidade`. Defaults to the first one in TRINKS_UNIDADES. */
  TRINKS_UNIDADE_PADRAO?: string;

  /** Trinks API key, sent as the `X-Api-Key` header (single-unit mode). */
  TRINKS_API_KEY?: string;
  /** Establishment id, sent as the `estabelecimentoId` header (single-unit mode). */
  TRINKS_ESTABELECIMENTO_ID?: string;

  // ── Auth: one of two modes ────────────────────────────────────────────────
  // Production → Cloudflare Access (Managed OAuth): set both ACCESS_* and the
  // Worker requires a valid `Cf-Access-Jwt-Assertion`. Dev / no-Access → leave
  // ACCESS_* unset and use the shared-secret header. If neither is configured,
  // the server fails closed (denies everything).

  /** Access team domain, e.g. `https://SEU-TIME.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;

  /** Application Audience (AUD) tag of the Access MCP application. */
  ACCESS_AUD?: string;

  /** Shared secret for the `x-mcp-secret` header (dev / no-Access fallback). */
  MCP_SHARED_SECRET?: string;
}
