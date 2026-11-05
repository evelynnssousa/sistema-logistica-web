# Identidade visual

Padrões da interface. Tokens e estilos em `frontend/src/styles/theme.css`, carregado depois dos estilos antigos; componentes em `frontend/src/components/ui/`.

## Paleta

| Token | Valor | Uso |
|---|---|---|
| `--black` | `#000000` | Menu lateral, abas, cartões de destaque, botão Sair |
| `--yellow` | `#FBB900` | Item ativo, botão principal, ícones sobre preto |
| `--white` | `#FFFFFF` | Cartões e campos |
| `--graphite` | `#162235` | Tom já usado no projeto: barras de gráfico, cartão de usuário, cartões |
| `--blue` | `#034EA2` | Só links, foco e avisos informativos. Nunca como destaque dominante |
| `--page` | `#F4F4F1` | Fundo das páginas |
| `--success`, `--danger`, `--warning` | `#146C43`, `#B42318`, `#7A4B00` | Estados, sempre com ícone e texto |

Regras de contraste:

- Amarelo nunca é cor de texto sobre branco. Sobre amarelo, o texto e o ícone são pretos.
- O logotipo oficial tem letras pretas, por isso fica sempre sobre fundo branco. Suas cores não foram alteradas.

## Ícones

**Biblioteca:** `@phosphor-icons/react`, compatível com React 19. A importação é por ícone, então só os usados entram no pacote final, mas cada um traz seus seis pesos. O JavaScript da tela, somado aos módulos novos, tem cerca de 550 kB (153 kB comprimidos). Se pesar, a saída é carregar as telas sob demanda.

Use sempre `components/ui/Icon.tsx`, que associa um nome de significado ao desenho. Não importe a biblioteca nas telas nem use emojis ou caracteres como ícone.

| Peso | Uso |
|---|---|
| `fill` | Navegação e ações |
| `duotone` | Indicadores, cartões e estados vazios |
| `bold` | Setas e controles pequenos |

## Componentes

| Componente | Finalidade |
|---|---|
| `PageHeader` | Título, descrição e ações. Sem o nome do sistema: `eyebrow` só para o contexto do registro aberto |
| `StatCard` | Indicador em preto, amarelo, grafite ou branco |
| `Alert`, `EmptyState`, `Loading` | Mensagens, estados vazios com ilustração e carregamento |
| `FilterBar`, `FilterSelect`, `SearchField`, `PeriodFields` | Filtros suspensos, com "Limpar filtros" |
| `usePeriodFilter` | Períodos prontos e datas personalizadas |
| `Pagination` | Paginação |
| `StatusBadge` | Situação com cor, ícone e texto |
| `Modal`, `useConfirm` | Janela com `<dialog>` nativo: prende o foco e fecha com Esc |
| `BarChart`, `MonthlyChart` | Gráficos de uma série e uma cor, com valores em texto |

Botões: `ui-button-primary` amarelo, `maintenance-secondary-button` com contorno preto, `ui-button-danger` vermelho.

## Gráficos

- Só dados reais das APIs. Sem dados, estado vazio.
- Uma série, uma cor (grafite). Identidade e valor sempre em texto.
- Barras não mudam de cor conforme o valor. Colunas mensais mostram o valor ao passar o mouse ou focar.

## Navegação

- Menu lateral preto, com grupos: Serviços, Acompanhamento, Administração e Conta. O item ativo tem fundo amarelo e ícone preto.
- Almoxarifado é um único item, com abas: Visão geral, Solicitações, Nova solicitação, Pedido externo, Materiais, Inventário e Relatórios. Cada aba tem endereço próprio e respeita as permissões.
- Início serve ao dia a dia: atalhos para abrir pedidos, pendências e solicitações recentes. Dashboard concentra indicadores e gráficos.
- Títulos não repetem o nome do sistema, e não há avisos de versão ou de desenvolvimento.

## Responsividade

| Largura | Comportamento |
|---|---|
| A partir de 1024 px | Menu lateral fixo |
| Abaixo de 1024 px | Menu em gaveta, aberta pelo botão do topo. Fecha com Esc, no fundo escurecido, no botão X ou ao navegar |
| Até 700 px | Filtros em coluna, indicadores em duas colunas, auditoria em cartões |
| Até 420 px | Indicadores em uma coluna |

Tabelas largas rolam dentro do próprio quadro, nunca a página.

## Acessibilidade

Foco visível (azul no claro, amarelo no preto), controles nativos, rótulos em todos os campos e respeito a `prefers-reduced-motion`.

`e2e/visual-review.e2e.cjs` verifica em computador, tablet e celular:

- contraste de 4,5:1 (3:1 em texto grande);
- nome acessível em cada controle;
- alvos de ao menos 24 px;
- ausência de rolagem lateral;
- ausência dos textos removidos.

## Controle de Demandas

Segue os componentes acima, com estilos em `styles/demands.css`. Botões e item ativo continuam no padrão do sistema, em amarelo e preto. O azul marca o que é próprio do módulo: progresso, seleção de visualização, linha do tempo, colunas do quadro, repetição e marcas.

## Telas modernizadas

Também seguem estes padrões as telas do Supercomando 04: Central SLM, Pesquisa, Veículos, Equipamentos, Estoque interno, Monitoramento e Revisão de acessos. Estilos em `styles/operations.css`.

Entrada, Início, Dashboard, Manutenção, Frota, Passagens (listas, formulários e detalhes), Almoxarifado (todas as abas, pedido e conferência), Calendário, Relatórios, Configurações, Cadastros pendentes, Usuários, Auditoria, Minha conta e Acesso negado.
