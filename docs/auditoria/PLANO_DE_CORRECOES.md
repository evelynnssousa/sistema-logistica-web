# Plano de correções

Proposta da auditoria de 05/11/2026. **Nada aqui foi executado.** Cada item depende de autorização específica. Os problemas estão descritos em `RELATORIO_AUDITORIA_GERAL.md`, seção D.

## Fase 0: proteger o que existe, antes de qualquer outra coisa

| Ordem | Item | Quem | Depende de | Pronto quando |
|---|---|---|---|---|
| 1 | P-00: registrar o código no Git e enviar ao GitHub | Autorização da responsável | Nada | `git status` limpo, exceto ignorados, e branch igual à remota |
| 2 | P-10: guardar uma cópia cifrada fora do Codespace | Responsável, com orientação | Escolha do local | Cópia aberta e com SHA-256 conferido em outra máquina |

## Fase 1: antes de aplicar as migrações no banco real

| Ordem | Item | Quem | Depende de | Pronto quando |
|---|---|---|---|---|
| 3 | Decidir o conjunto: 16 migrações ou 12 | Responsável | Nada | Decisão registrada. Recomendação: as 16, que são as testadas juntas |
| 4 | P-03 e P-24: revogar as sequências novas, conferi-las no script e corrigir o significado da saída 1 | Desenvolvimento | Item 1 | `test:migrations` falha se uma sequência nova ficar aberta |
| 5 | P-02: migração que retira de `anon`, `authenticated` e `service_role` o acesso às 8 tabelas e 2 sequências antigas | Desenvolvimento e decisão da responsável | Item 1 | `has_table_privilege` falso em todas as tabelas de `public`, e a API segue passando na suíte |
| 6 | P-24: procedimento testado de recuperação do banco real | Desenvolvimento | Item 2 | Documento próprio, com o resultado do ensaio |
| 7 | P-25: decidir sobre as contas fictícias e os cadastros pendentes | Responsável | Nada | Decisão registrada. Exclusão só com autorização |
| 8 | P-01: aplicar as migrações | Autorização expressa | Itens 1 a 7 | Saída 0, contagens conferidas e tela aberta |

## Fase 2: decisões que mudam regras

| Item | Pergunta |
|---|---|
| P-08 | O Administrador fora da SLM pode agendar e editar previsão de entrega? O Supercomando 01 diz que não, e o código permite |
| P-07 | O Almoxarifado recebe pedidos dos setores (Supercomando 01) ou é só controle interno (04 a 07)? Isso decide o destino de "Nova solicitação" e "Pedir material" |
| P-18 | Azul nos elementos principais (Supercomando 09) ou sem dominar (Supercomando 02)? |
| Matriz | Confirmar que a Matriz Definitiva substitui o item 4 do Supercomando 10 (acesso de integrantes da DA e da SLM sem setor) |

## Fase 3: dependências da TI e da instituição

| Item | O que falta | Pronto quando |
|---|---|---|
| P-11 | Definir onde o sistema roda em produção, ligar os processos e o monitoramento | API, tela e processos no ar fora do Codespace |
| P-04 | `PASSENGER_DATA_KEY`, com cópia segura, e `ATTACHMENTS_DIR`, com cópia própria | Passageiro e anexo gravados e lidos no ambiente real |
| P-05 | Credenciais Resend e `PASSWORD_RESET_PEPPER`; conta de serviço e calendários Google | Roteiro de homologação de `INTEGRACOES_E_AUTOMACOES.md` concluído |
| P-09 | Lista oficial de domínios | Domínio fora da lista recusado no ambiente real |
| P-10 | Rotina automática de backup | Execução agendada, com alerta e teste de restauração |
| P-16 | Base legal, prazos de retenção e responsáveis | Avisos e documento validados pela área competente |
| P-06 | Acesso ao sistema antigo ou roteiro da área usuária | Comparação de textos, campos e destinatários concluída |

## Fase 4: desenvolvimento por módulo

| Módulo | Item | Gravidade | Pronto quando |
|---|---|---|---|
| Segurança | P-17: cabeçalhos globais de segurança e fonte hospedada localmente | Média | Teste confere os cabeçalhos em respostas da API, e nenhuma origem externa é bloqueada no E2E |
| Formulários | P-12: tipo de campo Anexo, ou decisão de dispensá-lo | Média | Campo publicado recebe arquivo validado, ou decisão registrada |
| Formulários | P-13: obrigatoriedade dos campos fixos no servidor | Média | API recusa o campo vazio quando publicado como obrigatório |
| Comunicação | P-14: permissão de envio por perfil e conta de envio | Média | Definidas pela tela, com a TI autorizando a conta |
| Anexos | P-20: antivírus, se a TI aprovar | Média | Arquivo de teste EICAR recusado |
| Demandas | P-15: anexo em etapa pela tela | Média | Anexo aparece na etapa e no histórico |
| Técnico | P-22: `strict` no frontend, limitador compartilhado se houver mais de uma instância, divisão do pacote e remoção do que está sem uso | Média e baixa | Build e suíte passam |

## Fase 5: acabamento

| Item | Pronto quando |
|---|---|
| P-18: remover o CSS legado e a redefinição de `--jucesp-blue` | Só as cores da paleta e semânticas no CSS |
| P-19: dividir Configurações | Cada grupo abre sem rolar a página inteira |
| P-21: teste com leitor de tela | Roteiro executado com NVDA ou VoiceOver |
| P-23: limites da Frota e do portal | Decisão ou correção registrada |
| P-26: atualizar documentos e numerar os Supercomandos sem repetição | Plano e Requisitos coincidem com esta auditoria |

## Validação final

Depois das fases 0 a 2, repetir `npm run test:all` e esta matriz. Fazer a aceitação com pessoas da SLM, nas contas reais, e só então reavaliar o parecer.
