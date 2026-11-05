# Plano de contingência

O que fazer quando o sistema estiver indisponível, e como devolver ao sistema o que foi atendido nesse período. **É uma proposta**: nomes, contatos e prazos marcados como "a definir" dependem da SLM e da TI.

## Durante a transição

Enquanto o sistema antigo (Google Sheets e Apps Script) estiver ativo, ele continua sendo a primeira alternativa para abrir pedidos, se a instituição confirmar. Essa regra evita um segundo procedimento. Nada aqui altera o sistema antigo.

## Quando acionar

| Situação | O que fazer |
|---|---|
| Tela ou API fora do ar por mais de 15 minutos (a definir) | Acione a TI e inicie o registro em papel ou planilha |
| Banco de dados fora do ar | Igual. Nada pode ser gravado |
| Só e-mail ou calendário com falha | **Não é contingência.** O sistema segue funcionando, e os envios ficam na fila. Veja Integrações e Monitoramento |
| Só anexos com falha | **Não é contingência.** Registre a solicitação e anexe depois |
| Suspeita de acesso indevido ou vazamento | Pare e acione a TI e a área de proteção de dados. Não siga este plano |

Quem aciona: integrante da SLM de plantão (a definir). Contato da TI: (a definir).

## Registro temporário

Só atendimentos essenciais. Pedidos que podem esperar aguardam a volta do sistema.

Cada atendimento recebe uma **referência de contingência única**, no formato `CONT-AAAAMMDD-NN`, escrita à mão, em sequência. Ela identifica o registro até existir um protocolo. **Nunca invente um protocolo no formato do sistema** (`MAN-2026-00001`): esse código é gerado somente pelo backend.

| Campo | Observação |
|---|---|
| Referência de contingência | `CONT-20261104-01` |
| Módulo | Manutenção, Frota ou Passagens |
| Data e hora do pedido e do atendimento | |
| Solicitante e setor | |
| Quem atendeu e quem registrou | |
| O que foi pedido e o que foi feito | |
| Pendências | |

**Dados pessoais:** não anote CPF em papel nem em planilha. Em Passagens, emissão só depois da volta do sistema, salvo decisão da chefia, com os dados tratados pelo canal já autorizado. Guarde os registros em local restrito, e elimine as cópias depois da conciliação.

## Volta ao normal

1. **TI confirma a recuperação:** a tela de Monitoramento mostra banco e API disponíveis, e a causa fica registrada.
2. **Se houve restauração de cópia:** confirme até que momento os dados foram recuperados. O que foi gravado depois disso precisa ser conferido como se fosse contingência.
3. **Quem registrou lança cada atendimento**, em ordem, na tela normal de cada módulo.
4. **Antes de lançar, pesquise** pela referência e pelo solicitante, para não duplicar. A referência `CONT-...` entra na descrição da solicitação, e por isso a pesquisa global a encontra.
5. **Execução real:** informe os horários reais de início e término. Assim, os indicadores não tratam o lançamento como se fosse o atendimento.
6. **Segunda pessoa confere** a lista de referências contra os protocolos gerados, e anota o protocolo ao lado de cada uma.
7. **Encerre:** guarde a lista conferida como comprovante, pelo prazo definido pela área responsável (a definir).

## Rastreabilidade

- A data de abertura no sistema será a do lançamento. A data real fica na descrição e nos horários de execução, o que mantém os dois momentos visíveis.
- A linha do tempo mostra quem lançou. Quem atendeu fica no campo próprio ou na descrição.
- Nos relatórios do período, indique a contingência: tempos até o atendimento podem ficar distorcidos.

## Testes deste plano

Sugestão: simular uma vez por semestre, com registros fictícios **em ambiente separado**, nunca no banco real. O teste de restauração de cópias é mensal, como em `BACKUP_E_MIGRACOES_SUPABASE.md`.
