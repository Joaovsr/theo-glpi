import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../src/agent.mjs';
import { createGlpiClient } from '../src/glpi.mjs';
import { createTheo } from '../src/theo.mjs';
import categories from '../config/categories.json' with { type: 'json' };
import cases from '../test/fixtures/classification.json' with { type: 'json' };

async function main() {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('Configure OPENAI_API_KEY no .env para testar a classificação com a API real.');
  const agent = createAgent({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-6-luna', categories });
  const glpi = createGlpiClient({ baseUrl: process.env.GLPI_API_URL || 'http://127.0.0.1:8088/apirest.php',
    appToken: process.env.THEO_APP_TOKEN, password: process.env.THEO_USER_PASSWORD });
  await glpi.initialize();
  let passed = 0;
  for (const [index, scenario] of cases.entries()) {
    // Estes chamados fictícios ficam no GLPI; não entram no acompanhamento das conversas do Playground.
    const store = { data: { conversations: Object.create(null) }, save() {} };
    const theo = createTheo({ glpi, store, agent, notify: async () => {} });
    const activity = { conversation: { id: randomUUID() }, recipient: { id: 'theo-classification-check' } };
    const messages = [];
    const send = async (text) => { messages.push(text); };
    try {
      await theo.handle({ ...activity, text: `[Teste de classificação ${index + 1}] ${scenario.text}` }, send);
      const conversation = store.data.conversations[activity.conversation.id];
      if (conversation.intake && scenario.followUp) {
        console.log(`Coleta ${index + 1}/${cases.length}: ${conversation.intake.question}`);
        await theo.handle({ ...activity, text: scenario.followUp }, send);
      }
      if (conversation.intake) console.error(`Pergunta pendente: ${conversation.intake.question}`);
      assert.ok(conversation.draft?.reason, 'A IA não produziu um rascunho classificado.');
      assert.equal(conversation.draft.category, scenario.category, `Esperado ${scenario.category}, recebido ${conversation.draft.category}.`);
      assert.equal(Object.keys(conversation.tickets).length, 0, 'Um chamado foi aberto antes da confirmação.');
      await theo.handle({ ...activity, text: 'confirmar' }, send);
      const ids = Object.keys(conversation.tickets);
      assert.equal(ids.length, 1, 'A API não confirmou a abertura do chamado.');
      const { ticket } = await glpi.getUpdates(Number(ids[0]));
      const category = categories.find(({ key }) => key === scenario.category);
      assert.equal(Number(ticket.itilcategories_id), category.id, 'Categoria gravada no GLPI difere da classificação.');
      passed++;
      console.log(`OK ${index + 1}/${cases.length}: ${category.name} — chamado #${ids[0]}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`FALHOU ${index + 1}/${cases.length}: ${scenario.category} — ${error.message}`);
    }
  }
  console.log(`Resultado: ${passed}/${cases.length} cenários classificados e gravados corretamente pela API.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
