import { z } from "zod";
import type { Env, SecretsStoreSecret } from "./env";

const BASE_URL = "https://api.trinks.com";
const TIMEOUT_MS = 30_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TrinksRequest {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, unknown>;
}

/** Non-2xx (or transport) failure from Trinks; `message` is already agent-actionable. */
export class TrinksError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TrinksError";
    this.status = status;
  }
}

/** A configuration problem in this deployment (not a Trinks API failure). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** One unit = one Trinks account: its establishment id + the binding holding its API key. */
export interface UnidadeConfig {
  estabelecimentoId: string;
  /** Name of the Worker secret or Secrets Store binding with this unit's API key. */
  apiKey: string;
}

export interface Unidades {
  /** Unit names, default first. */
  nomes: [string, ...string[]];
  padrao: string;
  config: Record<string, UnidadeConfig>;
}

const UnidadesSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "nome de unidade: minúsculas, dígitos e hífen"),
  z.object({
    estabelecimentoId: z.coerce.string().min(1),
    apiKey: z.string().min(1),
  }),
);

/** Name of the only unit in single-unit mode (TRINKS_API_KEY / TRINKS_ESTABELECIMENTO_ID). */
const UNIDADE_UNICA = "principal";

/**
 * Read the unit map from config. Multi-unit: TRINKS_UNIDADES. Single unit:
 * TRINKS_API_KEY + TRINKS_ESTABELECIMENTO_ID. Throws ConfigError when neither is usable.
 */
export function loadUnidades(env: Env): Unidades {
  const raw = env.TRINKS_UNIDADES;
  if (raw === undefined || raw === "") {
    if (!env.TRINKS_ESTABELECIMENTO_ID) {
      throw new ConfigError(
        "Nenhuma unidade Trinks configurada: defina TRINKS_UNIDADES, ou TRINKS_API_KEY + TRINKS_ESTABELECIMENTO_ID.",
      );
    }
    return {
      nomes: [UNIDADE_UNICA],
      padrao: UNIDADE_UNICA,
      config: { [UNIDADE_UNICA]: { estabelecimentoId: env.TRINKS_ESTABELECIMENTO_ID, apiKey: "TRINKS_API_KEY" } },
    };
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigError("TRINKS_UNIDADES não é um JSON válido.");
    }
  }
  const result = UnidadesSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`TRINKS_UNIDADES inválido: ${z.prettifyError(result.error)}`);
  }

  const config = result.data;
  const [primeira, ...demais] = Object.keys(config);
  if (!primeira) throw new ConfigError("TRINKS_UNIDADES não tem nenhuma unidade.");
  const padrao = env.TRINKS_UNIDADE_PADRAO || primeira;
  if (!config[padrao]) {
    throw new ConfigError(`TRINKS_UNIDADE_PADRAO "${padrao}" não existe em TRINKS_UNIDADES.`);
  }
  const outras = [primeira, ...demais].filter((n) => n !== padrao);
  return { nomes: [padrao, ...outras], padrao, config };
}

/** Read a binding that holds a secret: a plain Worker secret (string) or a Secrets Store binding. */
async function readSecret(env: Env, binding: string): Promise<string | undefined> {
  const value = (env as unknown as Record<string, unknown>)[binding];
  if (typeof value === "string") return value || undefined;
  if (value && typeof (value as SecretsStoreSecret).get === "function") {
    return (value as SecretsStoreSecret).get();
  }
  return undefined;
}

/** Build a client with the credentials of one unit. */
export async function clientForUnidade(env: Env, unidades: Unidades, nome: string): Promise<TrinksClient> {
  const cfg = unidades.config[nome];
  if (!cfg) {
    throw new TrinksError(0, `Unidade "${nome}" não configurada. Opções: ${unidades.nomes.join(", ")}.`);
  }
  const apiKey = await readSecret(env, cfg.apiKey);
  if (!apiKey) {
    throw new TrinksError(0, `Unidade "${nome}": a API key (${cfg.apiKey}) não está configurada neste ambiente.`);
  }
  return new TrinksClient(apiKey, cfg.estabelecimentoId);
}

/**
 * Thin client for the Trinks REST API. Auth is `X-Api-Key` + an `estabelecimentoId`
 * header, matching the official OpenAPI spec (https://api.trinks.com/swagger/v1/swagger.json). One instance
 * per request — cheap, holds no mutable state.
 */
export class TrinksClient {
  readonly #apiKey: string;
  readonly #establishmentId: string;

  constructor(apiKey: string, establishmentId: string) {
    this.#apiKey = apiKey;
    this.#establishmentId = establishmentId;
  }

  /** The establishment id used for this session (handy for tools that echo it). */
  get establishmentId(): string {
    return this.#establishmentId;
  }

  async request<T = unknown>(path: string, opts: TrinksRequest = {}): Promise<T> {
    const { method = "GET", body, params } = opts;

    let url = `${BASE_URL}${path}`;
    if (params) {
      const entries = Object.entries(params).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      );
      if (entries.length) {
        const qs = new URLSearchParams(
          entries.map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString();
        url += `?${qs}`;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": this.#apiKey,
          estabelecimentoId: this.#establishmentId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TrinksError(
          408,
          `Trinks timed out after ${TIMEOUT_MS / 1000}s on ${method} ${path}. Retry, or narrow the date range / pageSize.`,
        );
      }
      throw new TrinksError(
        0,
        `Network error reaching Trinks on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new TrinksError(res.status, describeError(res.status, method, path, text));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function describeError(status: number, method: string, path: string, body: string): string {
  const detail = body.slice(0, 300);
  switch (status) {
    case 400:
      return `Trinks rejected the request (400) on ${method} ${path} — check required fields and formats. Detail: ${detail}`;
    case 401:
      return `Trinks auth failed (401) — the API key for this unit is missing or invalid.`;
    case 403:
      return `Trinks denied access (403) on ${method} ${path} — the key lacks permission, or the establishment id is wrong.`;
    case 404:
      return `Trinks resource not found (404) on ${method} ${path} — check the id you passed.`;
    case 422:
      return `Trinks could not process the request (422) on ${method} ${path}. Detail: ${detail}`;
    case 429:
      return `Trinks rate limit hit (429) on ${method} ${path} — back off and retry.`;
    default:
      if (status >= 500) {
        return `Trinks server error (${status}) on ${method} ${path} — usually transient, retry later. Detail: ${detail}`;
      }
      return `Trinks request failed (${status}) on ${method} ${path}. Detail: ${detail}`;
  }
}
