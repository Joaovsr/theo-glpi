import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../src/agent.mjs';
import { createTheo } from '../src/theo.mjs';
import categories from '../config/categories.json' with { type: 'json' };
import scenarios from '../test/fixtures/intake.json' with { type: 'json' };

async function main() {
  const agent = createAgent({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-6-luna', categories });
  let passed = 0;
  for (const scenario of scenarios) {
    const id = randomUUID();
    const store = { data: { conversations: Object.create(null) }, save() {} };
    let writes = 0;
    const theo = createTheo({ agent, store, notify: async () => {}, glpi: {
      createTicket: async () => { writes++; throw new Error('Este teste não permite gravar chamados.'); },
    } });
    if (scenario.previousDraft) store.data.conversations[id] = { tickets: {}, draft: {
      description: scenario.previousDraft, category: 'equipamentos', reference: randomUUID(), reviewed: true, reviewToken: randomUUID(),
    } };
    const input = async (text, value) => {
      const replies = [];
      await theo.handle({ text, value, conversation: { id }, recipient: { id: 'theo-intake-check' } }, async (text, format, card) => { replies.push({ text, card }); });
      assert.ok(replies.length && !replies.at(-1).text.includes('Não consegui consultar a IA'), 'A OpenAI não respondeu ao cenário.');
      return replies.at(-1);
    };
    try {
      const first = await input(scenario.request);
      const state = store.data.conversations[id];
      if (!scenario.ready) {
        assert.equal(state.draft, undefined, 'Preparou o resumo antes de coletar detalhes.');
        assert.ok(state.intake, 'Não entrou na coleta de informações.');
        assert.match(first.text, new RegExp(scenario.questionPattern, 'i'));
        assert.ok((first.text.match(/\?/g) ?? []).length <= 2, 'Fez perguntas demais de uma vez.');
        assert.ok(!first.card.actions.some(({ data }) => data.action === 'confirmar'), 'Mostrou confirmação antes da coleta.');
        console.log(`${scenario.name}: ${first.text}`);
        await input('confirmar');
        assert.equal(state.draft, undefined, 'Confirmar pulou a coleta pendente.');
        if (scenario.skip) {
          await input(undefined, { action: 'registrar assim mesmo', intakeToken: state.intake.token });
        } else {
          await input(scenario.answer);
        }
      }
      assert.ok(state.draft, 'Não preparou o resumo após obter dados suficientes ou aceitar a escolha do usuário.');
      assert.equal(state.intake, undefined);
      assert.equal(state.draft.category, scenario.category);
      for (const detail of scenario.details) assert.ok(state.draft.description.toLowerCase().includes(detail.toLowerCase()), `Perdeu o detalhe: ${detail}`);
      assert.doesNotMatch(state.draft.description, /n[aã]o informou|n[aã]o foram informad|n[aã]o foi informad/i, 'Incluiu uma lista de informações ausentes.');
      assert.equal(writes, 0, 'A coleta abriu um chamado.');
      passed++;
      console.log(`OK: ${scenario.name} — coleta, revisão e contexto preservados.`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`FALHOU: ${scenario.name} — ${error.message}`);
    }
  }
  console.log(`Resultado: ${passed}/${scenarios.length} cenários de coleta aprovados com a OpenAI real; sem gravar chamados.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
