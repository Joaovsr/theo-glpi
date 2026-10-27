import { randomUUID } from 'node:crypto';
import categories from '../config/categories.json' with { type: 'json' };

const help = 'Olá! Sou o Theo. Conte o que está acontecendo para eu tentar ajudar e entender melhor o problema. Se preferir atendimento pelo suporte, digite “abrir chamado”. Use “status” para consultar seus chamados e “cancelar” para descartar um rascunho.';
const statuses = { 1: 'Novo', 2: 'Em atendimento', 3: 'Planejado', 4: 'Pendente', 5: 'Solucionado', 6: 'Fechado' };
const statusName = (status) => statuses[status] ?? `Status ${status}`;
const ticketLink = (id) => `http://127.0.0.1:8088/front/ticket.form.php?id=${id}`;
const navigation = {
  help: { title: '💬 Preciso de ajuda', data: { action: 'ajudar' } },
  open: { title: '📝 Abrir chamado', data: { action: 'abrir chamado' } },
  status: { title: '📋 Meus chamados', data: { action: 'status' } },
};

function actionCard(text, actions) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.5',
    body: [{ type: 'TextBlock', text, wrap: true }],
    // O Playground rejeita cliques sem verb antes de enviar a ação ao bot.
    actions: actions.map((action) => ({ type: 'Action.Execute', verb: action.data.action, ...action })),
  };
}

const sendActions = (send, text, actions) => send(text, 'plain', actionCard(markdownText(text), actions));

function markdownText(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}

export function plainText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html ?? '')
    .replace(/<br\s*\/?\s*>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => entities[entity])
    .trim();
}

export function createTheo({ glpi, store, notify, agent }) {
  if (!categories.length || categories.some(({ id }) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Sincronize config/categories.json usando seed-demo.php antes de iniciar o Theo.');
  }
  const queues = new Map();
  let polling = false;
  // shortcut: catálogo local; sincronizar o seed após alterações de categorias e consultar o GLPI dinamicamente antes de permitir edição externa.
  const categoryFor = (key) => categories.find((category) => category.key === key) ?? categories.find(({ key }) => key === 'geral');
  const draftSummary = (draft) => [
    '📝 **Confira o chamado**',
    `🖥️ **Problema:** ${markdownText(draft.description)}`,
    `🏷️ **Categoria:** ${markdownText(categoryFor(draft.category).name)}`,
    ...(draft.reason ? [`💡 **Motivo:** ${markdownText(draft.reason)}`] : []),
    '👤 **Solicitante:** usuario.demo',
    '**Como deseja continuar?**',
    'Use os botões abaixo. Se preferir, digite **confirmar** ou **cancelar**.',
  ].join('\n\n');
  async function showDraft(conversation, send) {
    conversation.draft.reviewed = false;
    conversation.draft.reviewToken = randomUUID();
    store.save();
    const summary = draftSummary(conversation.draft);
    const card = actionCard(summary, [
        { title: '✅ Confirmar', action: 'confirmar', style: 'positive' },
        { title: '✏️ Corrigir', action: 'corrigir' },
        { title: '❌ Cancelar', action: 'cancelar', style: 'destructive' },
      ].map(({ title, action, style }) => ({
        title, ...(style ? { style } : {}),
        data: { action, reviewToken: conversation.draft.reviewToken },
      })));
    await send(summary, 'markdown', card);
    conversation.draft.reviewed = true;
    store.save();
  }

  function showIntake(conversation, send) {
    return sendActions(send, conversation.intake.question, [
      { title: '⏭️ Registrar assim mesmo', data: { action: 'registrar assim mesmo', intakeToken: conversation.intake.token } },
      { title: '❌ Cancelar', style: 'destructive', data: { action: 'cancelar', intakeToken: conversation.intake.token } },
    ]);
  }

  async function handleMessage(activity, send) {
    const id = activity.conversation.id;
    const conversation = store.data.conversations[id] ??= { tickets: {} };
    conversation.ref = { conversation: activity.conversation, bot: activity.recipient };
    const text = typeof activity.text === 'string' ? activity.text.trim() : '';
    const command = text.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu, '');

    if (!text || /^(oi|ola|ajuda|menu)[!.?]*$/.test(command)) return sendActions(send, help, Object.values(navigation));
    if (command === 'ajudar') {
      delete conversation.intake;
      if (conversation.draft) conversation.draft.reviewed = false;
      store.save();
      return sendActions(send, '💬 Conte o que está acontecendo e em qual equipamento ou sistema. Vou tentar ajudar com passos simples.', [navigation.open, navigation.status]);
    }
    if (text.length > 4_000) return send('Descreva o problema em até 4.000 caracteres.');
    if (command === 'cancelar') {
      delete conversation.draft;
      delete conversation.intake;
      delete conversation.history;
      store.save();
      return sendActions(send, 'Rascunho descartado. Quando precisar, digite “abrir chamado”.', Object.values(navigation));
    }
    if (command === 'corrigir') {
      if (!conversation.draft) return conversation.intake ? showIntake(conversation, send) : sendActions(send, 'Ainda não há um rascunho. Conte o problema que deseja registrar.', [navigation.open, navigation.help]);
      conversation.draft.reviewed = false;
      store.save();
      return sendActions(send, '✏️ Envie o que deseja corrigir na descrição. Vou atualizar o resumo para você revisar antes de abrir o chamado. Se preferir descartar, clique em Cancelar ou digite “cancelar”.', [
        { title: '↩️ Rever resumo', data: { action: 'revisar', reviewToken: conversation.draft.reviewToken } },
        { title: '❌ Cancelar', style: 'destructive', data: { action: 'cancelar', reviewToken: conversation.draft.reviewToken } },
      ]);
    }
    if (command === 'revisar') return conversation.draft ? showDraft(conversation, send) : send('Ainda não há um rascunho para revisar.');
    if (/^(status|meus chamados)$/.test(command)) {
      const ids = Object.keys(conversation.tickets);
      if (!ids.length) return sendActions(send, 'Você ainda não abriu chamados nesta conversa. Digite “abrir chamado” para começar.', [navigation.open, navigation.help]);
      const lines = [];
      for (const id of ids) {
        const { ticket } = await glpi.getUpdates(Number(id));
        lines.push(`#${id} — ${statusName(ticket.status)}: ${plainText(ticket.name)}\n${ticketLink(id)}`);
      }
      return sendActions(send, lines.join('\n\n'), [navigation.open, { ...navigation.status, title: '🔄 Atualizar status' }]);
    }
    if (command === 'confirmar') {
      if (conversation.intake) return showIntake(conversation, send);
      const draft = conversation.draft;
      if (!draft?.description) return send('Descreva primeiro o problema que deseja registrar.');
      if (draft.reviewed === false) return showDraft(conversation, send);
      let ticketId;
      try {
        ticketId = await glpi.createTicket(draft.description, draft.reference, categoryFor(draft.category).id);
      } catch (error) {
        console.warn(error.message);
        return send('Não consegui confirmar o resultado no GLPI. Seu rascunho foi mantido. Digite “confirmar” para tentar novamente com a mesma referência.');
      }
      conversation.tickets[ticketId] = { status: 1, lastFollowupId: 0 };
      delete conversation.draft;
      store.save();
      return sendActions(send, `Chamado #${ticketId} aberto na categoria ${categoryFor(draft.category).name} para o usuário de demonstração.\n${ticketLink(ticketId)}\nVou avisar aqui quando houver uma resposta pública ou mudança de status.`, [navigation.status, navigation.open]);
    }
    if (/^(abrir|novo)( chamado)?$/.test(command)) {
      if (conversation.draft) return showDraft(conversation, send);
      if (conversation.intake) return showIntake(conversation, send);
      return send('Descreva o problema e, se possível, a mensagem de erro, o impacto e o que já tentou.');
    }
    if (agent) {
      let result;
      try {
        result = await agent.respond({ text, history: conversation.history, draft: conversation.draft, intake: conversation.intake,
          ticketIds: Object.keys(conversation.tickets).slice(-50),
          runTool: async (name, args) => {
            if (name === 'request_details') {
              if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 600
                  || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 2000) throw new Error('Pergunta ou contexto inválido.');
              return { intake: { question: args.question.trim(), summary: args.summary.trim() } };
            }
            if (name === 'prepare_ticket') {
              if (typeof args.description !== 'string' || args.description.trim().length < 10 || args.description.length > 4000
                  || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 240
                  || !categories.some(({ key }) => key === args.category)) throw new Error('Rascunho inválido.');
              return { draft: { description: args.description.trim(), category: args.category, reason: args.reason.trim() } };
            }
            const readTicket = async (id) => {
              if (!Number.isSafeInteger(id) || !Object.hasOwn(conversation.tickets, id)) throw new Error('Chamado fora desta conversa.');
              const { ticket, followups = [] } = await glpi.getUpdates(id);
              return { id, name: plainText(ticket.name).slice(0, 200), status: statusName(ticket.status), url: ticketLink(id),
                replies: followups.filter((item) => Number(item.is_private) === 0).slice(-5)
                  .map((item) => plainText(item.content).slice(0, 1500)) };
            };
            if (name === 'list_tickets') {
              const tickets = [];
              for (const id of Object.keys(conversation.tickets).slice(-10)) {
                const { replies, ...ticket } = await readTicket(Number(id));
                tickets.push(ticket);
              }
              return { tickets };
            }
            if (name === 'get_ticket') return readTicket(args.ticket_id);
            throw new Error('Ferramenta não permitida.');
          },
        });
      } catch (error) {
        console.warn(error.message);
        return send('Não consegui consultar a IA agora. Seu rascunho foi preservado e nenhum chamado foi aberto. Você ainda pode usar “status”, “confirmar” ou “cancelar”.');
      }
      if (result.intake) {
        delete conversation.draft;
        conversation.intake = { ...result.intake, token: randomUUID() };
        store.save();
        return showIntake(conversation, send);
      }
      if (result.draft) {
        delete conversation.intake;
        conversation.draft = { ...result.draft, reference: randomUUID() };
        store.save();
        return showDraft(conversation, send);
      }
      if (conversation.draft) {
        conversation.draft.reviewed = false;
        store.save();
      }
      return send(result.text);
    }
    if (text.length < 10) return send('Conte um pouco mais sobre o problema para que o chamado fique claro.');
    conversation.draft = { description: text, category: 'geral', reference: randomUUID() };
    store.save();
    return showDraft(conversation, send);
  }

  return {
    handle(activity, send) {
      const id = activity.conversation.id;
      const pending = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (activity.value != null) {
          const value = activity.value;
          const conversation = store.data.conversations[id];
          const draft = conversation?.draft;
          const intake = conversation?.intake;
          const validObject = typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'action');
          const isNavigation = validObject && ['ajudar', 'ajuda', 'abrir chamado', 'status'].includes(value.action);
          const isIntake = validObject && ['registrar assim mesmo', 'cancelar'].includes(value.action)
            && typeof value.intakeToken === 'string' && value.intakeToken === intake?.token;
          const isDraft = validObject && ['confirmar', 'corrigir', 'cancelar', 'revisar'].includes(value.action)
            && typeof value.reviewToken === 'string' && value.reviewToken === draft?.reviewToken;
          if (!isNavigation && !isIntake && !isDraft) {
            return send('Este botão não está mais ativo. Use os botões mais recentes; para retomar o pedido atual, digite “abrir chamado”.');
          }
          if (value.action === 'confirmar' && draft.reviewed !== true) {
            return send('O rascunho precisa ser revisado novamente. Envie sua correção ou digite “confirmar” para ver o resumo atualizado.');
          }
          activity = { ...activity, text: value.action === 'registrar assim mesmo'
            ? 'Quero registrar o pedido com as informações que já forneci, sem responder mais perguntas.' : value.action };
        }
        const reply = async (text, textFormat = 'plain', card) => {
          await send(text, textFormat, card);
          const conversation = store.data.conversations[id];
          const history = conversation.history ?? [];
          conversation.history = [...history, { role: 'user', content: String(activity.text ?? '').slice(0, 4000) },
            { role: 'assistant', content: text.slice(0, 4000) }].slice(-12);
          store.save();
        };
        return handleMessage(activity, reply);
      });
      queues.set(id, pending);
      return pending.finally(() => { if (queues.get(id) === pending) queues.delete(id); });
    },

    async poll() {
      if (polling) return;
      polling = true;
      try {
        for (const conversation of Object.values(store.data.conversations)) {
          for (const [id, checkpoint] of Object.entries(conversation.tickets)) {
            try {
              const { ticket, followups } = await glpi.getUpdates(Number(id));
              if (Number(ticket.status) !== checkpoint.status) {
                await notify(conversation.ref, `Chamado #${id}: ${statusName(ticket.status)}.\n${ticketLink(id)}`);
                checkpoint.status = Number(ticket.status);
                store.save();
              }
              for (const followup of followups) {
                if (Number(followup.is_private) !== 0 || Number(followup.id) <= checkpoint.lastFollowupId) continue;
                await notify(conversation.ref, `Nova resposta no chamado #${id}:\n${plainText(followup.content)}\n${ticketLink(id)}`);
                checkpoint.lastFollowupId = Number(followup.id);
                // shortcut: uma queda entre envio e gravação pode repetir o aviso; usar entrega idempotente antes de produção.
                store.save();
              }
            } catch (error) {
              console.warn(`Não foi possível atualizar o chamado #${id}: ${error.message}`);
            }
          }
        }
      } finally {
        polling = false;
      }
    },
  };
}
