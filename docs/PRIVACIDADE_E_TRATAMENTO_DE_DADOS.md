# Privacidade e tratamento de dados

Descreve o que o sistema coleta e faz, conforme o código, em 04/11/2026.

**Este documento não é uma política de privacidade nem um parecer jurídico.** A revisão pela área institucional responsável não foi realizada. Base legal, prazos de guarda, controlador, encarregado e canais de atendimento ao titular não foram fornecidos e, por isso, não constam aqui nem nas telas.

## Avisos nos formulários

Os avisos aparecem antes do envio em Manutenção, Frota, Passagens e Almoxarifado, com finalidade, dados necessários e uso no serviço. No pedido externo do Almoxarifado, voltado à equipe, o aviso explica o registro manual. Texto em `frontend/src/app/privacyNotices.ts`.

**O aviso não é um consentimento.** Isso mudou neste supercomando:

| Antes | Agora |
|---|---|
| Passagens: "Ao clicar em enviar, você concorda com o armazenamento", e a API recusava o envio sem `lgpdAceite` | Aviso informativo, sem aceite obrigatório |
| Almoxarifado gravava `lgpd_aceite = true` sem nunca ter perguntado | Grava `false`, o valor padrão |
| Nada indicava o que a pessoa tinha visto | A versão do aviso fica no histórico da solicitação (`avisoPrivacidade`) |

**Registros antigos:** as colunas `lgpd_aceite` e `lgpd_aceite_em` foram mantidas, sem uso. Um `true` gravado pelo código anterior não comprova consentimento.

Ao mudar um texto, atualize a versão em `frontend/src/app/privacyNotices.ts` e em `backend/src/integrations/privacyNotices.ts`.

## Dados coletados

| Módulo | Dados | Finalidade | Quem acessa |
|---|---|---|---|
| Conta | Nome, e-mail, setor, senha (guardada só como resumo) | Acesso e identificação | A própria pessoa; `users:read` |
| Sessão | Registro de sessão, com token guardado só como resumo | Autenticação | Sistema |
| Manutenção | Identificação da conta; andar, sala, local, descrição, observações | Atender o serviço | Solicitante; equipe com `requests:read_all` e permissão do módulo |
| Frota | Identificação da conta; origem, destino, datas, finalidade, veículo, **nome dos passageiros**, observações | Executar o deslocamento | Idem |
| Passagens | Identificação da conta; andar, sala, trechos, bagagem, observações; **nome e CPF dos passageiros** | Cotar, aprovar e emitir | Idem. CPF: ver abaixo |
| Almoxarifado, interno | Identificação da conta; materiais, quantidades, observação; **nome de quem recebeu** | Atender e entregar | Solicitante; `warehouse:manage` ou `requests:read_all` |
| Almoxarifado, externo | Referência, setor, materiais; **nome e e-mail institucional do solicitante, opcionais** | Acompanhar pedido de outro sistema e comunicar a previsão de entrega | `warehouse:manage` ou `requests:read_all`. A conta aprovada com o e-mail informado vê só protocolo, materiais, previsão, situação e data efetiva |
| Almoxarifado, previsão | Datas prevista e efetiva; **justificativa da alteração e observação sobre a entrega, internas** | Informar o solicitante e controlar a entrega | Datas: solicitante. Justificativas, observações e histórico: `warehouse:manage` ou `requests:read_all` |
| Auditoria | Quem fez, ação, data, resultado | Rastreabilidade | `audit:read` |
| Notificações | Módulo, protocolo, situação | Avisar sobre o andamento | A própria pessoa, enquanto tiver a permissão |
| Fila de e-mails | Endereço do destinatário, cópias, assunto, situação de envio | Enviar e comprovar comunicações | `integrations:read`, com o endereço mascarado |

Campos adicionais criados no editor de formulários são texto livre e não entram em e-mails, notificações ou eventos.

### Coleta mínima: pontos a avaliar

- **Campos de observação e descrição** são livres e podem receber dados que não deveriam.
- **Nome dos passageiros de Frota** é guardado em `dados` (JSON), sem as proteções do CPF.
- **Detalhes da solicitação:** o e-mail do solicitante aparece para a equipe que a atende.

## Proteção do CPF

| Controle | Situação |
|---|---|
| Guarda | Cifrado pela aplicação (AES-256-GCM), com a chave fora do banco |
| Exibição | Mascarado para todos, por padrão |
| CPF completo | Só para quem é da equipe SLM, em perfil elegível, com concessão individual, verificado no backend |
| Consulta | Cada leitura e cada recusa ficam na auditoria |
| Histórico e auditoria | Guardam só quantidades de passageiros |
| E-mails, notificações, eventos, logs | Nunca recebem o CPF |
| CPF digitado por engano em texto livre | Mascarado em comentários, motivos, ocorrências e em tudo o que sai do sistema. **Não** é mascarado em descrição e observações do formulário nem nos campos adicionais |

## Comunicações

| Canal | Contém | Não contém |
|---|---|---|
| E-mail | Módulo, protocolo, situação, datas de agendamento, motivo de cancelamento ou reagendamento; assunto da solicitação, exceto em Passagens | CPF, passageiros, descrição, trechos |
| Notificação | Módulo, protocolo, situação, data | Motivo, assunto, nomes, CPF |
| Agenda interna | Módulo, protocolo, título, situação, setor, responsável; em Passagens, data e horário da ida e da volta | Solicitante, descrição, passageiros e CPF. Não sai do sistema: o calendário externo foi removido em 11/11/2026 |
| Logs | Tipo de evento e código do erro | Endereços, conteúdo, motivos |

**Dados saem da instituição quando o e-mail for ligado.** O Resend passa a receber o que está acima. Ainda não foi ativado. (O Google Calendar foi removido em 11/11/2026 e não recebe mais nada.) A área responsável precisa avaliar:

- a contratação e a localização do tratamento nos dois provedores;
- **o título no calendário externo**, que vem de texto livre, como o local do serviço ou origem e destino;
- quem terá acesso aos calendários institucionais;
- o motivo incluído nos e-mails, que também é texto livre.

## Retenção e descarte

**Decisão da instituição (14/11/2026): guarda de 1 ano** para solicitações, CPFs de passageiros, anexos e registros de auditoria. Antes de cada mês de registros completar o prazo, o sistema abre uma demanda no setor escolhido para imprimir ou salvar os relatórios e as planilhas do mês (Configurações → Sistema → Guarda dos dados: prazo, antecedência e setor). O que fazer depois do prazo (apagar ou anonimizar) ainda não foi decidido.

**Nada é apagado automaticamente.** Isso vale para solicitações, passageiros, histórico, auditoria, eventos, fila de e-mails e notificações. A migração 005 impede apagar histórico e auditoria, e a 006, eventos e tentativas: quando houver política aprovada, será preciso um procedimento próprio.

Pontos para a política:

- CPF de passageiros, depois de encerrada a viagem;
- endereços em `email_deliveries`, que continuam guardados depois de a conta ser desativada;
- notificações antigas.

`authAuditRetentionDays` (365) existe no código, mas nenhuma rotina o aplica. Trate esse valor como não aprovado.

## Pendências institucionais

| Item | Responsável |
|---|---|
| Validar o texto dos avisos | Área institucional competente |
| Definir a base legal de cada tratamento e a eventual necessidade de consentimento | Área institucional competente |
| Identificar controlador e encarregado, e o canal do titular | Instituição |
| Prazo de guarda: aprovado, 1 ano (14/11/2026). Falta decidir o descarte depois do prazo | Instituição |
| Avaliar o compartilhamento com o provedor de e-mail (Resend, Brevo ou Microsoft 365) | Área institucional competente e TI |
| Revisão de segurança | Área responsável |

## Anexos, pesquisa e registros técnicos (Supercomando 04)

- **Anexos podem conter dados pessoais**, sobretudo bilhetes e comprovantes. Em Passagens, ficam restritos à equipe por padrão, e o conteúdo fica fora do banco, sem endereço público. Toda consulta passa pela sessão e é auditada. A remoção é lógica: o arquivo permanece, e a retenção precisa ser definida com a área responsável.
- **Nome do arquivo** não entra no histórico nem na auditoria, porque pode trazer o nome de uma pessoa.
- **Pesquisa global** não lê passageiros, CPF, e-mail nem os dados completos das solicitações. Cada categoria respeita o alcance da tela correspondente.
- **Observações internas e justificativas de gestão** não aparecem para quem só solicita. CPF digitado nesses textos é mascarado ao gravar.
- **Produtividade por pessoa** é dado de gestão: só com a permissão da Central, sem nota nem classificação. Vale avaliar o uso com a área responsável antes de adotá-lo em avaliações.
- **Registros técnicos** guardam só serviço, evento e código. Ficam 180 dias.
