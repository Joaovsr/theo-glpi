export function createGlpiClient({ baseUrl, appToken, password, categoryId = 1 }) {
  if (!appToken || !password) throw new Error('Configure THEO_APP_TOKEN e THEO_USER_PASSWORD no .env.');
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw new Error('Categoria padrão inválida.');

  async function request(method, path, session, input) {
    const response = await fetch(new URL(path, `${baseUrl}/`), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'App-Token': appToken,
        ...(session ? { 'Session-Token': session } : { Authorization: `Basic ${Buffer.from(`usuario.demo:${password}`).toString('base64')}` }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GLPI: ${method} ${path.split('?')[0]} retornou HTTP ${response.status}.`);
    return response;
  }

  async function withSession(action) {
    const { session_token: token, session } = await (await request('GET', 'initSession?get_full_session=true')).json();
    if (!token) throw new Error('O GLPI não retornou uma sessão.');
    try {
      const userId = Number(session?.glpiID);
      if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Sessão GLPI sem usuário válido.');
      return await action(token, userId);
    } finally {
      await request('GET', 'killSession', token).catch(() => console.warn('Não foi possível encerrar uma sessão do GLPI.'));
    }
  }

  async function list(path, token) {
    const items = [];
    for (let start = 0; ; start += 100) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await request('GET', `${path}${separator}range=${start}-${start + 99}`, token);
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error('Lista inválida retornada pelo GLPI.');
      items.push(...page);
      const total = response.headers.get('Content-Range')?.split('/')[1];
      if (page.length < 100 || (total && items.length >= Number(total))) return items;
    }
  }

  return {
    async initialize() {
      await withSession(async () => {});
    },

    async createTicket(description, reference, selectedCategoryId = categoryId) {
      if (!Number.isSafeInteger(selectedCategoryId) || selectedCategoryId < 1) throw new Error('Categoria selecionada inválida.');
      if (!description.trim() || description.length > 4_000 || !/^[\da-f-]{36}$/.test(reference)) {
        throw new Error('Descrição ou referência inválida.');
      }
      return withSession(async (token, userId) => {
        // A referência permite recuperar uma criação cuja resposta se perdeu, sem duplicar o chamado.
        const marker = `Theo: ${reference}`;
        const existing = (await list(`Ticket?searchText[content]=${encodeURIComponent(marker)}`, token))
          .filter((ticket) => ticket.content?.includes(marker));
        if (existing.length > 1) throw new Error('Há mais de um chamado com esta referência; revise no GLPI.');
        if (existing.length === 1) {
          const id = Number(existing[0].id);
          if (!Number.isSafeInteger(id) || id < 1) throw new Error('Chamado existente sem identificador válido.');
          return id;
        }
        const escaped = description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const created = await (await request('POST', 'Ticket', token, { input: {
          name: description.split('\n')[0].slice(0, 120),
          content: `<p>${escaped.replaceAll('\n', '<br>')}</p><p>${marker}</p>`,
          entities_id: 0,
          itilcategories_id: selectedCategoryId,
          _users_id_requester: userId,
          type: 2,
          status: 1,
          urgency: 3,
          impact: 3,
        } })).json();
        if (!Number.isSafeInteger(created.id) || created.id < 1) throw new Error('Criação sem número de chamado confirmado.');
        return created.id;
      });
    },

    async getUpdates(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Número de chamado inválido.');
      return withSession(async (token) => {
        const ticket = await (await request('GET', `Ticket/${id}`, token)).json();
        const followups = (await list(`Ticket/${id}/ITILFollowup`, token))
          .filter((item) => Number(item.is_private) === 0)
          .sort((left, right) => Number(left.id) - Number(right.id));
        return { ticket, followups };
      });
    },
  };
}
