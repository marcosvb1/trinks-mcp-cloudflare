# trinks-mcp-server

Servidor MCP **privado** para a API do [Trinks](https://developers.trinks.com) (agendamento de salão/clínica), rodando como um Cloudflare Worker. Cobre agendamentos, clientes, profissionais, serviços, produtos, financeiro (transações, NFS-e, lançamentos), fidelidade e clube de assinaturas — **42 tools**.

**Multi-unidade:** se você tem mais de um estabelecimento (cada um com conta Trinks própria), configure `TRINKS_UNIDADES` e toda tool ganha o param opcional `unidade`. Ver [Unidades](#unidades).

> Reescrito do zero sobre o mapa de endpoints do [`Vlarrate/trinks-mcp`](https://github.com/Vlarrate/trinks-mcp) (que serviu de referência da API, mas não segue as práticas de MCP nem tinha gate de auth). Ver [Diferenças](#diferenças-do-repo-de-referência).

## Arquitetura

- **Transporte:** Streamable HTTP via `createMcpHandler` (Cloudflare Agents SDK) — **stateless**, um `McpServer` novo por request (exigência do SDK 1.26+). Sem Durable Object: é um proxy REST fino, não guarda estado.
- **Auth (2 modos, decididos por config):**
  - **Produção → Cloudflare Access (Managed OAuth).** Set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` e o Worker exige um `Cf-Access-Jwt-Assertion` válido. O client MCP faz o fluxo OAuth (login no browser), restrito à política da tua organização. Ver [Deploy com Access](#deploy-produção-com-cloudflare-access).
  - **Dev local → header `x-mcp-secret`** comparado contra `MCP_SHARED_SECRET`.
  - Sem nenhum dos dois configurado, o server **falha fechado** (nega tudo).
- **Secrets:** `.dev.vars` no local; Worker secrets / Secrets Store em produção.

```
src/
  index.ts          entry: health check + authorize (Access JWT | secret) + createMcpHandler
  access.ts         verificação do Cf-Access-Jwt-Assertion (jose + JWKS do team)
  env.ts            interface Env
  trinks-client.ts  client REST: timeout 30s, erro actionable por status
  tools.ts          catálogo das 42 tools (data-driven) + registro
```

## Unidades

**Uma unidade (padrão):** dois valores, `TRINKS_API_KEY` e `TRINKS_ESTABELECIMENTO_ID`. As tools não expõem o param `unidade`.

**Várias unidades:** `TRINKS_UNIDADES` mapeia cada unidade pro seu estabelecimento e pro **nome do binding** que guarda a API key dela (Worker secret ou binding do Secrets Store — a key nunca vai no JSON):

```jsonc
"vars": {
  "TRINKS_UNIDADES": {
    "matriz": { "estabelecimentoId": "123456", "apiKey": "MATRIZ_APIKEY" },
    "filial": { "estabelecimentoId": "654321", "apiKey": "FILIAL_APIKEY" }
  }
}
```

- A primeira unidade é o padrão quando a tool é chamada sem `unidade` (ou defina `TRINKS_UNIDADE_PADRAO`).
- Nomes de unidade: minúsculas, dígitos e hífen.
- No `.dev.vars`, `TRINKS_UNIDADES` vai como string JSON numa linha (exemplo no `.dev.vars.example`).
- Config inválida → o `/mcp` responde 500 com a mensagem do problema (só pra quem passou na auth).

## Rodar local

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha os valores
npm run typecheck                # opcional: checagem de tipos
npm run dev                      # wrangler dev → http://localhost:8787
```

Smoke test do gate (sem secret = 401, com secret = handshake MCP):

```bash
# 401 esperado
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/mcp

# handshake (lista tools) — troque SEU_SEGREDO
curl -s -X POST http://localhost:8787/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-mcp-secret: SEU_SEGREDO" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Ou via inspector visual: `npm run inspect` e aponte pra `http://localhost:8787/mcp` com o header `x-mcp-secret`.

## Deploy

O `wrangler.jsonc` versionado é genérico (modo uma unidade, sem `account_id`). Para um deploy com config própria — conta, várias unidades, Secrets Store — copie-o para `wrangler.local.jsonc` (gitignored), ajuste, e use `-c`:

```bash
# uma unidade, config genérica
npx wrangler secret put TRINKS_API_KEY
npx wrangler secret put TRINKS_ESTABELECIMENTO_ID
npx wrangler secret put MCP_SHARED_SECRET
npm run deploy

# config própria
npm run deploy -- -c wrangler.local.jsonc
```

> ⚠️ `npm run deploy` sem `-c` usa o `wrangler.jsonc` genérico e **substitui as vars e bindings** do Worker com o mesmo nome na conta logada.

### Auth em produção

- **Atrás de um MCP Server Portal (Cloudflare Access):** o portal faz o OAuth do usuário e autentica no Worker via header `x-mcp-secret` — cadastre no portal o mesmo valor de `MCP_SHARED_SECRET`.
- **Managed OAuth do Access direto no Worker:** set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` e o Worker valida o `Cf-Access-Jwt-Assertion` (ver `src/access.ts`). Docs: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## Configurar no client MCP

**Produção (portal ou Access):** só a URL — o OAuth resolve o login no primeiro acesso.

```json
{ "mcpServers": { "trinks": { "url": "https://SEU-PORTAL/mcp" } } }
```

**Dev local (secret header):**

```json
{ "mcpServers": { "trinks": { "url": "http://localhost:8787/mcp", "headers": { "x-mcp-secret": "SEU_SEGREDO" } } } }
```

## Diferenças do repo de referência

O `Vlarrate/trinks-mcp` serviu de mapa de endpoints (que bate com a API oficial), mas aqui:

- **Auth:** ele expunha `/mcp` público sem gate → aqui Cloudflare Access (Managed OAuth) em prod, secret header em dev (o repo original vira um proxy aberto pra sua conta Trinks se deployado como documentado).
- **SDK:** ele usa a API antiga (`setRequestHandler`) → aqui `registerTool` (moderna).
- **Annotations:** ele não tinha nenhuma → aqui `readOnlyHint`/`destructiveHint`/`idempotentHint` por tool (`excluir_cliente` e `cancelar_agendamento` marcados destrutivos).
- **Nomes:** sem prefixo → aqui `trinks_*` (evita colisão com outros MCPs).
- **Erros:** `catch` genérico → aqui mensagem específica por status (401/403/404/429/5xx) + timeout de 30s + guard de tamanho de resposta.
- **Contagem:** o README dele diz "46 tools", mas o código implementa **42** (as que existem de fato).

## Pendências / a validar

- **Não testado contra conta real.** Os paths batem com o padrão oficial; paginação e formato exato de resposta precisam de validação com a API viva. O client faz passthrough do corpo da API + guard de tamanho (não inventa contrato `has_more`).
- **Zod `status`** em `listar_agendamentos` é string livre (não enum) até confirmar os valores que a API aceita no filtro.

## Licença

[MIT](LICENSE).
