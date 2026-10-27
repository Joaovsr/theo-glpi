import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createTheo } from '../src/theo.mjs';

function setup(t, glpi, notify = async () => {}, agent) {
  const directory = mkdtempSync(join(tmpdir(), 'theo-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const store = createStore(file);
  const theo = createTheo({ glpi, store, notify, agent });
  const replies = [];
  const send = (text, id = 'chat-a') => theo.handle({
    text, conversation: { id }, recipient: { id: 'theo' },
  }, async (reply, _format, card) => {
    if (card) assert.ok(card.actions.every(({ type, verb }) => type === 'Action.Execute' && typeof verb === 'string' && verb.trim()),
      'O Playground exige verb em todos os botões Action.Execute.');
    replies.push(reply);
  });
  return { store, file, theo, replies, send };
}

test('exige confirmação, permite cancelar e serializa confirmações repetidas', async (t) => {
  let created = 0;
  const { store, send, replies } = setup(t, { createTicket: async () => { created++; return 42; } });
  await send('confirmar');
  await send('Meu computador não consegue acessar a rede.');
  assert.equal(created, 0);
  await send('cancelar');
  await send('confirmar');
  assert.equal(created, 0);
  await send('Meu computador continua sem conexão de rede.');
  await Promise.all([send('confirmar'), send('confirmar')]);
  assert.equal(created, 1);
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  assert.deepEqual(Object.keys(store.data.conversations['chat-a'].tickets), ['42']);
  assert.ok(replies.some((reply) => reply.includes('Chamado #42 aberto')));
});

test('mantém a referência após falha e recupera o rascunho depois de reiniciar', async (t) => {
  const references = [];
  const glpi = { createTicket: async (_description, reference) => {
    references.push(reference);
    if (references.length === 1) throw new Error('Falha de rede simulada');
    return 43;
  } };
  const { store, file, send, replies } = setup(t, glpi);
  await send('Não consigo imprimir o relatório de teste.');
  await send('confirmar');
  assert.match(replies.at(-1), /rascunho foi mantido/);
  const reloaded = createStore(file);
  assert.deepEqual(reloaded.data.conversations['chat-a'].draft, store.data.conversations['chat-a'].draft);
  const restarted = createTheo({ glpi, store: reloaded, notify: async () => {} });
  await restarted.handle({ text: 'confirmar', conversation: { id: 'chat-a' }, recipient: { id: 'theo' } }, async () => {});
  assert.equal(references.length, 2);
  assert.equal(references[0], references[1]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('consulta apenas chamados acompanhados pela própria conversa', async (t) => {
  const requested = [];
  const { send, replies } = setup(t, {
    createTicket: async () => 44,
    getUpdates: async (id) => { requested.push(id); return { ticket: { name: 'Teste', status: 2 } }; },
  });
  await send('Solicitação de suporte para o computador.');
  await send('confirmar');
  await send('status', 'chat-b');
  assert.equal(requested.length, 0);
  await send('status');
  assert.deepEqual(requested, [44]);
  assert.match(replies.at(-1), /#44 — Em atendimento/);
});

test('avisa status e respostas públicas, ignora notas privadas e repete apenas entregas que falharam', async (t) => {
  const delivered = [];
  let fail = true;
  const { send, theo, store } = setup(t, {
    createTicket: async () => 45,
    getUpdates: async () => ({ ticket: { status: 2 }, followups: [
      { id: 1, is_private: 1, content: 'SEGREDO INTERNO' },
      { id: 2, is_private: 0, content: '<p>Olá &amp; obrigado.<br>Estou verificando.</p>' },
    ] }),
  }, async (ref, text) => {
    if (text.includes('Nova resposta') && fail) { fail = false; throw new Error('Entrega indisponível'); }
    delivered.push({ ref, text });
  });
  await send('Computador sem acesso ao sistema de demonstração.');
  await send('confirmar');
  await theo.poll();
  assert.equal(store.data.conversations['chat-a'].tickets[45].lastFollowupId, 0);
  await theo.poll();
  await theo.poll();
  assert.equal(delivered.length, 2);
  assert.match(delivered[0].text, /Em atendimento/);
  assert.match(delivered[1].text, /Olá & obrigado.\nEstou verificando/);
  assert.ok(delivered.every(({ ref, text }) => ref.conversation.id === 'chat-a' && !text.includes('SEGREDO')));
});

test('estado inválido não é sobrescrito e IDs especiais não alteram o protótipo', async (t) => {
  const { file, send, store } = setup(t, {});
  await send('Uma descrição de teste válida.', '__proto__');
  assert.equal(Object.getPrototypeOf(store.data.conversations), null);
  assert.equal({}.draft, undefined);
  writeFileSync(file, '{conteúdo inválido');
  assert.throws(() => createStore(file), SyntaxError);
  assert.equal(readFileSync(file, 'utf8'), '{conteúdo inválido');
});

test('a IA classifica o rascunho e só a confirmação grava a categoria escolhida no GLPI', async (t) => {
  const creations = [];
  const { send, replies, store } = setup(t, { createTicket: async (...args) => { creations.push(args); return 46; } }, undefined, {
    respond: async ({ runTool }) => runTool('prepare_ticket', {
      description: 'Computador não conecta ao Wi-Fi.', category: 'rede', reason: 'Falha de conectividade.',
    }),
  });
  await send('Pode registrar o problema do meu Wi-Fi?');
  assert.equal(creations.length, 0);
  assert.match(replies.at(-1), /\*\*Categoria:\*\* Redes e conectividade/);
  assert.equal(store.data.conversations['chat-a'].draft.reviewed, true);
  await send('confirmar');
  assert.equal(creations.length, 1);
  assert.equal(creations[0][2], 3);
  assert.match(replies.at(-1), /aberto na categoria Redes e conectividade/);
});

test('as ferramentas da IA restringem chamados à conversa e removem notas privadas', async (t) => {
  const requested = [];
  const { send, store } = setup(t, {
    getUpdates: async (id) => {
      requested.push(id);
      return { ticket: { name: 'Teste', status: 2 }, followups: [
        { id: 1, is_private: 1, content: 'SEGREDO' }, { id: 2, is_private: 0, content: '<p>Resposta pública</p>' },
      ] };
    },
  }, undefined, { respond: async ({ runTool }) => {
    await assert.rejects(runTool('get_ticket', { ticket_id: 99 }), /fora desta conversa/);
    await assert.rejects(runTool('prepare_ticket', { description: 'Descrição válida de teste', category: 'categoria-inventada', reason: 'Teste' }), /inválido/);
    const details = await runTool('get_ticket', { ticket_id: 47 });
    assert.deepEqual(details.replies, ['Resposta pública']);
    assert.ok(!JSON.stringify(details).includes('SEGREDO'));
    return { text: 'O chamado está em atendimento.' };
  } });
  store.data.conversations['chat-a'] = { tickets: { 47: { status: 1, lastFollowupId: 0 } } };
  store.data.conversations['chat-b'] = { tickets: { 99: { status: 1, lastFollowupId: 0 } } };
  await send('Como está meu chamado e qual a última resposta?');
  assert.deepEqual(requested, [47]);
});

test('se a entrega do resumo falhar, a próxima confirmação reapresenta o resumo antes de gravar', async (t) => {
  let created = 0;
  const { theo, send, replies } = setup(t, { createTicket: async () => { created++; return 48; } });
  await assert.rejects(theo.handle({ text: 'Computador com problema de conexão.', conversation: { id: 'chat-a' }, recipient: { id: 'theo' } },
    async () => { throw new Error('Entrega falhou'); }), /Entrega falhou/);
  await send('confirmar');
  assert.equal(created, 0);
  assert.match(replies.at(-1), /Confira o chamado/);
  await send('confirmar');
  assert.equal(created, 1);
});

test('indisponibilidade da IA mantém o rascunho e cancelar limpa o histórico anterior', async (t) => {
  const { send, store, replies } = setup(t, {}, undefined, { respond: async () => { throw new Error('OpenAI indisponível'); } });
  store.data.conversations['chat-a'] = { tickets: {}, draft: { description: 'Relato anterior.', reference: 'referencia-preservada', category: 'geral' },
    history: [{ role: 'user', content: 'conteúdo antigo' }] };
  await send('Preciso corrigir meu relato.');
  assert.equal(store.data.conversations['chat-a'].draft.reference, 'referencia-preservada');
  assert.match(replies.at(-1), /nenhum chamado foi aberto/);
  await send('cancelar');
  assert.ok(!JSON.stringify(store.data.conversations['chat-a'].history).includes('conteúdo antigo'));
});

test('perguntas de diagnóstico mantêm o histórico e não preparam nem abrem chamado', async (t) => {
  let requests = 0;
  const { send, store } = setup(t, { createTicket: async () => assert.fail('diagnóstico não deve abrir chamado') }, undefined, {
    respond: async ({ text, history }) => {
      requests++;
      if (requests === 1) return { text: 'Qual mensagem de erro aparece e em qual aplicativo?' };
      assert.ok(history.some((item) => item.content === 'Estou com um problema no computador.'));
      assert.ok(history.some((item) => item.content.includes('mensagem de erro')));
      assert.equal(text, 'No Excel aparece o erro E500.');
      return { text: 'Isso acontece em todas as planilhas ou somente em uma?' };
    },
  });
  await send('Estou com um problema no computador.');
  await send('No Excel aparece o erro E500.');
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  assert.equal(Object.keys(store.data.conversations['chat-a'].tickets).length, 0);
  assert.equal(requests, 2);
});

test('sim durante a ajuda não grava um rascunho e confirmar exige revisão após retomar o diagnóstico', async (t) => {
  let created = 0;
  const { send, store, replies } = setup(t, { createTicket: async () => { created++; return 49; } }, undefined, {
    respond: async () => ({ text: 'A conexão voltou a funcionar depois desse passo?' }),
  });
  store.data.conversations['chat-a'] = { tickets: {}, draft: {
    description: 'Notebook sem conexão.', category: 'rede', reference: 'referencia-do-teste', reviewed: true,
  } };
  await send('Antes de abrir, quero tentar resolver.');
  await send('sim');
  assert.equal(created, 0);
  assert.equal(store.data.conversations['chat-a'].draft.reviewed, false);
  await send('confirmar');
  assert.equal(created, 0);
  assert.match(replies.at(-1), /Confira o chamado/);
  await send('confirmar');
  assert.equal(created, 1);
});

test('o resumo usa Markdown e preserva o relato original sem interpretar sua marcação', async (t) => {
  const description = 'Computador **não liga**. [confirmar](https://exemplo.invalid) <img src=x>';
  const { theo, store } = setup(t, {}, undefined, { respond: async ({ runTool }) => runTool('prepare_ticket', {
    description, category: 'equipamentos', reason: 'Equipamento com falha <elétrica>.',
  }) });
  const messages = [];
  await theo.handle({ text: 'Abra um chamado para meu computador.', conversation: { id: 'chat-a' }, recipient: { id: 'theo' } },
    async (text, textFormat, card) => { messages.push({ text, textFormat, card }); });
  const summary = messages.at(-1);
  assert.equal(summary.textFormat, 'markdown');
  assert.ok(summary.text.startsWith('📝 **Confira o chamado**\n\n'));
  assert.match(summary.text, /\n\n🏷️ \*\*Categoria:\*\* Equipamentos e periféricos/);
  assert.deepEqual(summary.card.actions.map(({ title }) => title), ['✅ Confirmar', '✏️ Corrigir', '❌ Cancelar']);
  assert.ok(summary.card.actions.every(({ type, data }) => type === 'Action.Execute' && data.reviewToken === store.data.conversations['chat-a'].draft.reviewToken));
  assert.ok(summary.text.includes('\\*\\*não liga\\*\\*'));
  assert.ok(summary.text.includes('\\[confirmar\\]\\('));
  assert.ok(summary.text.includes('&lt;img src=x&gt;'));
  assert.ok(summary.text.includes('&lt;elétrica&gt;'));
  assert.equal(store.data.conversations['chat-a'].draft.description, description);
});

test('confirmar pelo botão abre uma vez e rejeita reenvio, token falso e outra conversa', async (t) => {
  let created = 0;
  const { theo, send, store } = setup(t, { createTicket: async () => { created++; return 50; } });
  await send('Meu computador não está ligando.');
  const reviewToken = store.data.conversations['chat-a'].draft.reviewToken;
  const click = (value, id = 'chat-a') => theo.handle({ conversation: { id }, recipient: { id: 'theo' }, value }, async () => {});
  await click({ action: 'confirmar', reviewToken: 'token-falso' });
  await click({ action: 'confirmar', reviewToken }, 'chat-b');
  assert.equal(created, 0);
  await Promise.all([click({ action: 'confirmar', reviewToken }), click({ action: 'confirmar', reviewToken })]);
  assert.equal(created, 1);
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
});

test('corrigir pelo botão preserva o rascunho, bloqueia confirmação antiga e cancelar o descarta', async (t) => {
  let created = 0;
  const { theo, send, store, replies } = setup(t, { createTicket: async () => { created++; return 51; } });
  await send('O computador está com problema de conexão.');
  const draft = store.data.conversations['chat-a'].draft;
  const originalReference = draft.reference;
  const click = (action, reviewToken) => theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value: { action, reviewToken } }, async (text) => { replies.push(text); });
  await click('corrigir', draft.reviewToken);
  assert.match(replies.at(-1), /Envie o que deseja corrigir/);
  assert.equal(draft.reference, originalReference);
  assert.equal(draft.reviewed, false);
  await click('confirmar', draft.reviewToken);
  assert.equal(created, 0);
  const oldToken = draft.reviewToken;
  await send('confirmar');
  assert.notEqual(draft.reviewToken, oldToken);
  assert.equal(draft.reference, originalReference);
  await click('confirmar', oldToken);
  assert.equal(created, 0);
  await click('cancelar', draft.reviewToken);
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
});

test('botões de um resumo anterior não confirmam nem cancelam uma descrição corrigida', async (t) => {
  const { theo, send, store } = setup(t, { createTicket: async () => assert.fail('botão antigo não deve abrir chamado') });
  await send('Descrição original do problema de demonstração.');
  const oldToken = store.data.conversations['chat-a'].draft.reviewToken;
  await send('Descrição corrigida do problema de demonstração.');
  const current = store.data.conversations['chat-a'].draft;
  for (const action of ['confirmar', 'cancelar', 'corrigir']) {
    await theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value: { action, reviewToken: oldToken } }, async () => {});
    assert.equal(store.data.conversations['chat-a'].draft, current);
  }
});

test('abrir chamado reapresenta um rascunho existente com botões novos sem criar nem trocar sua referência', async (t) => {
  const { send, store, replies } = setup(t, { createTicket: async () => assert.fail('reapresentar não deve abrir chamado') });
  await send('Meu computador não está ligando.');
  const draft = store.data.conversations['chat-a'].draft;
  const reference = draft.reference;
  const oldToken = draft.reviewToken;
  await send('abrir chamado');
  assert.equal(store.data.conversations['chat-a'].draft, draft);
  assert.equal(draft.reference, reference);
  assert.notEqual(draft.reviewToken, oldToken);
  assert.match(replies.at(-1), /Confira o chamado/);
});

test('coleta substitui um resumo antigo, persiste o pedido e bloqueia confirmação até haver contexto', async (t) => {
  let called = 0;
  const { send, store, file, replies, theo } = setup(t, { createTicket: async () => assert.fail('coleta não deve gravar chamado') }, undefined, {
    respond: async ({ runTool, intake }) => {
      called++;
      if (called === 1) return runTool('request_details', { question: 'Qual ERP e qual acesso você precisa?', summary: 'Pedido de acesso ao ERP.' });
      assert.equal(intake.summary, 'Pedido de acesso ao ERP.');
      return runTool('prepare_ticket', { description: 'Precisa consultar contas a pagar no Protheus para a rotina financeira.', category: 'acessos', reason: 'Acesso ao sistema.' });
    },
  });
  store.data.conversations['chat-a'] = { tickets: {}, draft: { description: 'Computador não liga.', reference: 'antiga', reviewed: true, reviewToken: 'resumo-antigo' } };
  await send('Quero abrir um chamado pedindo acesso ao ERP');
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  assert.match(createStore(file).data.conversations['chat-a'].intake.question, /Qual ERP/);
  await send('confirmar');
  assert.match(replies.at(-1), /Qual ERP/);
  assert.equal(called, 1);
  await theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value: { action: 'confirmar', reviewToken: 'resumo-antigo' } }, async () => {});
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  await send('Protheus, consultar contas a pagar para a rotina financeira.');
  assert.equal(store.data.conversations['chat-a'].intake, undefined);
  assert.equal(store.data.conversations['chat-a'].draft.category, 'acessos');
});

test('botão de registrar com dados disponíveis prepara revisão sem gravar e invalida ações da coleta', async (t) => {
  let called = 0;
  const { theo, send, store } = setup(t, { createTicket: async () => assert.fail('a revisão ainda exige confirmação') }, undefined, {
    respond: async ({ text, runTool }) => {
      if (called++ === 0) return runTool('request_details', { question: 'Qual ERP?', summary: 'Precisa de acesso ao ERP.' });
      assert.match(text, /sem responder mais perguntas/);
      return runTool('prepare_ticket', { description: 'Solicita acesso ao ERP para trabalhar.', category: 'acessos', reason: 'Pedido de acesso.' });
    },
  });
  await send('Quero abrir um chamado de acesso ao ERP.');
  const token = store.data.conversations['chat-a'].intake.token;
  const click = (action, intakeToken) => theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value: { action, intakeToken } }, async () => {});
  await click('registrar assim mesmo', token);
  const draft = store.data.conversations['chat-a'].draft;
  assert.ok(draft.reviewed);
  assert.equal(store.data.conversations['chat-a'].intake, undefined);
  await click('cancelar', token);
  assert.equal(store.data.conversations['chat-a'].draft, draft);
});

test('cancelamento da coleta exige o token atual e limpa contexto e perguntas pendentes', async (t) => {
  const { send, store, theo } = setup(t, {}, undefined, { respond: async ({ runTool }) => runTool('request_details', {
    question: 'Qual equipamento?', summary: 'Equipamento não liga.',
  }) });
  await send('Quero abrir um chamado para o computador.');
  const oldToken = store.data.conversations['chat-a'].intake.token;
  await send('Ainda não sei como descrever o equipamento.');
  const currentToken = store.data.conversations['chat-a'].intake.token;
  const click = (intakeToken) => theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value: { action: 'cancelar', intakeToken } }, async () => {});
  await click(oldToken);
  assert.equal(store.data.conversations['chat-a'].intake.token, currentToken);
  await click(currentToken);
  assert.equal(store.data.conversations['chat-a'].intake, undefined);
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  assert.ok(!JSON.stringify(store.data.conversations['chat-a'].history).includes('Qual equipamento'));
});

test('boas-vindas, ajuda, status e edição têm botões e navegação não autoriza gravação', async (t) => {
  const { theo, store } = setup(t, { createTicket: async () => assert.fail('navegação não deve abrir chamado') });
  const messages = [];
  const input = (text, value) => theo.handle({ text, value, conversation: { id: 'chat-a' }, recipient: { id: 'theo' } }, async (text, format, card) => { messages.push({ text, card }); });
  await input('oi');
  assert.deepEqual(messages.at(-1).card.actions.map(({ data }) => data.action), ['ajudar', 'abrir chamado', 'status']);
  await input(undefined, { action: 'status' });
  assert.match(messages.at(-1).text, /ainda não abriu chamados/);
  assert.ok(messages.at(-1).card.actions.some(({ data }) => data.action === 'abrir chamado'));
  await input(undefined, { action: 'confirmar' });
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  await input('Meu computador de demonstração não liga.');
  const token = store.data.conversations['chat-a'].draft.reviewToken;
  await input(undefined, { action: 'corrigir', reviewToken: token });
  assert.deepEqual(messages.at(-1).card.actions.map(({ data }) => data.action), ['revisar', 'cancelar']);
  for (const { card } of messages.filter(({ card }) => card)) {
    assert.ok(card.actions.every(({ verb }) => typeof verb === 'string' && verb.trim()), 'Botão sem verb é bloqueado no Playground.');
  }
});

test('mudar para ajuda encerra a coleta e invalida o botão antigo de registrar sem detalhes', async (t) => {
  const { theo, send, store } = setup(t, {}, undefined, { respond: async ({ runTool }) => runTool('request_details', {
    question: 'Qual ERP?', summary: 'Pedido de acesso ao ERP.',
  }) });
  await send('Quero acesso ao ERP.');
  const token = store.data.conversations['chat-a'].intake.token;
  const click = (value) => theo.handle({ conversation: { id: 'chat-a' }, recipient: { id: 'theo' }, value }, async () => {});
  await click({ action: 'ajudar' });
  assert.equal(store.data.conversations['chat-a'].intake, undefined);
  await click({ action: 'registrar assim mesmo', intakeToken: token });
  assert.equal(store.data.conversations['chat-a'].draft, undefined);
  assert.equal(store.data.conversations['chat-a'].intake, undefined);
});
