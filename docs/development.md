# Desenvolvimento do Theo

O ambiente de desenvolvimento reúne GLPI, MariaDB, Theo e Microsoft 365 Agents Playground. Ele permite trabalhar no fluxo de atendimento e nas integrações usando contas fictícias. O Playground simula o canal Teams; não equivale à instalação no cliente Teams real.

## Requisitos

- Docker com Docker Compose.
- Python 3 para gerar as credenciais da primeira instalação.
- Node.js 22.12 ou posterior para executar os testes ou o servidor fora do container.
- Uma chave da API da OpenAI para o atendimento com IA. Sem ela, permanece o fluxo por comandos com categoria Geral.

## Primeira instalação

Na raiz de uma cópia do repositório, gere o `.env`. O comando abaixo cria credenciais aleatórias, restringe a leitura do arquivo e se recusa a sobrescrever um arquivo existente:

```sh
python3 - <<'PY'
import os
import secrets

values = {key: secrets.token_hex(24) for key in ('GLPI_DB_PASSWORD', 'DB_ROOT_PASSWORD')}
for key in ('THEO_ADMIN_PASSWORD', 'THEO_TECH_PASSWORD', 'THEO_USER_PASSWORD', 'THEO_API_PASSWORD'):
    values[key] = 'Theo-' + secrets.token_hex(16) + '-aA9!'
for key in ('THEO_API_TOKEN', 'THEO_APP_TOKEN'):
    values[key] = secrets.token_hex(20)
values.update(THEO_CATEGORY_ID='1', OPENAI_API_KEY='', OPENAI_MODEL='gpt-6-luna')
descriptor = os.open('.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as target:
    target.write(''.join(f'{key}={value}\n' for key, value in values.items()))
PY
```

Se preferir configurar os valores manualmente, use [.env.example](../.env.example) como referência. Preencha `OPENAI_API_KEY` no arquivo local para ativar a IA. O modelo é configurável em `OPENAI_MODEL`. A API é cobrada por uso, separadamente do ChatGPT. Nunca compartilhe ou versione credenciais.

Inicie o GLPI e faça os cadastros antes de iniciar o Theo:

```sh
docker compose up -d --wait --wait-timeout 300 db glpi
docker compose cp config/categories.json glpi:/tmp/theo-categories.json
docker compose cp scripts/seed-demo.php glpi:/tmp/theo-seed-demo.php
docker compose exec -T glpi php /tmp/theo-seed-demo.php
docker compose cp glpi:/tmp/theo-categories-resolved.json config/categories.json
docker compose build theo
docker compose up -d --wait --wait-timeout 300
```

O `seed-demo.php` cria contas e categorias, configura o cliente da API, substitui a senha padrão do administrador e desativa as contas padrão `normal`, `tech` e `post-only`. Pode ser repetido sem duplicar os cadastros. Ele reaplica a configuração e as credenciais do ambiente de desenvolvimento; execute somente no GLPI fictício deste Compose.

## Acessos e contas

| Serviço | Endereço |
| --- | --- |
| Chat com o Theo | http://127.0.0.1:56150 |
| GLPI | http://127.0.0.1:8088 |
| Saúde do Theo | http://127.0.0.1:3978/health |

| Conta no GLPI | Uso | Variável da senha |
| --- | --- | --- |
| `glpi` | Administrar o GLPI de desenvolvimento | `THEO_ADMIN_PASSWORD` |
| `tecnico.demo` | Atender chamados fictícios | `THEO_TECH_PASSWORD` |
| `usuario.demo` | Solicitante Self-Service usado pelo Theo | `THEO_USER_PASSWORD` |
| `theo.api` | Simular atendimento no teste PHP, perfil Technician | `THEO_API_PASSWORD` |

O Theo autentica a API REST V1 como `usuario.demo`, usando `THEO_USER_PASSWORD` e `THEO_APP_TOKEN`. A conta `theo.api` e o `THEO_API_TOKEN` são usados apenas pelo teste PHP. As credenciais do banco são `GLPI_DB_PASSWORD` e `DB_ROOT_PASSWORD`.

Todos os usuários do Playground representam a mesma conta `usuario.demo` no GLPI. Os nomes e IDs fictícios ficam em [.m365agentsplayground.yml](../.m365agentsplayground.yml). Os chamados usam entidade raiz e valores fixos para tipo, urgência e impacto.

## Exercitar o atendimento

No Playground, abra o chat pessoal com **Theo** e envie `menu`. Use os botões para pedir ajuda, abrir um chamado ou consultar os existentes.

1. Envie `Quero abrir um chamado pedindo acesso ao ERP`.
2. Responda às perguntas sobre o sistema e as funções necessárias.
3. Revise o resumo e use **Confirmar**, **Corrigir** ou **Cancelar**. A opção **Registrar assim mesmo**, durante a coleta, prepara o resumo com os dados disponíveis e ainda exige confirmação posterior.
4. Após confirmar, confira o número e o link do chamado. Use `status` para consultar o andamento.
5. No GLPI, entre como `tecnico.demo`, atribua o chamado a esse técnico, mude o status para **Em atendimento** e adicione um acompanhamento público.
6. O aviso chega à conversa na próxima consulta, normalmente em cerca de cinco segundos com os serviços disponíveis.

Notas privadas são excluídas das mensagens e dos resultados entregues à IA. São acompanhados apenas os chamados abertos pela conversa. Os comandos digitados `confirmar`, `corrigir`, `cancelar` e `status` também funcionam.

Os botões incluem o campo `verb`, exigido pelo Playground. Mensagens antigas não são alteradas ao atualizar o código. Envie `menu` para gerar um menu novo ou `abrir chamado` para reapresentar o rascunho atual com os botões atualizados.

## Iniciar, atualizar e parar

Depois da primeira instalação:

```sh
docker compose build theo
docker compose up -d --wait --wait-timeout 300
docker compose ps
```

Para parar preservando os dados:

```sh
docker compose down
```

Os volumes `theo-glpi_db_data`, `theo-glpi_glpi_data` e `theo-glpi_theo_data` preservam o GLPI, os rascunhos, os chamados acompanhados e os marcadores de notificação. O histórico visual do Playground fica em memória; após reiniciar, use `status` para retomar os chamados acompanhados.

`docker compose down --volumes` apaga esses dados. Preserve também o `.env`. As portas publicadas estão restritas a `127.0.0.1`; o banco não publica porta. O servidor aceita requisições sem autenticação neste ambiente e não deve ser exposto à internet.

Para consultar os logs:

```sh
docker compose logs --tail=80 theo playground
docker compose logs --tail=80 glpi db
```

GLPI e MariaDB usam as versões fixadas no [compose.yaml](../compose.yaml). Atualizações automáticas de esquema estão desativadas; planeje a migração antes de trocar a versão do GLPI.

## Configurar categorias

O catálogo inicial contém Geral, Acessos e contas, Redes e conectividade, Equipamentos e periféricos, Sistemas e aplicativos e E-mail e colaboração. Os nomes, descrições e IDs ficam em [config/categories.json](../config/categories.json). A IA escolhe apenas uma chave desse catálogo, e o servidor resolve o ID enviado ao GLPI.

Para cadastrar ou sincronizar categorias no GLPI de desenvolvimento, repita as quatro linhas de cópia e execução do seed da primeira instalação e depois reconstrua a imagem do Theo. Os IDs exportados devem corresponder à instância usada pelo agente; eles não são portáveis entre instalações sem sincronização. O modelo nunca cria categorias.

## Testes

Os testes automatizados simulam OpenAI e GLPI e não geram cobrança:

```sh
npm ci --cache .npm-cache
npm test
```

A suíte cobre coleta e contexto, ferramentas permitidas, revisão e confirmação, botões, repetição de ações, recuperação de criação com resposta perdida, persistência, isolamento entre conversas, paginação e exclusão de notas privadas. Ações expiradas não podem confirmar ou cancelar outro resumo. Falhas de entrega mantêm a notificação pendente para outra tentativa.

Com chave configurada e os serviços disponíveis, as verificações abaixo usam a API real da OpenAI e geram consumo:

```sh
# Cinco cenários de coleta; não abre chamados.
docker compose exec -T theo node scripts/check-intake.mjs

# Oito cenários de classificação; confirma e mantém chamados fictícios no GLPI.
docker compose exec -T theo node scripts/check-classification.mjs
```

Fora do container, os comandos equivalentes são `npm run test:intake` e `npm run test:classification`. Os casos ficam em [test/fixtures](../test/fixtures). Essas amostras não garantem precisão em outros relatos.

Para verificar diretamente a API do GLPI, incluindo atribuição, resposta pública e nota privada:

```sh
docker compose cp scripts/check-local.php glpi:/tmp/theo-check-local.php
docker compose exec -T glpi php /tmp/theo-check-local.php
```

O teste PHP mantém um chamado fictício a cada execução. Ele não cria regra de atribuição automática. Os chamados criados pelos testes de integração não entram no acompanhamento do Playground.

## Executar o servidor fora do container

Com GLPI configurado e acessível pelo Compose, instale as dependências e execute em dois terminais:

```sh
npm run dev
```

```sh
npm run playground
```

Pare os containers `theo` e `playground` antes de iniciar esses processos, para liberar as portas. Os valores padrão do servidor usam GLPI em `127.0.0.1:8088` e Playground em `127.0.0.1:56150`. `GLPI_API_URL`, `PLAYGROUND_SERVICE_URL` e `THEO_BIND_HOST` permitem ajustar os endereços. O estado dessa execução fica em `data/theo.json`, separado do volume do container.

A CLI Teams está disponível por `npm run teams`, `npm run teams:login` e `npm run teams:status`. Ela não é necessária para o Playground e não provisiona, sozinha, a integração com o Teams real.

## Dados, IA e limites atuais

- O estado em JSON atende a um processo do Theo. A criação usa uma referência no chamado para recuperar respostas perdidas e evitar duplicação no reenvio.
- Uma queda entre o envio de um aviso e a gravação do marcador pode repetir a notificação.
- São enviados à OpenAI o relato, até doze mensagens recentes, o rascunho, o catálogo e os resultados públicos necessários às ferramentas. `cancelar` descarta o pedido e o contexto anterior da conversa.
- As chamadas usam `store: false`, esforço de raciocínio `none`, timeout e limites de rodadas e saída. Isso não representa teto financeiro nem garantia de retenção zero pelo provedor.
- O `/health` indica se há uma chave configurada; não verifica saldo ou validade da credencial. Use as verificações com API real para isso.
- A base de conhecimento ainda não está conectada. As orientações atuais são gerais; o agente não acessa a máquina do usuário.
- O override de MSAL no `package.json` trata o [GHSA-xcx6-jx8p-x3h5](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5). Remova-o quando as dependências Microsoft incorporarem a correção.

O trabalho restante para autenticação, identidade e publicação no Teams está descrito nas [decisões do produto](discovery.md#evolução). A configuração local atual não é uma configuração de produção.

Referências: [Agents Playground](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/debug-your-agents-playground), [Teams SDK](https://github.com/microsoft/teams-sdk), [GLPI Docker](https://github.com/glpi-project/docker-images) e [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).
