# Theo — produto e decisões

## Proposta

Oferecer atendimento de TI pelo Microsoft Teams, usando o GLPI como sistema de chamados. O Theo deve ajudar o usuário quando houver uma orientação adequada, reunir o contexto necessário para o suporte e acompanhar o atendimento na conversa.

O cenário inicial é uma única organização conectada a uma instância do GLPI, com atendimento em português e conversa privada. A abertura direta de chamado permanece disponível durante o autoatendimento.

## Jornada

1. O usuário pede ajuda ou solicita um chamado no Teams.
2. O Theo aproveita as informações já recebidas e pergunta apenas o que ajuda a decidir o próximo passo.
3. Se o usuário quiser tentar resolver, oferece orientações simples e pergunta o resultado. Após até duas tentativas sem sucesso, oferece encaminhamento ao suporte.
4. Se o usuário pedir um chamado, reúne um relato útil sem obrigar tentativas prévias de solução.
5. Prepara o resumo e a categoria para revisão.
6. Após confirmação, registra no GLPI e retorna número e link.
7. Consulta e notifica as atualizações permitidas daquele atendimento.

Uma resolução só é considerada quando confirmada pelo usuário. Abandono da conversa não significa problema resolvido.

## Decisões do atendimento

| Tema | Decisão |
| --- | --- |
| Canal alvo | Chat privado no Microsoft Teams. |
| Registro dos chamados | GLPI, acessado pela API REST. |
| Pedido direto | Não exige tentativa prévia de autoatendimento. |
| Coleta | Uma ou duas perguntas relevantes por rodada; reutilizar o histórico e aceitar o registro com os dados disponíveis quando solicitado. |
| Relato | Registrar fatos informados, sintomas e tentativas; não inventar dados nem preencher o resumo com listas de campos ausentes. |
| Classificação | Sugerir apenas categorias do catálogo configurado e mostrar o motivo antes da confirmação. |
| Confirmação | Criar somente após a ação Confirmar ou o comando `confirmar`, com o resumo revisado. A resposta `sim` durante a ajuda não abre chamado. |
| Correção e cancelamento | Permitir revisar ou descartar o pedido; ações antigas não podem confirmar outro resumo. |
| Notificações | Acompanhar mudanças de status e respostas públicas dos chamados registrados pela conversa. |
| Permissões | Aplicar no servidor o escopo de acesso aos chamados; excluir notas privadas das mensagens e dos resultados entregues à IA. |

## Implementação atual

O servidor usa o Microsoft Teams SDK para receber mensagens e ações de Adaptive Cards. O conector ativo é o Microsoft 365 Agents Playground. O atendimento, a classificação, a abertura, a consulta e as notificações usam a API real do GLPI no ambiente de desenvolvimento.

A IA possui quatro ferramentas: coletar detalhes, preparar um rascunho, listar chamados acompanhados e consultar um chamado da conversa. A criação é executada pelo servidor após a confirmação; não há ferramenta do modelo para criar, fechar ou atribuir chamados.

Os cadastros, o solicitante e as identidades do Playground são fictícios. O vínculo entre identidade Microsoft e usuário GLPI ainda não existe. Os IDs das categorias ficam em `config/categories.json`, sincronizados com o GLPI de desenvolvimento.

As notificações consultam o GLPI a cada cinco segundos. O estado e os marcadores de entrega persistem em JSON. Uma queda entre envio e gravação do marcador pode repetir um aviso. O armazenamento atual atende a uma única instância do servidor.

## Evolução

### 1. Concluir a integração com o Teams

- Registrar a aplicação e o bot no ambiente Microsoft da organização e preparar o manifesto do aplicativo Teams.
- Configurar autenticação de entrada e um endpoint HTTPS para mensagens; substituir o conector exclusivo do Playground.
- Relacionar cada identidade autenticada ao solicitante e à entidade corretos no GLPI, tratando vínculos ausentes ou ambíguos.
- Aplicar a identidade e as permissões corretas à criação, consulta e entrega de notificações.
- Validar cartões, confirmação, reenvios e mensagens proativas no cliente Teams real.

O caminho de integração usa o [Teams SDK](https://github.com/microsoft/teams-sdk). Credenciais Microsoft, publicação do aplicativo e autorização no tenant fazem parte dessa etapa; adicionar um segredo ao `.env` atual, isoladamente, não habilita o Teams real.

### 2. Consultar a base de conhecimento

Começar com uma fonte mantida e procedimentos revisados, preferencialmente a base já existente no GLPI. Cada resposta deve respeitar a visibilidade do artigo e apresentar sua fonte. O agente deve reconhecer quando não tem informação suficiente e permitir atendimento humano.

Se for necessário um índice separado, ele deverá acompanhar alterações, exclusões e permissões. Chamados anteriores só devem virar conhecimento após revisão e remoção de dados inadequados à divulgação.

### 3. Encaminhar ao responsável

Definir regras de atribuição por entidade, grupo ou categoria e registrar o responsável no GLPI. A classificação de categoria atualmente implementada não atribui um técnico. As regras e aprovações devem ser definidas pelo suporte, sem a IA inventar permissões ou critérios de atendimento.

### 4. Preparar a operação

Definir retenção de conversas, monitoramento de falhas, política de reenvio das notificações, armazenamento adequado à implantação e acompanhamento de custos. Validar qualidade das respostas e acesso aos dados com casos representativos da organização.

## Perguntas para a implantação

- Qual tenant permitirá instalar e validar o agente no Teams?
- Como relacionar os usuários e entidades do GLPI às identidades Microsoft?
- Quais campos, regras de prioridade e aprovações são obrigatórios?
- Quais atualizações geram avisos e quais chamados o usuário pode consultar?
- Quem mantém a base de conhecimento e quais conteúdos cada público pode acessar?
- Como os chamados serão encaminhados aos grupos e responsáveis?
- Quais dados podem ser enviados ao provedor de IA e por quanto tempo as conversas devem ser mantidas?

## Validação do produto

Verificar solicitante e entidade corretos, fidelidade do relato, categoria revisada, criação sem duplicação, recuperação de falhas e destinatário correto das notificações. Notas privadas devem permanecer fora da conversa e do contexto da IA.

Medir tempo até abertura, completude das informações, sucesso de criação, entrega das notificações, custo por atendimento e satisfação. Para o autoatendimento, medir resoluções confirmadas e novos chamados sobre o mesmo problema, com uma janela de observação definida. As metas devem partir de dados reais da operação.
