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
/** Updates that can erase data: PUT replaces (omitted fields are cleared), or shrinking a recurrence. */
const OVERWRITE: Ann = { ...UPDATE, destructiveHint: true };

// ── Reusable param fragments ────────────────────────────────────────────────
const pagination = {
  page: z.number().int().min(1).optional().describe("Página (padrão 1)"),
  pageSize: z.number().int().min(1).max(50).optional().describe("Itens por página (máximo 50)"),
};
const dateWindow = {
  dataInicio: z.string().optional().describe("Início do período (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)"),
  dataFim: z.string().optional().describe("Fim do período (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)"),
};
const ETIQUETA_CORES = [
  "#024125", "#047342", "#009c57", "#48be8a", "#1fe48d", "#249cc6", "#3753bc", "#0071bc", "#1f116a", "#6e2f93",
  "#8763ba", "#7618ff", "#EBB6FF", "#ff66cc", "#f8448d", "#df2dc5", "#cc296b", "#930d24", "#6a0617", "#510411",
] as const;
const agendamentoBody = {
  servicoId: z.number().int().describe("ID do serviço (de trinks_listar_servicos)"),
  clienteId: z.number().int().describe("ID do cliente (de trinks_listar_clientes)"),
  profissionalId: z
    .number()
    .int()
    .optional()
    .describe("Campo `id` de trinks_listar_profissionais (não o `idProfissional`)"),
  dataHoraInicio: z.string().describe("Data e hora local de início, sem fuso (ex.: 2026-10-01T14:30:00)"),
  duracaoEmMinutos: z.number().int().min(1).max(9999).describe("Duração em minutos (1 a 9999)"),
  valor: z.number().min(0).describe("Valor do agendamento (>= 0)"),
  observacoes: z.string().optional().describe("Observação do estabelecimento"),
};
const clienteBody = {
  nome: z.string().min(3).max(300).optional().describe("Nome (3 a 300 caracteres)"),
  email: z.string().email().max(100).optional().describe("E-mail, único no estabelecimento"),
  cpf: z.string().regex(/^\d{11}$/).optional().describe("CPF, 11 dígitos sem pontuação, único no estabelecimento"),
  genero: z.enum(["M", "F", "N", "X"]).optional().describe("M = Masculino, F = Feminino, N = Não-binário, X = Não informado"),
  observacoes: z.string().max(5000).optional().describe("Observações gerais (até 5000 caracteres)"),
  codigoExterno: z.string().max(15).optional().describe("Código do cliente no seu sistema (até 15 caracteres)"),
};
const telefone = {
  ddd: z.string().regex(/^\d+$/).describe("DDD, só dígitos, sem zero à esquerda (ex.: 11)"),
  numero: z.string().regex(/^\d+$/).describe("Número, só dígitos, sem DDD e sem DDI (ex.: 987654321)"),
  tipoId: z
    .number()
    .int()
    .min(0)
    .max(6)
    .describe("0 = Não informado, 1 = Comercial, 2 = Residencial, 3 = Celular, 4 = Recado, 5 = Outro, 6 = WhatsApp"),
  ddi: z.string().regex(/^\d+$/).optional().describe("DDI, só dígitos (padrão 55)"),
};

/** A few routes declare PascalCase query params (/v1/clientes, /v1/comissoes); send them as declared. */
function pascalKeys(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]));
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: Ann;
  call: (c: TrinksClient, a: Record<string, any>) => Promise<unknown>;
}

// ── Tool catalogue (66 tools) ───────────────────────────────────────────────
// One tool per operation of the official Trinks OpenAPI spec
// (https://api.trinks.com/swagger/v1/swagger.json): same method, path, params
// and body. Tools are prefixed `trinks_` to avoid name collisions when this
// server runs alongside others.
const TOOL_SPECS: ToolSpec[] = [
  // ── AGENDAMENTOS ──────────────────────────────────────────────────────────
  {
    name: "trinks_listar_agendamentos",
    title: "Listar agendamentos",
    description: "Lista agendamentos do estabelecimento, filtrando por período (pelo início do agendamento) e cliente. Read-only.",
    inputSchema: {
      dataInicio: z.string().optional().describe("Início do período (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)"),
      dataFim: z.string().optional().describe("Fim do período; sem hora, inclui o dia inteiro"),
      clienteId: z.number().int().optional().describe("ID do cliente"),
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
    description:
      "Cria um novo agendamento. Por padrão nasce Confirmado (confirmado=false deixa Aguardando confirmação). Ação de escrita — cria um recurso novo.",
    inputSchema: {
      ...agendamentoBody,
      confirmado: z.boolean().optional().describe("true (padrão) = Confirmado; false = Aguardando confirmação"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/agendamentos", { method: "POST", body: a }),
  },
  {
    name: "trinks_editar_agendamento",
    title: "Editar agendamento",
    description:
      "Edita um agendamento (PUT). SUBSTITUI todos os campos: profissionalId omitido tira o profissional e observacoes omitida apaga a observação — obtenha o agendamento antes e reenvie o que não muda. Não altera o status; cancelado ou já pago não pode ser editado.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento"), ...agendamentoBody },
    annotations: OVERWRITE,
    call: (c, { agendamentoId, ...body }) => c.request(`/v1/agendamentos/${agendamentoId}`, { method: "PUT", body }),
  },
  {
    name: "trinks_cancelar_agendamento",
    title: "Cancelar agendamento",
    description: "Cancela um agendamento. DESTRUTIVO — muda o estado do agendamento e libera o horário.",
    inputSchema: {
      agendamentoId: z.number().int().describe("ID do agendamento"),
      quemCancelou: z.number().int().min(1).max(4).describe("1 = Cliente, 2 = Profissional, 3 = Estabelecimento, 4 = Outro"),
      motivo: z.string().min(1).max(250).describe("Motivo do cancelamento (até 250 caracteres)"),
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
    name: "trinks_agendamento_em_atendimento",
    title: "Iniciar atendimento",
    description:
      "Muda o status do agendamento para Em atendimento. Não aceita agendamento cancelado nem já pago. Escrita idempotente.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento") },
    annotations: UPDATE,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/status/ematendimento`, { method: "PATCH" }),
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
    description: "Lista os profissionais com agenda num dia, com os horários livres sugeridos. Read-only.",
    inputSchema: {
      data: z.string().describe("Dia (YYYY-MM-DD)"),
      servicoId: z.number().int().optional().describe("Restringe aos profissionais que fazem o serviço e usa a duração dele"),
      servicoDuracao: z.number().int().optional().describe("Duração (min) que precisa caber em cada horário; prevalece sobre a do serviço"),
      profissionalId: z.number().int().optional().describe("Campo `id` de trinks_listar_profissionais"),
      intervalos: z.number().int().min(5).max(120).optional().describe("Minutos entre um horário sugerido e o próximo (5 a 120)"),
      excluirExcecoesDeAgendamentoOnline: z
        .boolean()
        .optional()
        .describe("true = só profissionais liberados para agendamento online"),
      page: pagination.page,
    },
    annotations: READ,
    call: (c, { data, ...params }) => c.request(`/v1/agendamentos/profissionais/${data}`, { params }),
  },
  {
    name: "trinks_configuracoes_agendamento",
    title: "Configurações de agendamento",
    description: "Configurações de agendamento do estabelecimento. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/agendamentos/configuracoes"),
  },
  {
    name: "trinks_listar_etiquetas_agendamento",
    title: "Listar etiquetas do agendamento",
    description: "Lista as etiquetas ativas associadas a um agendamento. Read-only.",
    inputSchema: { agendamentoId: z.number().int().describe("ID do agendamento") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/etiquetas`),
  },
  {
    name: "trinks_obter_etiqueta_agendamento",
    title: "Obter etiqueta do agendamento",
    description: "Detalhes de uma etiqueta associada a um agendamento (404 se não estiver associada). Read-only.",
    inputSchema: {
      agendamentoId: z.number().int().describe("ID do agendamento"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: READ,
    call: (c, a) => c.request(`/v1/agendamentos/${a.agendamentoId}/etiquetas/${a.etiquetaId}`),
  },
  {
    name: "trinks_associar_etiqueta_agendamento",
    title: "Associar etiqueta ao agendamento",
    description:
      "Associa uma etiqueta a um agendamento. A etiqueta precisa estar ativa e ser de tipo agendamento (1). Escrita idempotente.",
    inputSchema: {
      agendamentoId: z.number().int().describe("ID do agendamento"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: UPDATE,
    call: (c, a) =>
      c.request(`/v1/agendamentos/${a.agendamentoId}/etiquetas/${a.etiquetaId}`, { method: "POST" }),
  },
  {
    name: "trinks_remover_etiqueta_agendamento",
    title: "Remover etiqueta do agendamento",
    description: "Remove uma etiqueta de um agendamento. DESTRUTIVO — remove a associação.",
    inputSchema: {
      agendamentoId: z.number().int().describe("ID do agendamento"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: DELETE,
    call: (c, a) =>
      c.request(`/v1/agendamentos/${a.agendamentoId}/etiquetas/${a.etiquetaId}`, { method: "DELETE" }),
  },

  // ── CLIENTES ──────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_clientes",
    title: "Listar clientes",
    description: "Lista clientes, filtrando por nome, CPF, e-mail, telefone e datas de cadastro/alteração. Read-only.",
    inputSchema: {
      nome: z.string().optional().describe("Trecho do nome"),
      cpf: z.string().optional().describe("Trecho do CPF, só números"),
      email: z.string().optional().describe("Trecho do e-mail"),
      telefone: z.string().optional().describe("Telefone (ex.: 21999999999 ou 5521999999999)"),
      dataCadastroInicio: z.string().optional().describe("Cadastro a partir de (YYYY-MM-DD ou com hora)"),
      dataCadastroFim: z.string().optional().describe("Cadastro até; sem hora, inclui o dia inteiro"),
      dataAlteracaoCadastralInicio: z.string().optional().describe("Última alteração do cadastro a partir de"),
      dataAlteracaoCadastralFim: z.string().optional().describe("Última alteração do cadastro até"),
      incluirDetalhes: z.boolean().optional().describe("Inclui os detalhes de cada cliente"),
      incluirEtiquetas: z.boolean().optional().describe("Inclui as etiquetas de cada cliente"),
      ...pagination,
    },
    annotations: READ,
    call: (c, { cpf, ...rest }) => c.request("/v1/clientes", { params: { ...pascalKeys(rest), CPF: cpf } }),
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
    description: "Cria um novo cliente (pelo menos um telefone é obrigatório). Ação de escrita — cria um recurso novo.",
    inputSchema: {
      ...clienteBody,
      nome: z.string().min(3).max(300).describe("Nome (3 a 300 caracteres)"),
      telefones: z
        .array(
          z.object({
            ...telefone,
            tipoId: z
              .number()
              .int()
              .min(1)
              .max(6)
              .describe("1 = Comercial, 2 = Residencial, 3 = Celular, 4 = Recado, 5 = Outro, 6 = WhatsApp"),
          }),
        )
        .min(1)
        .describe("Telefones do cliente (pelo menos um)"),
      preferencias: z
        .object({
          recebeSMSLembreteDeAgendamento: z.boolean().optional(),
          recebeEmailLembreteDeAgendamento: z.boolean().optional(),
          recebeSMSMarketing: z.boolean().optional(),
          recebeEmailMarketing: z.boolean().optional(),
        })
        .optional()
        .describe("Preferências de lembretes e marketing"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/clientes", { method: "POST", body: a }),
  },
  {
    name: "trinks_editar_cliente",
    title: "Editar cliente",
    description:
      "Edita um cliente (PUT). email, cpf, observacoes e codigoExterno omitidos são APAGADOS (nome omitido é mantido) — obtenha o cliente antes e reenvie o que não muda.",
    inputSchema: { clienteId: z.number().int().describe("ID do cliente"), ...clienteBody },
    annotations: OVERWRITE,
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
      valor: z.number().positive().describe("Valor do crédito em reais (> 0)"),
      formaPagamentoId: z.number().int().describe("Forma usada para pagar o crédito (de trinks_listar_formas_pagamento)"),
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
      numero: z.number().int().positive().describe("Número do vale, único no estabelecimento"),
      valor: z.number().positive().describe("Saldo inicial em reais (> 0)"),
      formaPagamentoId: z.number().int().describe("Forma usada para pagar o vale (de trinks_listar_formas_pagamento)"),
      validade: z.string().optional().describe("Validade (YYYY-MM-DD, a partir de amanhã). Omitida, não expira"),
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
    name: "trinks_obter_etiqueta_cliente",
    title: "Obter etiqueta do cliente",
    description: "Detalhes de uma etiqueta associada a um cliente (404 se não estiver associada). Read-only.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      etiquetaId: z.number().int().describe("ID da etiqueta"),
    },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/etiquetas/${a.etiquetaId}`),
  },
  {
    name: "trinks_associar_etiqueta_cliente",
    title: "Associar etiqueta ao cliente",
    description: "Associa uma etiqueta (de tipo cliente) a um cliente. Escrita idempotente (re-associar é no-op).",
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
    name: "trinks_obter_telefone_cliente",
    title: "Obter telefone do cliente",
    description: "Detalhes de um telefone do cliente. Read-only.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      telefoneId: z.number().int().describe("ID do telefone (de trinks_listar_telefones_cliente)"),
    },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/telefones/${a.telefoneId}`),
  },
  {
    name: "trinks_adicionar_telefone_cliente",
    title: "Adicionar telefone ao cliente",
    description: "Adiciona um telefone a um cliente. Escrita — não idempotente.",
    inputSchema: { clienteId: z.number().int().describe("ID do cliente"), ...telefone },
    annotations: CREATE,
    call: (c, { clienteId, ...body }) => c.request(`/v1/clientes/${clienteId}/telefones`, { method: "POST", body }),
  },
  {
    name: "trinks_remover_telefone_cliente",
    title: "Remover telefone do cliente",
    description: "Remove um telefone de um cliente. DESTRUTIVO.",
    inputSchema: {
      clienteId: z.number().int().describe("ID do cliente"),
      telefoneId: z.number().int().describe("ID do telefone (de trinks_listar_telefones_cliente)"),
    },
    annotations: DELETE,
    call: (c, a) => c.request(`/v1/clientes/${a.clienteId}/telefones/${a.telefoneId}`, { method: "DELETE" }),
  },

  // ── PROFISSIONAIS ─────────────────────────────────────────────────────────
  {
    name: "trinks_listar_profissionais",
    title: "Listar profissionais",
    description: "Lista os profissionais do estabelecimento (padrão: só ativos). Read-only.",
    inputSchema: {
      status: z.number().int().min(1).max(3).optional().describe("1 = Ativo (padrão), 2 = Inativo, 3 = Todos"),
      include: z.number().int().min(0).max(1).optional().describe("1 = inclui a foto (fotoUrl); 0 = nada (padrão)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/profissionais", { params: a }),
  },
  {
    name: "trinks_listar_profissionais_por_categoria",
    title: "Listar profissionais por categoria de serviço",
    description: "Lista os profissionais que atendem uma categoria de serviço do estabelecimento. Read-only.",
    inputSchema: {
      servicoCategoriaEstabelecimentoId: z.number().int().describe("ID da categoria de serviço do estabelecimento"),
      ...pagination,
    },
    annotations: READ,
    call: (c, { servicoCategoriaEstabelecimentoId, ...params }) =>
      c.request(`/v1/profissionais/${servicoCategoriaEstabelecimentoId}`, { params }),
  },
  {
    name: "trinks_listar_servicos_profissional",
    title: "Listar serviços do profissional",
    description: "Lista os serviços que um profissional atende. Read-only.",
    inputSchema: {
      profissionalId: z.number().int().describe("Campo `id` de trinks_listar_profissionais"),
      ...pagination,
    },
    annotations: READ,
    call: (c, { profissionalId, ...params }) => c.request(`/v1/profissionais/${profissionalId}/servicos`, { params }),
  },
  {
    name: "trinks_listar_comissoes_profissional",
    title: "Comissões do profissional",
    description:
      "Detalhamento das comissões de um profissional em um dia (equivale ao Relatório de Comissões). Cada item é uma parcela, então o mesmo idComissao pode repetir. Read-only.",
    inputSchema: {
      estabelecimentoProfissionalId: z.number().int().describe("Campo `id` de trinks_listar_profissionais"),
      data: z.string().describe("Dia consultado (YYYY-MM-DD); um dia por vez"),
      criterioData: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("1 = Data de liberação da comissão (padrão), 2 = Data de atendimento/venda, 3 = Data de pagamento/estorno"),
      statusPagamento: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Pagamento da comissão ao profissional: 1 = Todos (padrão), 2 = Pago, 3 = Não pago"),
      detalhado: z.boolean().optional().describe("true = todas as colunas do relatório detalhado"),
      incluirEstornos: z.boolean().optional().describe("true = inclui estornos e pagamentos estornados"),
      page: pagination.page,
      pageSize: z.number().int().min(1).max(50).optional().describe("Itens por página (1 a 50, padrão 10)"),
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/comissoes", { params: pascalKeys(a) }),
  },

  // ── SERVIÇOS ──────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_servicos",
    title: "Listar serviços",
    description: "Lista os serviços do estabelecimento, filtrando por nome e categoria. Read-only.",
    inputSchema: {
      nome: z.string().optional().describe("Trecho do nome do serviço"),
      categoria: z.string().optional().describe("Trecho do nome da categoria"),
      somenteVisiveisCliente: z.boolean().optional().describe("true = só serviços visíveis ao cliente"),
      ...pagination,
    },
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
    description: "Lista os produtos do estabelecimento. Read-only.",
    inputSchema: { nome: z.string().optional().describe("Trecho do nome do produto"), ...pagination },
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
    inputSchema: {
      ...dateWindow,
      incluirEstornos: z.boolean().optional().describe("Inclui transações estornadas e os estornos"),
      ...pagination,
    },
    annotations: READ,
    // page/pageSize are required by this route.
    call: (c, a) =>
      c.request("/v1/transacoes/notas-fiscais", { params: { ...a, page: a.page ?? 1, pageSize: a.pageSize ?? 50 } }),
  },
  {
    name: "trinks_listar_vendas",
    title: "Listar vendas",
    description: "Lista vendas de produto do estabelecimento por período. Read-only.",
    inputSchema: {
      ...dateWindow,
      incluirEstornos: z.boolean().optional().describe("Inclui as vendas estornadas"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/vendas", { params: a }),
  },
  {
    name: "trinks_listar_lancamentos",
    title: "Listar lançamentos",
    description: "Lista lançamentos financeiros (receitas e despesas) por período de vencimento. Read-only.",
    inputSchema: {
      dataInicio: z.string().describe("Vencimento a partir de (YYYY-MM-DD)"),
      dataFim: z.string().describe("Vencimento até (YYYY-MM-DD, inclui o dia inteiro)"),
      statusPagamento: z.number().int().min(1).max(2).optional().describe("1 = Pago, 2 = Não pago; omitido = todos"),
      apenasAtivos: z.boolean().optional().describe("false = inclui lançamentos inativados"),
      page: pagination.page,
      pageSize: z.number().int().min(1).max(50).optional().describe("Itens por página (1 a 50, padrão 10)"),
    },
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
    description:
      "Cria um lançamento financeiro (receita ou despesa), simples ou recorrente. Pago (statusPagamento=1) exige formaPagamentoId e dataPagamento. Ação de escrita — cria um recurso novo.",
    inputSchema: {
      categoria: z.number().int().describe("ID da categoria (de trinks_listar_categorias_lancamento); define receita ou despesa"),
      dataVencimento: z.string().describe("Data de vencimento (YYYY-MM-DD, a partir de 2010-01-01)"),
      valor: z.number().describe("Valor em reais (> 0 quando pago)"),
      statusPagamento: z.number().int().min(1).max(2).describe("1 = Pago, 2 = Não pago"),
      dataPagamento: z.string().optional().describe("Data de pagamento (YYYY-MM-DD); obrigatória quando pago"),
      dataCompetencia: z.string().optional().describe("Data de competência (YYYY-MM-DD); omitida, assume o vencimento"),
      descricao: z.string().optional().describe("Descrição"),
      formaPagamentoId: z.number().int().optional().describe("ID da forma de pagamento; obrigatório quando pago"),
      profissionalOuFornecedorDocumento: z
        .string()
        .optional()
        .describe("CPF/CNPJ de profissional ativo ou fornecedor; obrigatório quando a categoria exige"),
      recorrencia: z
        .object({
          tipoRecorrencia: z.number().int().min(1).max(3).describe("1 = Mensal, 2 = Quinzenal, 3 = Semanal"),
          numeroDeParcelas: z
            .number()
            .int()
            .min(2)
            .max(52)
            .describe("Parcelas (mensal até 12, quinzenal até 24, semanal até 52; até 365 dias no total)"),
          formaDeAplicarCompetencia: z
            .number()
            .int()
            .min(1)
            .max(3)
            .describe("1 = Igual para todas, 2 = Igual ao pagamento de cada parcela, 3 = 30 dias antes do pagamento de cada parcela"),
          considerarRecorrenciaPagaNaDataVencimento: z
            .boolean()
            .optional()
            .describe("true = todas as parcelas nascem pagas no vencimento (exige formaPagamentoId, sem dataPagamento)"),
        })
        .optional()
        .describe("Preencha para criar um lançamento recorrente"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/lancamentos", { method: "POST", body: a }),
  },
  {
    name: "trinks_editar_lancamento",
    title: "Editar lançamento",
    description:
      "Edita só os campos enviados de um lançamento. Com editarEsteERecorrentesFuturos=true aplica também às parcelas futuras da recorrência (em lote não aceita statusPagamento nem datas). Marcar como pago exige formaPagamentoId, valor e dataPagamento juntos. Escrita idempotente.",
    inputSchema: {
      lancamentoId: z.number().int().describe("ID do lançamento"),
      categoria: z.number().int().optional().describe("ID da categoria"),
      dataVencimento: z.string().optional().describe("YYYY-MM-DD"),
      dataPagamento: z.string().optional().describe("YYYY-MM-DD"),
      dataCompetencia: z.string().optional().describe("YYYY-MM-DD"),
      descricao: z.string().optional().describe("Texto vazio apaga a descrição"),
      valor: z.number().optional().describe("Valor em reais"),
      statusPagamento: z
        .number()
        .int()
        .min(1)
        .max(2)
        .optional()
        .describe("1 = Pago, 2 = Não pago (2 apaga data e forma de pagamento)"),
      formaPagamentoId: z.number().int().optional().describe("ID da forma de pagamento"),
      profissionalOuFornecedorDocumento: z.string().optional().describe("CPF/CNPJ de profissional ou fornecedor"),
      editarEsteERecorrentesFuturos: z
        .boolean()
        .optional()
        .describe("true = aplica a este e a todas as parcelas futuras da recorrência"),
    },
    annotations: UPDATE,
    call: (c, { lancamentoId, editarEsteERecorrentesFuturos, ...body }) =>
      c.request(`/v1/lancamentos/${lancamentoId}`, {
        method: "PATCH",
        body:
          editarEsteERecorrentesFuturos === undefined
            ? body
            : { ...body, recorrenciaEdicao: { editarEsteERecorrentesFuturos } },
      }),
  },
  {
    name: "trinks_inativar_lancamento",
    title: "Inativar lançamento",
    description:
      "Inativa (soft delete) um lançamento; com inativarEsteERecorrentesFuturos=true, também as parcelas futuras da recorrência. Reversível com trinks_reativar_lancamento. DESTRUTIVO.",
    inputSchema: {
      lancamentoId: z.number().int().describe("ID do lançamento"),
      inativarEsteERecorrentesFuturos: z.boolean().optional().describe("true = inativa este e as parcelas futuras"),
    },
    annotations: DELETE,
    call: (c, { lancamentoId, ...body }) =>
      c.request(`/v1/lancamentos/${lancamentoId}/inativar`, { method: "PATCH", body }),
  },
  {
    name: "trinks_reativar_lancamento",
    title: "Reativar lançamento",
    description:
      "Reativa um lançamento inativado; com reativarEsteERecorrentesFuturos=true, também as parcelas futuras da recorrência. Escrita idempotente.",
    inputSchema: {
      lancamentoId: z.number().int().describe("ID do lançamento"),
      reativarEsteERecorrentesFuturos: z.boolean().optional().describe("true = reativa este e as parcelas futuras"),
    },
    annotations: UPDATE,
    call: (c, { lancamentoId, ...body }) =>
      c.request(`/v1/lancamentos/${lancamentoId}/reativar`, { method: "PATCH", body }),
  },
  {
    name: "trinks_obter_recorrencia_lancamento",
    title: "Obter recorrência de lançamentos",
    description: "Detalhes de uma recorrência de lançamentos: tipo, parcelas, datas e lançamentos vinculados. Read-only.",
    inputSchema: { recorrenciaId: z.number().int().describe("ID da recorrência") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/lancamentos/recorrencias/${a.recorrenciaId}`),
  },
  {
    name: "trinks_ajustar_parcelas_recorrencia",
    title: "Ajustar parcelas da recorrência",
    description:
      "Muda o total de parcelas ativas de uma recorrência. Aumentar reativa parcelas inativas e cria novas; REDUZIR inativa parcelas futuras, mesmo pagas. Limites: mensal 12, quinzenal 24, semanal 52, até 365 dias.",
    inputSchema: {
      recorrenciaId: z.number().int().describe("ID da recorrência"),
      novoNumeroDeParcelas: z.number().int().min(2).max(52).describe("Novo total de parcelas ativas (mínimo 2)"),
    },
    annotations: OVERWRITE,
    call: (c, { recorrenciaId, ...body }) =>
      c.request(`/v1/lancamentos/recorrencias/${recorrenciaId}/ajustarparcelas`, { method: "PATCH", body }),
  },
  {
    name: "trinks_listar_categorias_lancamento",
    title: "Listar categorias de lançamento",
    description: "Lista as categorias de lançamento (receitas e despesas). Read-only.",
    inputSchema: {
      apenasAtivos: z.boolean().optional().describe("false = inclui categorias inativas"),
      page: pagination.page,
      pageSize: z.number().int().min(1).max(50).optional().describe("Itens por página (padrão 10, máximo 50)"),
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/lancamentos/categorias", { params: a }),
  },
  {
    name: "trinks_listar_formas_pagamento",
    title: "Listar formas de pagamento",
    description: "Lista as formas de pagamento do estabelecimento. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/formaspagamentos", { params: a }),
  },
  {
    name: "trinks_listar_motivos_desconto",
    title: "Listar motivos de desconto",
    description: "Lista os motivos de desconto cadastrados. Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/motivosdescontos", { params: a }),
  },

  // ── FIDELIDADE ────────────────────────────────────────────────────────────
  {
    name: "trinks_listar_movimentacoes_fidelidade",
    title: "Listar movimentações de fidelidade",
    description: "Lista movimentações de pontos do programa de fidelidade, por tipo (máx 90 dias por consulta). Read-only.",
    inputSchema: {
      tipo: z
        .number()
        .int()
        .min(1)
        .max(4)
        .describe("1 = Pontos ganhos, 2 = Pontos usados, 3 = A consumir, 4 = Pontos transferidos"),
      dataInicio: z.string().describe("Início do período (YYYY-MM-DD)"),
      dataFim: z.string().describe("Fim do período, inclusivo, até 90 dias depois do início"),
      pessoaFisicaClienteId: z
        .number()
        .int()
        .optional()
        .describe("O `pessoaFisicaId` de trinks_obter_cliente (não o id do cliente)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/fidelidade", { params: a }),
  },

  // ── CLUBE DE ASSINATURAS ──────────────────────────────────────────────────
  {
    name: "trinks_listar_planos_assinatura",
    title: "Listar planos de assinatura",
    description: "Lista os planos do clube de assinaturas (padrão: só ativos). Read-only.",
    inputSchema: {
      nome: z.string().optional().describe("Começo do nome do plano"),
      somenteAtivos: z.boolean().optional().describe("false = inclui planos inativos"),
      ordenarPor: z.enum(["AssinaturasMaisRecente", "Nome", "Status"]).optional().describe("Ordenação (padrão: mais recente)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/clube/planos", { params: a }),
  },
  {
    name: "trinks_obter_plano_assinatura",
    title: "Obter plano de assinatura",
    description: "Detalhes de um plano do clube (inclusive inativo). Read-only.",
    inputSchema: { planoId: z.number().int().describe("ID do plano") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clube/planos/${a.planoId}`),
  },
  {
    name: "trinks_listar_assinaturas",
    title: "Listar assinaturas",
    description: "Lista as assinaturas do clube, de todos os status por padrão. Read-only.",
    inputSchema: {
      clienteNome: z.string().optional().describe("Começo do nome do cliente"),
      clienteCpf: z.string().optional().describe("CPF completo do cliente, só números"),
      planoId: z.number().int().optional().describe("ID do plano"),
      status: z
        .enum([
          "Ativa",
          "Atrasada",
          "SuspensaPorFaltaDePagamento",
          "Cancelada",
          "Encerrada",
          "AguardandoPagamento",
          "CanceladaEmPeriodoDeConsumo",
          "ContratoPendente",
          "AguardandoPagamentoDaMultaDeCancelamento",
          "PagamentoBloqueado",
        ])
        .optional()
        .describe("Status; omitido, traz todos"),
      ordenarPor: z
        .enum(["AssinaturaMaisRecente", "ClienteNome", "AssinaturaNome", "Status", "ProximoPagamento", "CobrancaEncerraApos"])
        .optional()
        .describe("Ordenação (padrão: mais recente)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/clube/assinaturas", { params: a }),
  },
  {
    name: "trinks_saldo_assinatura",
    title: "Saldo de benefícios da assinatura",
    description: "Saldo dos benefícios ativos de uma assinatura: quantidade disponibilizada, consumida e restante. Read-only.",
    inputSchema: { assinaturaId: z.number().int().describe("ID da assinatura") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/clube/assinaturas/${a.assinaturaId}/saldo`),
  },
  {
    name: "trinks_listar_consumos_assinatura",
    title: "Listar consumos de assinatura",
    description: "Lista os consumos de benefícios de assinatura no estabelecimento. Read-only.",
    inputSchema: {
      dataInicial: z.string().optional().describe("Consumos depois deste instante (YYYY-MM-DDTHH:mm:ss)"),
      dataFinal: z.string().optional().describe("Consumos antes deste instante; sem hora, o próprio dia fica de fora"),
      clienteId: z.number().int().optional().describe("ID do cliente"),
      planoId: z.number().int().optional().describe("ID do plano"),
      itemConsumidoNome: z.string().optional().describe("Começo do nome do item consumido"),
      profissionalId: z
        .number()
        .int()
        .optional()
        .describe("O `idProfissional` de trinks_listar_profissionais (não o `id`)"),
      ordenarPor: z
        .enum(["AtendimentoMaisRecente", "ClienteNome", "AssinaturaNome", "ItemConsumidoNome", "ProfissionalNome"])
        .optional()
        .describe("Ordenação (padrão: mais recente)"),
      ...pagination,
    },
    annotations: READ,
    call: (c, a) => c.request("/v1/clube/consumo", { params: a }),
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
    description: "Lista todas as etiquetas do estabelecimento (de agendamento e de cliente). Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/etiquetas"),
  },
  {
    name: "trinks_obter_etiqueta",
    title: "Obter etiqueta",
    description: "Detalhes de uma etiqueta do estabelecimento. Read-only.",
    inputSchema: { etiquetaId: z.number().int().describe("ID da etiqueta") },
    annotations: READ,
    call: (c, a) => c.request(`/v1/etiquetas/${a.etiquetaId}`),
  },
  {
    name: "trinks_criar_etiqueta",
    title: "Criar etiqueta",
    description:
      "Cria uma etiqueta. Máximo de 10 ativas no estabelecimento, cada uma com uma cor diferente. Ação de escrita — cria um recurso novo.",
    inputSchema: {
      tipoId: z.number().int().min(1).max(2).describe("1 = Agendamento, 2 = Cliente"),
      conteudo: z.string().max(200).describe("Texto da etiqueta (até 200 caracteres)"),
      cor: z.enum(ETIQUETA_CORES).describe("Cor, diferente da de outra etiqueta ativa"),
    },
    annotations: CREATE,
    call: (c, a) => c.request("/v1/etiquetas", { method: "POST", body: a }),
  },
  {
    name: "trinks_editar_etiqueta",
    title: "Editar etiqueta",
    description: "Edita o texto e/ou a cor de uma etiqueta. Escrita idempotente.",
    inputSchema: {
      etiquetaId: z.number().int().describe("ID da etiqueta"),
      conteudo: z.string().max(200).optional().describe("Texto da etiqueta (até 200 caracteres)"),
      cor: z.enum(ETIQUETA_CORES).optional().describe("Cor, diferente da de outra etiqueta ativa"),
    },
    annotations: UPDATE,
    call: (c, { etiquetaId, ...body }) => c.request(`/v1/etiquetas/${etiquetaId}`, { method: "PUT", body }),
  },
  {
    name: "trinks_remover_etiqueta",
    title: "Remover etiqueta",
    description: "Remove uma etiqueta do estabelecimento; ela some de todos os clientes associados. DESTRUTIVO.",
    inputSchema: { etiquetaId: z.number().int().describe("ID da etiqueta") },
    annotations: DELETE,
    call: (c, a) => c.request(`/v1/etiquetas/${a.etiquetaId}`, { method: "DELETE" }),
  },

  // ── ESTABELECIMENTO / CONTA ───────────────────────────────────────────────
  {
    name: "trinks_detalhes_estabelecimento",
    title: "Detalhes do estabelecimento",
    description: "Detalhes do estabelecimento configurado nesta sessão. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request(`/v1/estabelecimentos/${c.establishmentId}`),
  },
  {
    name: "trinks_listar_estabelecimentos",
    title: "Listar estabelecimentos",
    description:
      "Lista os estabelecimentos que a API key acessa (inclusive unidades de franquias ligadas à conta). Read-only.",
    inputSchema: { ...pagination },
    annotations: READ,
    call: (c, a) => c.request("/v1/estabelecimentos", { params: a }),
  },
  {
    name: "trinks_consumo_api",
    title: "Consumo da API",
    description: "Consumo da API Trinks no mês vigente (contado em UTC): cota e saldo restante. Read-only.",
    inputSchema: {},
    annotations: READ,
    call: (c) => c.request("/v1/consumo"),
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
