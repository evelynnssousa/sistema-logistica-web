# Requisitos funcionais

Regras definidas pela instituição, na forma em que foram recebidas. O que estiver em dúvida fica em `PLANO_DESENVOLVIMENTO_INTEGRAL.md`, na seção "Questões em aberto", e não é tratado aqui como requisito.

## Instituição e acesso

- A equipe operacional SLM tem quatro integrantes e pertence ao setor maior CPC, com cerca de vinte pessoas.
- A SLM atende todas as categorias de solicitações.
- Pertencer à SLM independe do setor de lotação.
- Somente integrantes da SLM individualmente autorizados abrem solicitações em nome de outros setores e realizam agendamentos, conforme as permissões concedidas.
- O perfil Administrador não concede automaticamente todas as permissões restritas.
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
- Previsão de entrega: só o dia, sem horário, informada e alterada por quem tem `warehouse:manage`. A alteração exige justificativa, e cada previsão fica em um histórico interno que não muda, com autoria, data e horário.
- O solicitante é avisado por e-mail e na central de notificações, uma vez por mudança real, e consulta protocolo, materiais, previsão, situação e data efetiva, sem justificativas nem observações.
- Relatórios: entradas e saídas do estoque interno por material, para quem administra o módulo.
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

Agenda interna de Manutenção e Frota, usando os mesmos registros de agendamento dos módulos. A agenda interna não depende do Google Calendar. Situação da integração em `INTEGRACOES_E_AUTOMACOES.md`.

### Auditoria

Autenticação, cadastros, perfis, permissões, CPF, solicitações, agendamentos, cancelamentos, configurações, Almoxarifado e status, com usuário, ação, data, horário, resultado e motivo. Usuários comuns não alteram nem apagam registros.
