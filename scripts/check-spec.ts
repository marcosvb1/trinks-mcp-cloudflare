/**
 * Checks every tool against the official Trinks OpenAPI spec.
 *
 * Calls each tool twice (every field set, then only required ones) with a stubbed
 * `fetch`, and checks the request it builds: the method + path must be a spec
 * operation, query params must use the spec's exact names, the body must only use
 * spec fields and carry the required ones, and every tool arg must reach the
 * request. Also fails when a spec operation has no tool — i.e. Trinks added one.
 *
 *   npm run check:spec              # live spec
 *   npm run check:spec -- spec.json # local copy
 */
import { z } from "zod";
import { registerTrinksTools } from "../src/tools";
import { loadUnidades } from "../src/trinks-client";

const SPEC_URL = "https://api.trinks.com/swagger/v1/swagger.json";
const METHODS = ["get", "post", "put", "patch", "delete"];

async function loadSpec(): Promise<any> {
  const path = process.argv[2];
  if (path) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8"));
  }
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Could not download the spec (${res.status}) from ${SPEC_URL}`);
  return res.json();
}

const spec = await loadSpec();
const schemas = spec.components?.schemas ?? {};
const deref = (s: any): any => {
  while (s?.$ref) s = schemas[s.$ref.split("/").pop()];
  return s ?? {};
};

// Literal segments win over {params} (e.g. /lancamentos/categorias vs /lancamentos/{id}).
const ops = Object.entries<any>(spec.paths)
  .flatMap(([path, item]) =>
    Object.entries<any>(item)
      .filter(([m]) => METHODS.includes(m))
      .map(([m, op]) => ({
        key: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        op,
        re: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
        params: (path.match(/\{/g) ?? []).length,
      })),
  )
  .sort((a, b) => a.params - b.params);

// Fake MCP server that just collects the tools.
const tools: { name: string; shape: z.ZodRawShape; handler: (args: any) => Promise<any> }[] = [];
const server: any = {
  registerTool: (name: string, cfg: any, handler: any) => tools.push({ name, shape: cfg.inputSchema, handler }),
};
const env: any = { TRINKS_API_KEY: "test", TRINKS_ESTABELECIMENTO_ID: "1" };
registerTrinksTools(server, env, loadUnidades(env));

let sent: { method: string; url: URL; body: any } | null = null;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent = { method: init.method!, url: new URL(url), body: init.body ? JSON.parse(init.body as string) : undefined };
  return new Response("{}", { status: 200 });
}) as typeof fetch;

/** A valid value for a JSON Schema node, filling every optional field. */
function sample(s: any): any {
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sample(s.anyOf[0]);
  switch (s.type) {
    case "integer":
    case "number":
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case "boolean":
      return true;
    case "array":
      return [sample(s.items)];
    case "object":
      return Object.fromEntries(Object.entries<any>(s.properties ?? {}).map(([k, v]) => [k, sample(v)]));
    default:
      if (s.format === "email") return "a@b.co";
      if (s.pattern === "^\\d{11}$") return "12345678901";
      if (s.pattern) return "11";
      return "x".repeat(Math.max(s.minLength ?? 1, 3));
  }
}

const failures: string[] = [];
const fail = (tool: string, msg: string) => failures.push(`${tool}: ${msg}`);

function checkBody(tool: string, body: any, schema: any, where: string): void {
  schema = deref(schema);
  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries<any>(body)) {
    if (!(k in props)) {
      fail(tool, `${where}.${k} is not in the spec`);
      continue;
    }
    const sub = deref(props[k]);
    if (sub.properties && v && typeof v === "object" && !Array.isArray(v)) checkBody(tool, v, sub, `${where}.${k}`);
    if (Array.isArray(v) && deref(sub.items).properties) checkBody(tool, v[0], sub.items, `${where}.${k}[]`);
  }
  for (const r of schema.required ?? []) if (!(r in body)) fail(tool, `${where}.${r} is required but missing`);
}

const covered = new Set<string>();
for (const tool of tools) {
  const json: any = z.toJSONSchema(z.object(tool.shape));
  for (const mode of ["all fields", "required only"]) {
    const args = sample(json);
    if (mode === "required only") {
      for (const k of Object.keys(args)) if (!json.required?.includes(k)) delete args[k];
    }
    sent = null;
    const res = await tool.handler(args);
    if (res.isError) {
      fail(tool.name, `${mode}: ${res.content[0].text}`);
      continue;
    }
    if (!sent) {
      fail(tool.name, `${mode}: made no request`);
      continue;
    }
    const { method, url, body } = sent as { method: string; url: URL; body: any };
    const match = ops.find((o) => o.method === method && o.re.test(url.pathname));
    if (!match) {
      fail(tool.name, `${method} ${url.pathname} is not a spec operation`);
      continue;
    }
    covered.add(match.key);

    const query = (match.op.parameters ?? []).filter((p: any) => p.in === "query");
    for (const k of url.searchParams.keys()) {
      if (!query.some((p: any) => p.name === k)) fail(tool.name, `query param ${k} is not in the spec`);
    }
    for (const p of query) {
      if (p.required && !url.searchParams.has(p.name)) fail(tool.name, `${mode}: query param ${p.name} is required`);
    }

    const requestBody = match.op.requestBody;
    if (requestBody) {
      if (body === undefined && requestBody.required) fail(tool.name, "request body is required");
      if (body !== undefined) checkBody(tool.name, body, (Object.values<any>(requestBody.content)[0]).schema, "body");
    } else if (body !== undefined && Object.keys(body).length) {
      fail(tool.name, "sends a body the spec does not define");
    }

    // Every arg must end up in the path, query or body — catches dropped params.
    if (mode === "all fields") {
      const haystack = `${url.pathname}${url.search}${JSON.stringify(body ?? {})}`.toLowerCase();
      for (const k of Object.keys(args)) {
        if (!haystack.includes(k.toLowerCase()) && !url.pathname.includes(String(args[k]))) {
          fail(tool.name, `arg ${k} does not reach the request`);
        }
      }
    }
  }
}

for (const o of ops) if (!covered.has(o.key)) failures.push(`no tool for ${o.key}`);

for (const f of failures) console.log(`✗ ${f}`);
console.log(`\n${tools.length} tools, ${covered.size}/${ops.length} spec operations covered, ${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
