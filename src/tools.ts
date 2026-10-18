import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TrinksClient, clientForUnidade, type Unidades } from "./trinks-client";
import type { Env } from "./env";

/**
 * Response guard: MCP tool responses share the model's context window, so cap
 * how much we ever return inline. Rather than emit truncated (invalid) JSON, we
 * tell the caller to narrow the query.
 */
const CHARACTER_LIMIT = 25_000;

function toContent(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Result too large to return inline (${text.length} chars, limit ${CHARACTER_LIMIT}). Re-run with a smaller pageSize or a narrower dataInicio/dataFim window.`,
        },
      ],
    };
  }
  return { content: [{ type: "text" as const, text }] };
}

// ── Annotation buckets ──────────────────────────────────────────────────────
// destructiveHint defaults to true in the spec, so we set it explicitly per bucket.
interface Ann {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}
const READ: Ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DELETE: Ann = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// ── Reusable param fragments ────────────────────────────────────────────────
const pagination = {
  page: z.number().int().min(1).optional().describe("Página (padrão 1)"),
  pageSize: z.number().int().min(1).max(100).optional().describe("Itens por página (padrão 20, máx 100)"),
};
const dateWindow = {
  dataInicio: z.string().optional().describe("Data início (YYYY-MM-DD, ou ISO 8601 para endpoints financeiros)"),
  dataFim: z.string().optional().describe("Data fim (YYYY-MM-DD, ou ISO 8601 para endpoints financeiros)"),
};

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: Ann;
  call: (c: TrinksClient, a: Record<string, any>) => Promise<unknown>;
}

// ── Tool catalogue (42 tools) ───────────────────────────────────────────────
// Endpoint map reverse-engineered from the Trinks REST API (v1) and cross-checked
// against the official developer docs. Tools are prefixed `trinks_` to avoid
// name collisions when this server runs alongside others.
const TOOL_SPECS: ToolSpec[] = [
  // ── AGENDAMENTOS ──────────────────────────────────────────────────────────
  {
    name: "trinks_listar_agendamentos",
    title: "Listar agendamentos",
    description:
      "Lista agendamentos do estabelecimento, filtrando por data, profissional, cliente e status. Read-only.",
    inputSchema: {
      dataInicio: z.string().optional().describe("Data início (YYYY-MM-DD)"),
      dataFim: z.string().optional().describe("Data fim (YYYY-MM-DD)"),
      profissionalId: z.number().int().optional().describe("ID do profissional"),
      clienteId: z.number().int().optional().describe("ID do cliente"),
      status: z
        .string()
        .optional()
        .describe(
          "Status. Valores observados: Finalizado, Cancelado, Cliente não compareceu, Aguardando Confirmação do Estabelecimento, Confirmado",
        ),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/agendamentos", { params: a }),
  },
  {
    name: "trinks_obter_agendamento",
    title: "Obter agendamento",
    description: "Detalhes completos de um agendamento pelo ID. Read-only.",
    inputSchema: { id: z.number().int().describe("ID do agendamento") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/agendamentos/${a.id}`),
  },
  {
    name: "trinks_criar_agendamento",
    title: "Criar agendamento",
    description: "Cria um novo agendamento. Ação de escrita — cria um recurso novo.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      profissionalId: z.number().int().describe("ID do profissional"),
      servicoId: z.number().int().describe("ID do serviço"),
      dataHoraInicio: z.string().describe("Data e hora de início (ISO 8601)"),
      observacao: z.string().optional().describe("Observação"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/agendamentos", { method: "POST", body: a }),
  },
  {
    name: "trinks_cancelar_agendamento",
    title: "Cancelar agendamento",
    description: "Cancela um agendamento. DESTRUTIVO — muda o estado do agendamento e libera o horário.",
    inputSchema: {
      agendamentoId: z.number().int().describe("ID do agendamento"),
      motivoCancelamento: z.string().optional().describe("Motivo do cancelamento"),
    },
    annotations: DELETE,
    call: (c, { agendamentoId, ...body }) =>
      c.request(`/v1/agendamentos/${agendamentoId}/status/cancelado`, { method: "PATCH", body }),
  },
  {
    name: "trinks_confirmar_agendamento",
    title: "Confirmar agendamento",
    description: "Confirma um agendamento (status → Confirmado). Escrita idempotente.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento") },
    annotations: UPDATE,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/status/confirmado`, { method: "PATCH" }),
  },
  {
    name: "trinks_finalizar_agendamento",
    title: "Finalizar agendamento",
    description: "Marca um agendamento como finalizado (atendimento realizado). Escrita idempotente.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento") },
    annotations: UPDATE,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/status/finalizado`, { method: "PATCH" }),
  },
  {
    name: "trinks_agendamento_cliente_faltou",
    title: "Registrar falta do cliente",
    description: "Registra que o cliente faltou (status → Cliente não compareceu). Escrita idempotente.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento") },
    annotations: UPDATE,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/status/clientefaltou`, { method: "PATCH" }),
  },
  {
    name: "trinks_listar_profissionais_com_agenda",
    title: "Listar profissionais com agenda",
    description: "Lista os profissionais que têm agenda numa data específica. Read-only.",
    inputSchema: { data: z.string().describe("Data (YYYY-MM-DD)") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/agendamentos/profissionais/${a.data}`),
  },
  {
    name: "trinks_configuracoes_agendamento",
    title: "Configurações de agendamento",
    description: "Configurações de agendamento do estabelecimento. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/agendamentos/configuracoes"),
  },

  // ── CLIENTES ──────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_clientes",
    title: "Listar clientes",
    description: "Lista clientes, filtrando por nome, e-mail ou telefone. Read-only.",
    inputSchema: {
      nome: z.string().optional().describe("Filtrar por nome"),
      email: z.string().optional().describe("Filtrar por e-mail"),
      telefone: z.string().optional().describe("Filtrar por telefone"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/clientes", { params: a }),
  },
  {
    name: "trinks_obter_cliente",
    title: "Obter cliente",
    description: "Detalhes completos de um cliente pelo ID. Read-only.",
    inputSchema: { id: z.number().int().describe("ID do cliente") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clientes/${a.id}`),
  },
  {
    name: "trinks_criar_cliente",
    title: "Criar cliente",
    description: "Cria um novo cliente. Ação de escrita — cria um recurso novo.",
    inputSchema: {
      nome: z.string().describe("Nome completo"),
      email: z.string().email().optional().describe("E-mail"),
      dataNascimento: z.string().optional().describe("Data de nascimento (YYYY-MM-DD)"),
      genero: z.string().optional().describe("Gênero"),
      observacao: z.string().optional().describe("Observação"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/clientes", { method: "POST", body: a }),
  },
  {
    name: "trinks_editar_cliente",
    title: "Editar cliente",
    description: "Edita dados de um cliente existente (PUT). Escrita idempotente.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      nome: z.string().optional(),
      email: z.string().email().optional(),
      dataNascimento: z.string().optional().describe("YYYY-MM-DD"),
      genero: z.string().optional(),
      observacao: z.string().optional(),
    },
    annotations: UPDATE,
    call: (c, { clienteId, ...body }) => c.request(`/v1/clientes/${clienteId}`, { method: "PUT", body }),
  },
  {
    name: "trinks_excluir_cliente",
    title: "Excluir cliente",
    description: "Exclui um cliente do estabelecimento. DESTRUTIVO E IRREVERSÍVEL — apaga o cadastro.",
    inputSchema: { clienteId: z.number().int().describe("ID do cliente") },
    annotations: DELETE,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}`, { method: "DELETE" }),
  },
  {
    name: "trinks_adicionar_credito_cliente",
    title: "Adicionar crédito ao cliente",
    description: "Adiciona um crédito a um cliente. Escrita — cada chamada soma um novo crédito (não idempotente).",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      valor: z.number().describe("Valor do crédito"),
      descricao: z.string().optional().describe("Descrição"),
    },
    annotations: CREATE,
    call: (c, { clienteId, ...body }) => c.request(`/v1/clientes/${clienteId}/creditos`, { method: "POST", body }),
  },
  {
    name: "trinks_adicionar_vale_presente",
    title: "Adicionar vale-presente",
    description: "Adiciona um vale-presente a um cliente. Escrita — não idempotente.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      valor: z.number().describe("Valor do vale-presente"),
      descricao: z.string().optional().describe("Descrição"),
    },
    annotations: CREATE,
    call: (c, { clienteId, ...body }) =>
      c.request(`/v1/clientes/${clienteId}/valespresentes`, { method: "POST", body }),
  },
  {
    name: "trinks_listar_etiquetas_cliente",
    title: "Listar etiquetas do cliente",
    description: "Lista as etiquetas associadas a um cliente. Read-only.",
    inputSchema: { clienteId: z.number().int().describe("ID do cliente") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/etiquetas`),
  },
  {
    name: "trinks_associar_etiqueta_cliente",
    title: "Associar etiqueta ao cliente",
    description: "Associa uma etiqueta a um cliente. Escrita idempotente (re-associar é no-op).",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: UPDATE,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/etiquetas/${a.etiquetaId}`, { method: "POST" }),
  },
  {
    name: "trinks_remover_etiqueta_cliente",
    title: "Remover etiqueta do cliente",
    description: "Remove uma etiqueta de um cliente. DESTRUTIVO — remove a associação.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: DELETE,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/etiquetas/${a.etiquetaId}`, { method: "DELETE" }),
  },
  {
    name: "trinks_listar_telefones_cliente",
    title: "Listar telefones do cliente",
    description: "Lista os telefones de um cliente. Read-only.",
    inputSchema: { clienteId: z.number().int().describe("ID do cliente") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/telefones`),
  },
  {
    name: "trinks_adicionar_telefone_cliente",
    title: "Adicionar telefone ao cliente",
    description: "Adiciona um telefone a um cliente. Escrita — não idempotente.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      numero: z.string().describe("Número do telefone (com DDD)"),
      tipo: z.string().optional().describe("Tipo (celular, fixo, etc.)"),
    },
    annotations: CREATE,
    call: (c, { clienteId, ...body }) => c.request(`/v1/clientes/${clienteId}/telefones`, { method: "POST", body }),
  },

  // ── PROFISSIONAIS ─────────────────────────────────────────────────────────
  {
    name: "trinks_listar_profissionais",
    title: "Listar profissionais",
    description: "Lista todos os profissionais do estabelecimento. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/profissionais", { params: a }),
  },
  {
    name: "trinks_listar_servicos_profissional",
    title: "Listar serviços do profissional",
    description: "Lista os serviços que um profissional atende. Read-only.",
    inputSchema: { profissionalId: z.number().int().describe("ID do profissional") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/profissionais/${a.profissionalId}/servicos`),
  },

  // ── SERVIÇOS ──────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_servicos",
    title: "Listar serviços",
    description: "Lista todos os serviços do estabelecimento. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/servicos", { params: a }),
  },
  {
    name: "trinks_listar_promocoes_servico",
    title: "Listar promoções do serviço",
    description: "Lista promoções de um serviço, com valor por dia da semana. Read-only.",
    inputSchema: { servicoId: z.number().int().describe("ID do serviço") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/servicos/${a.servicoId}/promocoes`),
  },

  // ── PRODUTOS ──────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_produtos",
    title: "Listar produtos",
    description: "Lista todos os produtos do estabelecimento. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/produtos", { params: a }),
  },

  // ── FINANCEIRO ────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_transacoes",
    title: "Listar transações",
    description:
      "Lista transações financeiras (fechamentos de caixa) por período: serviços, produtos, formas de pagamento e descontos. Read-only.",
    inputSchema: {
      ...dateWindow,
      incluirEstornos: z.boolean().optional().describe("Incluir estornos (padrão false)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/transacoes", { params: a }),
  },
  {
    name: "trinks_listar_transacoes_fiscais",
    title: "Listar transações fiscais (NFS-e)",
    description: "Lista transações com detalhes fiscais (NFS-e), para emissão/conferência de notas. Read-only.",
    inputSchema: { ...dateWindow, ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/transacoes/notas-fiscais", { params: a }),
  },
  {
    name: "trinks_listar_vendas",
    title: "Listar vendas",
    description: "Lista vendas de produto do estabelecimento por período. Read-only.",
    inputSchema: { ...dateWindow, ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/vendas", { params: a }),
  },
  {
    name: "trinks_listar_lancamentos",
    title: "Listar lançamentos",
    description: "Lista lançamentos financeiros (receitas e despesas) por período. Read-only.",
    inputSchema: { ...dateWindow, ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/lancamentos", { params: a }),
  },
  {
    name: "trinks_obter_lancamento",
    title: "Obter lançamento",
    description: "Detalhes completos de um lançamento financeiro. Read-only.",
    inputSchema: { lancamentoId: z.number().int().describe("ID do lançamento") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/lancamentos/${a.lancamentoId}`),
  },
  {
    name: "trinks_criar_lancamento",
    title: "Criar lançamento",
    description: "Cria um lançamento financeiro (receita ou despesa). Ação de escrita — cria um recurso novo.",
    inputSchema: {
      categoriaId: z.number().int().describe("ID da categoria"),
      dataVencimento: z.string().describe("Data de vencimento (YYYY-MM-DD)"),
      valor: z.number().describe("Valor"),
      statusPagamento: z.number().int().describe("1 = Pago, 2 = Não pago"),
      descricao: z.string().optional().describe("Descrição"),
      formaPagamentoId: z.number().int().optional().describe("ID da forma de pagamento"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/lancamentos", { method: "POST", body: a }),
  },
  {
    name: "trinks_listar_categorias_lancamento",
    title: "Listar categorias de lançamento",
    description: "Lista as categorias de lançamento disponíveis. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/lancamentos/categorias"),
  },
  {
    name: "trinks_listar_formas_pagamento",
    title: "Listar formas de pagamento",
    description: "Lista as formas de pagamento do estabelecimento. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/formaspagamentos"),
  },
  {
    name: "trinks_listar_motivos_desconto",
    title: "Listar motivos de desconto",
    description: "Lista os motivos de desconto cadastrados. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/motivosdescontos"),
  },

  // ── FIDELIDADE ────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_movimentacoes_fidelidade",
    title: "Listar movimentações de fidelidade",
    description: "Lista movimentações de pontos do programa de fidelidade (máx 90 dias por consulta). Read-only.",
    inputSchema: { ...dateWindow, ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/fidelidade", { params: a }),
  },

  // ── CLUBE DE ASSINATURAS ──────────────────────────────────────────────────
  {
    name: "trinks_listar_planos_assinatura",
    title: "Listar planos de assinatura",
    description: "Lista os planos do clube de assinaturas. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/clube/planos"),
  },
  {
    name: "trinks_listar_assinaturas",
    title: "Listar assinaturas",
    description: "Lista as assinaturas ativas do clube. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/clube/assinaturas", { params: a }),
  },
  {
    name: "trinks_estatisticas_assinaturas",
    title: "Estatísticas de assinaturas",
    description: "Estatísticas do clube de assinaturas. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/clube/assinaturas/statistics"),
  },

  // ── ETIQUETAS ─────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_etiquetas",
    title: "Listar etiquetas",
    description: "Lista todas as etiquetas cadastradas no estabelecimento. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/etiquetas"),
  },
  {
    name: "trinks_criar_etiqueta",
    title: "Criar etiqueta",
    description: "Cria uma nova etiqueta. Ação de escrita — cria um recurso novo.",
    inputSchema: { conteudo: z.string().describe("Nome/conteúdo da etiqueta") },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/etiquetas", { method: "POST", body: a }),
  },

  // ── ESTABELECIMENTO ───────────────────────────────────────────────────────
  {
    name: "trinks_detalhes_estabelecimento",
    title: "Detalhes do estabelecimento",
    description: "Detalhes do estabelecimento configurado nesta sessão. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request(`/v1/estabelecimentos/${c.establishmentId}`),
  },
];

/**
 * Register all Trinks tools on an McpServer, bound to a per-request client.
 * With more than one unit configured, every tool takes an optional `unidade`.
 */
export function registerTrinksTools(server: McpServer, env: Env, unidades: Unidades): void {
  const unidadeParam: ZodRawShape =
    unidades.nomes.length > 1
      ? {
          unidade: z
            .enum(unidades.nomes)
            .optional()
            .describe(
              `Unidade (conta Trinks): ${unidades.nomes
                .map((n) => (n === unidades.padrao ? `"${n}" (padrão)` : `"${n}"`))
                .join(", ")}`,
            ),
        }
      : {};

  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: { ...spec.inputSchema, ...unidadeParam },
        annotations: spec.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const { unidade, ...rest } = args ?? {};
          const client = await clientForUnidade(env, unidades, (unidade as string | undefined) ?? unidades.padrao);
          const data = await spec.call(client, rest);
          return toContent(data);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Erro: ${message}` }], isError: true };
        }
      },
    );
  }
}

export const TOOL_COUNT = TOOL_SPECS.length;
