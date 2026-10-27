import { createServer } from 'node:http';
import { App, ExpressAdapter } from '@microsoft/teams.apps';
import { createGlpiClient } from './glpi.mjs';
import { createStore } from './store.mjs';
import { createTheo } from './theo.mjs';
import { createAgent } from './agent.mjs';
import categories from '../config/categories.json' with { type: 'json' };

const agent = process.env.OPENAI_API_KEY?.trim()
  ? createAgent({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-6-luna', categories })
  : undefined;

const connector = process.env.PLAYGROUND_SERVICE_URL ?? 'http://127.0.0.1:56150/_connector';
const server = createServer();
const adapter = new ExpressAdapter(server);
adapter.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && !['http://127.0.0.1:56150', 'http://localhost:56150'].includes(origin)) {
    return response.sendStatus(403);
  }
  next();
});
adapter.get('/health', (_request, response) => response.json({ status: 'ok', name: 'Theo', mode: 'local-demo', ai: agent ? 'openai' : 'disabled' }));

// shortcut: demo sem autenticação em portas locais; configurar autenticação Teams antes de qualquer exposição pública.
const app = new App({ dangerouslyAllowUnauthenticatedRequests: true, httpServerAdapter: adapter, serviceUrl: connector });
const glpi = createGlpiClient({
  baseUrl: process.env.GLPI_API_URL ?? 'http://127.0.0.1:8088/apirest.php',
  appToken: process.env.THEO_APP_TOKEN,
  // shortcut: todas as conversas usam usuario.demo; mapear a identidade autenticada antes de usar no Teams real.
  password: process.env.THEO_USER_PASSWORD,
  categoryId: Number(process.env.THEO_CATEGORY_ID ?? 1),
});
await glpi.initialize();
const store = createStore(new URL('../data/theo.json', import.meta.url).pathname);
const theo = createTheo({
  glpi,
  store,
  agent,
  notify: (ref, text) => app.api.conversations.createActivity(ref.conversation.id, {
    type: 'message', text, textFormat: 'plain', from: ref.bot, conversation: ref.conversation,
  }),
});

async function handleActivity(context) {
  const activity = context.activity;
  if (activity.serviceUrl?.replace(/\/$/, '') !== connector
      || !activity.conversation?.id || !activity.from?.id || !activity.recipient?.id) {
    console.warn('Atividade ignorada: use o Playground local configurado neste projeto.');
    return;
  }
  // shortcut: o Playground 0.2.29 renderiza markdown; avaliar extendedmarkdown ao publicar no Teams real.
  const send = (text, textFormat = 'plain', card) => context.send({
    type: 'message',
    ...(card ? { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] } : { text, textFormat }),
  });
  try {
    await theo.handle(activity.type === 'invoke'
      ? { ...activity, value: activity.value?.action?.data ?? {} }
      : activity, send);
  } catch (error) {
    console.warn(error.message);
    await send('Não consegui concluir a operação agora. O GLPI pode estar indisponível. Tente consultar “status” ou enviar sua solicitação novamente.');
  }
}
app.on('message', handleActivity);
app.on('card.action', async (context) => {
  await handleActivity(context);
  return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Ação processada.' };
});
app.event('error', ({ error }) => console.warn('Falha ao processar atividade:', error.message));
await app.initialize();
server.listen(3978, process.env.THEO_BIND_HOST ?? '127.0.0.1', () => console.log(`Theo local: http://127.0.0.1:3978 — GLPI conectado; IA ${agent ? 'OpenAI configurada' : 'desativada (configure OPENAI_API_KEY)'}.`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; clearInterval(timer); });
const timer = setInterval(() => void theo.poll(), 5_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); });
}
