import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlpiClient } from '../src/glpi.mjs';

const reference = '12345678-1234-4123-8123-123456789abc';
const client = () => createGlpiClient({ baseUrl: 'http://glpi.test/apirest.php', appToken: 'fake-app', password: 'fake-password' });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

test('recupera um POST cuja resposta se perdeu, sem duplicar o chamado', async (t) => {
  const tickets = [];
  let posts = 0;
  let sessionsClosed = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = url.pathname;
    if (path.endsWith('/initSession')) return json({ session_token: 'fake-session', session: { glpiID: 8 } });
    if (path.endsWith('/killSession')) { sessionsClosed++; return json(true); }
    assert.equal(options.headers['Session-Token'], 'fake-session');
    if (options.method === 'GET') {
      assert.equal(url.searchParams.get('searchText[content]'), `Theo: ${reference}`);
      return json(tickets);
    }
    posts++;
    const { input } = JSON.parse(options.body);
    assert.equal(input.itilcategories_id, 1);
    assert.equal(input._users_id_requester, 8);
    assert.match(input.content, /&lt;erro&gt; &amp; conexão/);
    tickets.push({ ...input, id: 46 });
    throw new Error('Resposta perdida depois da criação');
  });
  const glpi = client();
  await assert.rejects(glpi.createTicket('Teste <erro> & conexão', reference), /Resposta perdida/);
  assert.equal(await glpi.createTicket('Teste <erro> & conexão', reference), 46);
  assert.equal(posts, 1);
  assert.equal(sessionsClosed, 2);
});

test('pagina acompanhamentos e remove notas privadas antes de retorná-los', async (t) => {
  const ranges = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.pathname.endsWith('/initSession')) return json({ session_token: 'fake-session', session: { glpiID: 8 } });
    if (url.pathname.endsWith('/killSession')) return json(true);
    if (url.pathname.endsWith('/Ticket/47')) return json({ id: 47, status: 2 });
    const range = url.searchParams.get('range');
    ranges.push(range);
    return range === '0-99'
      ? json(Array.from({ length: 100 }, (_, id) => ({ id: id + 1, is_private: 1 })), 206, { 'Content-Range': '0-99/101' })
      : json([{ id: 101, is_private: 0, content: 'Resposta pública' }], 206, { 'Content-Range': '100-100/101' });
  });
  const updates = await client().getUpdates(47);
  assert.deepEqual(ranges, ['0-99', '100-199']);
  assert.deepEqual(updates.followups.map(({ id }) => id), [101]);
  await assert.rejects(client().getUpdates(-1), /inválido/);
});

test('falha no encerramento de sessão não transforma criação confirmada em erro', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.endsWith('/initSession')) return json({ session_token: 'fake-session', session: { glpiID: 8 } });
    if (url.pathname.endsWith('/killSession')) return json({}, 503);
    return options.method === 'POST' ? json({ id: 48 }, 201) : json([]);
  });
  assert.equal(await client().createTicket('Descrição de teste', reference), 48);
});

test('envia a categoria selecionada na criação e rejeita um identificador inválido', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.endsWith('/initSession')) return json({ session_token: 'fake-session', session: { glpiID: 8 } });
    if (url.pathname.endsWith('/killSession')) return json(true);
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).input.itilcategories_id, 3);
      return json({ id: 49 }, 201);
    }
    return json([]);
  });
  assert.equal(await client().createTicket('Computador sem Wi-Fi', reference, 3), 49);
  await assert.rejects(client().createTicket('Teste de categoria', reference, '3'), /Categoria selecionada inválida/);
});
