# Requisitos funcionais

Regras definidas pela instituição, na forma em que foram recebidas. O que estiver em dúvida fica em `PLANO_DESENVOLVIMENTO_INTEGRAL.md`, na seção "Questões em aberto", e não é tratado aqui como requisito.

## Instituição e acesso

- A equipe operacional SLM tem quatro integrantes e pertence ao setor maior CPC, com cerca de vinte pessoas.
- A SLM atende todas as categorias de solicitações.
- Pertencer à SLM independe do setor de lotação.
- Somente integrantes da SLM individualmente autorizados abrem solicitações em nome de outros setores. Agendar é atribuição de quem integra a equipe SLM: vem do perfil Operador SLM ou Administrador, só com a equipe marcada (08/11/2026).
- O perfil Administrador não concede automaticamente todas as permissões restritas.
- Agendar (`requests:schedule`) e informar ou alterar a previsão de entrega (`warehouse:forecast`) são atribuições da SLM: o Administrador e o Operador SLM só as recebem se integrarem a equipe SLM; para o Operador SLM, vêm do perfil desde 08/11/2026, sem concessão manual. Ser administrador fora da SLM não basta, nem com concessão gravada no banco, e a recusa fica na auditoria (P-08, 06/11/2026). A administração do Almoxarifado (`warehouse:manage`: materiais, estoque, controle interno, inventário, situação, entrega, registro local, comunicações e anexos) não é restrita à SLM: o Administrador fora da equipe a mantém.
- `warehouse:manage` só vale para o perfil Administrador (dentro ou fora da SLM) e para o Operador SLM da equipe, que a recebe pelo perfil desde 08/11/2026. Solicitante e Motorista nunca a recebem: a concessão é recusada no backend e fica na auditoria (`access.denied`, operação `user.permission_grant`), e um valor gravado diretamente no banco não dá acesso, porque a permissão efetiva é recalculada com a elegibilidade e cada rota a confere de novo (Supercomando 17, 06/11/2026).
- O perfil Solicitante não pode integrar a SLM.
- A autorização é verificada no backend.
- O administrador não altera o próprio acesso para contornar as regras.

## CPF de passageiros

- CPF completo somente para usuários elegíveis da SLM com concessão individual.
- Administrador fora da SLM não recebe essa permissão.
- Operador SLM sem concessão não consulta CPF completo.
- Solicitante nunca consulta CPF completo.
- Sem autorização, o CPF aparece mascarado.
- A consulta é protegida no backend e registrada em auditoria.
- Saída da SLM, mudança de perfil ou desativação da conta revogam as permissões restritas.
- Retorno à SLM ou reativação não restauram permissões revogadas.

## Autenticação e usuários

Cadastro com e-mail institucional; aprovação administrativa; ativação e desativação; perfis e permissões individuais; recuperação de senha por link temporário; controle e encerramento de sessões; proteção contra tentativas abusivas; auditoria administrativa; proteção do último administrador; validação de permissões no servidor.

## Módulos

### Painel

Solicitações recentes, pendências, indicadores por módulo, situação dos atendimentos, quantitativos por período e filtros, com dados reais e conforme as permissões.

### Manutenção

Solicitante, setor, andar, tipo de serviço padronizado, acompanhamento, agendamento, reagendamento, cancelamento, início, conclusão, histórico e responsáveis.

Status: Aguardando agendamento, Agendado, Reagendado, Em andamento, Concluído e Cancelado.

### Frota

Solicitante, setor, origem, destino, data e horário, passageiros quando aplicável, agendamento, reagendamento, cancelamento, execução, início e término reais, ocorrências, atrasos, histórico e conclusão.

### Passagens aéreas

Solicitante, setor, andar, até dez passageiros, origem, destino, ida e volta, somente volta, bagagem, acompanhamento, histórico, status e proteção dos dados pessoais.

Status: Em cotação, Aguardando aprovação, Em emissão e Emitida.

### Configurações

Setores, andares, tipos de serviço e outras opções compartilhadas: inclusão, edição, desativação, reativação, validação de duplicidade e controle de permissões. Formulários usam seletores padronizados. Desativar não altera registros históricos.

### Almoxarifado

- **Origem 1, Sistema JUCESP:** pedido feito na plataforma, registrado no banco e acompanhado pelo solicitante.
- **Origem 2, sistema governamental:** responsáveis inserem manualmente o pedido, com a origem identificada e a referência quando disponível.
- As duas origens aparecem na mesma central.
- Itens, quantidades solicitadas e atendidas, situação, entrega, histórico, responsável por operação, filtros e relatórios.
- **Editar um pedido externo no JUCESP não altera o original no sistema governamental.**
- O JUCESP não afirma estar integrado ao sistema governamental.
- Catálogo de materiais, unidade de medida e itens ativos e inativos.
- Conferência de inventário: quantidade do sistema governamental, contagem interna, diferença, situação e histórico.
- Previsão de entrega: só o dia, sem horário, informada e alterada por quem tem `warehouse:manage` e `warehouse:forecast`; esta última exige a equipe SLM. A alteração exige justificativa, e cada previsão fica em um histórico interno que não muda, com autoria, data e horário.
- O solicitante é avisado por e-mail e na central de notificações, uma vez por mudança real, e consulta protocolo, materiais, previsão, situação e data efetiva, sem justificativas nem observações.
- Relatórios: entradas e saídas do estoque interno por material, para quem administra o módulo.
- Sigilo do estoque: quem não administra o Almoxarifado (em especial o Solicitante) não vê nem infere saldo, reserva, mínimo, movimentações, contagens ou disponibilidade. O catálogo traz só código, nome, descrição, unidade e categoria; o pedido é aceito em qualquer quantidade, sem mensagem que revele o saldo; não há filtro de disponíveis ou indisponíveis; os totais por material dos relatórios exigem `warehouse:manage` (ou Operador SLM com `requests:read_all`); e a auditoria esconde os eventos de estoque, reserva, controle interno e inventário de quem não administra o módulo.
- Baixa automática na entrega (12/11/2026): registrar a entrega lança a saída das quantidades entregues no estoque interno, nunca mais que o saldo, sem bloquear a entrega.
- Valores (12/11/2026, migração 020): custo médio ponderado; entrada com valor pago, nota fiscal, empenho, fornecedor e ata de registro de preços; valor do saldo existente informado com justificativa; painel com valor em estoque, compras e consumo por mês, materiais mais caros, consumo por setor e saldo das atas. Só Administrador e Operador SLM da equipe (`warehouse:finance`); valores fora da auditoria.
- Situação da entrega: Aguardando entrega, Entrega reagendada ou Entregue. Só o registro da entrega conclui: uma previsão, mesmo vencida, não conta como entrega.

### Justificativas e comunicação (Supercomando 06)

- Agendar em condições diferentes das pedidas, alterar, reagendar e cancelar exigem motivo padronizado, com complemento livre. "Outros" exige o texto.
- O histórico guarda o solicitado, o anterior, o novo, o motivo, o responsável e o momento. O cancelamento continua registrado depois de sair da agenda.
- O e-mail mostra o que foi pedido, o que foi agendado, o que mudou e o motivo. Comentário interno de um agendamento igual ao pedido não vai ao solicitante.
- A devolução para correção mantém o protocolo e o status. O solicitante altera só os campos indicados, os dados anteriores ficam guardados, e o prazo interno não corre durante a espera.
- A previsão de entrega continua com a justificativa interna, como no Supercomando 05.
- Possível duplicidade é só alerta. Sem acesso à solicitação parecida, a pessoa sabe que ela existe, e nada além disso.
- Relatório individual em PDF e CSV, com o alcance da tela e sem nomes ou CPF de passageiros.
- Prazos por prioridade, módulo e tipo de serviço: vale o menor.
- Almoxarifado: quantidade não disponibilizada e motivo por item. Saldo físico, reservado, disponível e fornecido são números separados, e ter saldo não obriga a fornecer.

### Modelos e formulários (Supercomando 07)

- Toda edição é uma versão que não muda. Rascunho não vale até ser publicado, e restaurar publica uma cópia.
- Permissões separadas para consultar, editar e publicar modelos e formulários, e para restaurar versões.
- Os modelos usam só variáveis compatíveis com o evento. Linha com dado ausente não é enviada. Motivo, datas e campos a corrigir saem mesmo fora da lista do modelo.
- O teste de e-mail vai só para a conta de quem testa, sem fila, status ou agenda.
- Disparo, destinatários e credenciais de e-mail não são configuráveis pela tela.
- Formulários: campos protegidos não saem nem mudam de tipo. O servidor aplica obrigatoriedade, limites, opções e regras condicionais. Listas com cadastro central usam o cadastro.
- Cada registro guarda a versão do formulário e o nome dos campos usados.
- O formulário de conta não afrouxa e-mail institucional, senha nem aprovação.
- O formulário interno do Almoxarifado é controle da SLM: não cria pedido de materiais e não movimenta saldo.
- Avisos institucionais e de LGPD ficam fora da edição.

### Central de comunicação (Supercomando 08)

- Quem tem `communications:send` e atende o módulo envia e-mails pela solicitação, com ou sem modelo, depois de conferir e confirmar. Os e-mails automáticos seguem na fila própria.
- "Enviado" significa aceito pelo serviço de e-mail. Sem serviço ativo, a mensagem fica registrada como não enviada.
- Anexos passam pela validação de conteúdo dos anexos e são conferidos de novo antes de sair. Não há link público.
- Cada mensagem guarda destinatários, assunto, conteúdo, operador, anexos, modelo, resultado e identificador. Reenviar cria outra mensagem.
- O indicador do bilhete vem do histórico e não altera o status da solicitação.
- O e-mail do passageiro fica só no registro de cada envio, e o localizador é digitado ao compor: o sistema não tem cadastro para eles.

### Agenda

Agenda interna de Manutenção, Frota e Passagens aéreas, usando os próprios registros dos módulos: o agendamento da SLM em Manutenção e Frota, e a data e o horário da ida e da volta em Passagens. A integração com o Google Calendar foi removida em 11/11/2026, a pedido da responsável. Detalhes em `INTEGRACOES_E_AUTOMACOES.md`.

### Auditoria

Autenticação, cadastros, perfis, permissões, CPF, solicitações, agendamentos, cancelamentos, configurações, Almoxarifado e status, com usuário, ação, data, horário, resultado e motivo. Usuários comuns não alteram nem apagam registros.

### Atas e contratos (Controle de Demandas, 12/11/2026)

- Atas de registro de preços e contratos de materiais, serviços, cursos e outros, do setor responsável, compartilháveis com outros setores. Veem e alteram os integrantes desses setores e o Diretor; o Administrador sem perfil de Diretor só consulta.
- Itens com quantidade registrada e valor unitário; utilizações permanentes, nunca acima do saldo; aditivos e prorrogações permanentes, que mudam vigência ou valor.
- PDF da ata, do contrato e dos aditivos, sem URL pública.
- Demanda de renovação aberta automaticamente no setor responsável ao entrar no prazo de aviso (padrão 90 dias), uma vez por vigência; prorrogar libera o próximo aviso.
- A demanda pode ser vinculada a uma ata ou contrato que a pessoa enxerga; o vínculo não abre demanda de outro setor.

### Dashboard (12/11/2026)

- Porcentagem do total nos cartões e nas barras; comparação com o período anterior do mesmo tamanho; taxas de concluídas no prazo, canceladas e pedidos do Almoxarifado atendidos por completo; percentual usado das atas do Almoxarifado (só para quem vê valores).

### Administração do sistema (13/11/2026)

- Em Configurações: domínios aceitos no cadastro (sem lista, vale `INSTITUTIONAL_EMAIL_DOMAINS`), feriados (calendário, carga horária dos motoristas e prazo que cair em feriado), aviso geral com data final (topo das telas e tela de entrada), módulos ligados (desligado sai do menu e não recebe pedidos novos; nada é apagado), padrões de atas e contratos, mensagens da tela de entrada e da página inicial, e permissões padrão de Solicitante e Operador SLM, só entre as permissões comuns de cada módulo.
- Gerenciador de formulários: além dos cinco anteriores, pedido de materiais, pedido externo, registro de entrega, material, demanda, ata ou contrato, veículo, motorista, ocorrência do motorista, equipamento, execução da manutenção e cotação de passagem. Nesses doze, os campos existentes podem ser renomeados, e os campos novos aparecem no fim, validados no servidor e gravados com o nome usado.
- Pesquisa geral: inclui demandas e atas e contratos, com a mesma visibilidade do Controle de Demandas (setor, compartilhamento, restrição e rascunho).
- Almoxarifado: localização de cada material (só a equipe vê), inventário e estoque ordenáveis pela localização, e entrada no estoque pelo item de uma ata ou contrato do Controle de Demandas, que baixa o saldo do item.

### Robô do Almoxarifado, sem inteligência artificial (13/11/2026)

Decisão da responsável: só funções sem IA, sem custo de API. Aba **Almoxarifado → Robô**, para quem administra o Almoxarifado. O robô prepara, e a equipe confere e confirma.

- **Inventário pela planilha do governo:** aceita .xlsx, .csv (inclusive o do Excel em português), .ods e o .xls em HTML que os sistemas do governo exportam. O .xls binário antigo pede para salvar como .xlsx. Limites: 5 MB, 5.000 linhas e 60 colunas. O robô acha o cabeçalho e as colunas (código, descrição, quantidade, unidade), e a pessoa pode trocá-las. Liga cada linha a um material, por código, por nome igual ou por nome parecido (só com a confirmação da pessoa). Mostra as quantidades iguais, as diferentes, as que faltam cadastrar e o que só existe no sistema, e baixa o relatório de divergências em CSV. A conferência é criada pela rota de sempre, com as quantidades do governo preenchidas e na ordem dos armários. A planilha não fica guardada.
- **Cadastro dos materiais que faltam (13/11/2026):** na mesma leitura, o robô lista as linhas sem material no sistema, uma por descrição, com:
  - o nome e o código da planilha;
  - a unidade reconhecida pelo nome ou pela abreviação (UN, CX, PCT, KG, L, RL, PAR e outras).
  
  As linhas sem correspondência vêm marcadas; as parecidas com um material existente, desmarcadas. A pessoa confere, ajusta, escolhe a unidade quando ela não foi reconhecida e cadastra, até 300 por vez. Material com o mesmo código (sem pontuação nem zeros à esquerda) ou o mesmo nome de outro já cadastrado é pulado, com o motivo. Cada cadastro fica na Auditoria com a origem "robo_planilha". Depois, a planilha é lida de novo e esses materiais passam a ser reconhecidos.
- **Sugestão de reposição:** consumo médio de 12 meses e estoque disponível (físico menos reservado), para durar 1 a 12 meses, nunca abaixo do mínimo. Para quem vê valores (`warehouse:finance`), indica itens de atas e contratos vigentes com saldo e nome parecido. Lista de compras em CSV.
- **Resumo semanal:** abaixo do mínimo, a repor (3 meses), pedidos aguardando e conferências abertas. Na segunda-feira a partir das 7h, uma vez por semana, à equipe do Almoxarifado (e-mail e central de notificações), só com contagens. Começa desligado e liga em Configurações → Notificações.
- Não exige migração.

### Patrimônio (13/11/2026, migração 023)

Menu **Serviços → Patrimônio**. Só para o Administrador e o Operador SLM da equipe SLM, pela permissão `patrimony:manage`.

- **Cadastro:**
  - número do patrimônio, lido pelo leitor de código de barras ou digitado;
  - descrição, setor, sala, situação (em uso, ocioso, em manutenção, inservível, baixado);
  - marca, modelo, número de série;
  - data em que foi patrimoniado;
  - valor de aquisição, nota fiscal, fornecedor e observação.
  
  O número é único sem contar pontos, traços e espaços; os zeros à esquerda contam.
- **Leitor de código de barras (USB ou Bluetooth):** funciona como um teclado. Os campos de leitura recebem o número e o Enter, e o Enter não envia o formulário por engano. Ao ler, o sistema responde se o bem já foi patrimoniado, onde está (setor e sala), quando foi patrimoniado e quando foi conferido pela última vez. Se o número ainda não existir, oferece o cadastro.
- **Histórico:** cada cadastro, importação, alteração, mudança de local ou de situação e conferência fica registrado com data, pessoa, antes e depois, e não pode ser apagado.
- **Conferência:** por setor, por sala do setor ou geral. Cada leitura diz na hora se o bem está no local certo, em outro local, não cadastrado ou baixado. Quando o bem está em outro local, um botão registra o local novo, e o anterior fica no histórico. A conferência mostra os bens do local que ainda não foram lidos. Uma leitura repetida não duplica.
- **Importação pela planilha (robô, sem IA):** mesmos formatos e limites do robô do Almoxarifado. O robô acha as colunas, que podem ser trocadas na tela. A prévia mostra:
  - o que é novo;
  - o que já está cadastrado, onde e desde quando, e se a planilha indica outro local;
  - as linhas com problema (sem número, número repetido, sem descrição).
  
  Só os bens novos são cadastrados: os existentes não mudam pela planilha.

### Página inicial, Ajuda e limpeza dos dados de teste (13/11/2026)

- **Página inicial pública:** é a primeira tela no endereço principal do site, antes de entrar. Tem:
  - abertura com os botões Entrar e Criar conta;
  - o que dá para pedir (só os módulos ligados);
  - como funciona;
  - perguntas frequentes;
  - quem somos (JUCESP e SLM);
  - equipe com foto;
  - novidades;
  - contato por e-mail.
  
  Endereços diretos de telas internas continuam levando ao login. `/entrar` e `/cadastro` abrem os formulários. O conteúdo é editado em **Configurações → Página inicial e Ajuda** e é público. Fotos: só JPEG, PNG ou WebP, reduzidas no navegador para até 400×400, com no máximo 400 KB, guardadas no banco e servidas em `/api/public/team-photos/<id>`. Uma foto que deixa de ser usada sai na gravação seguinte, depois de um dia.
- **Ajuda (menu Conta):** para quem entrou, com as mesmas perguntas, novidades, equipe e contato.
- **Limpar dados de teste:** em Configurações, só para o Administrador com `settings:manage`. A pessoa:
  1. escolhe os módulos;
  2. vê quantos registros saem;
  3. baixa a cópia em JSON;
  4. digita a frase. No banco principal, a frase é outra e mais forte.
  
  Se os dados mudaram depois da cópia, nada é apagado. Na limpeza:
  - tudo acontece numa transação só, e qualquer erro desfaz tudo;
  - só os gatilhos de proteção das tabelas tocadas são desligados, e são religados dentro da mesma transação;
  - os protocolos são recalculados: um módulo vazio volta a 00001, e um número que sobrou nunca se repete;
  - os anexos saem do armazenamento;
  - a Auditoria registra a limpeza e nunca é apagada.
  
  Cadastros (usuários, setores, materiais, veículos, atas) e configurações ficam.
