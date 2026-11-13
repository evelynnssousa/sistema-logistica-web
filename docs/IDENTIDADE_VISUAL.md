# Identidade visual

Padrões da interface. Tokens e estilos em `frontend/src/styles/theme.css`, carregado depois dos estilos antigos; componentes em `frontend/src/components/ui/`.

## Paleta

Identidade executiva, adotada em 2026-11-07. Ela substitui a antiga, de preto e amarelo. As cores existem só como tokens em `theme.css`. As variáveis antigas `--jucesp-*` de `App.css` apontam para esses tokens, então não há uma segunda paleta.

| Token | Valor | Uso |
|---|---|---|
| `--executive` | `#17365D` | Menu lateral, abas de módulo, títulos (`--heading`), gráficos |
| `--institutional` | `#034EA2` | Ações: botão principal, item ativo do menu e das abas, links, foco, informação |
| `--accent` | `#FBB900` | Só detalhe: traço do item ativo, faixa do cartão de entrada, marca de destaque, foco sobre fundo escuro |
| `--page` | `#F1F4F8` | Fundo geral |
| `--surface` | `#FFFFFF` | Cartões, campos, tabelas e modais |
| `--text` | `#475467` | Texto e rótulos |
| `--text-muted` | `#667085` | Texto secundário (4,5:1 sobre o fundo geral) |
| `--border` | `#E4E9F0` | Bordas de cartões e divisórias |
| `--border-strong` | `#8A94A6` | Contorno de campos e botões secundários (3:1, o mínimo do WCAG para controles) |
| `--success`, `--info`, `--warning`, `--danger` | verde `#146C43`, azul `#034EA2`, laranja `#B54708`, vermelho `#B42318` | Situações, sempre com ícone e texto. Nunca amarelo |

`theme.css` também guarda os tokens de tipografia (`--font-*`), forma (`--radius*`), profundidade (`--shadow*`), espaço (`--space-*`) e interação (`--focus-ring*`, `--transition`).

Regras:

- Preto não é cor de área. Amarelo não é fundo de botão, de aba nem de cartão, e nunca é cor de texto sobre branco.
- Botão principal: azul institucional com texto branco. Botão secundário: branco, com contorno `--border-strong` e texto azul executivo.
- O logotipo oficial tem letras pretas, por isso fica sempre sobre fundo branco. Ele não foi alterado.

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
| `StatCard` | Indicador. **Desde 12/11/2026, todos em cartão branco**, com ícone em azul sobre fundo azul claro (decisão da responsável). A propriedade `tone` continua no código, mas não muda a aparência |
| `Alert`, `EmptyState`, `Loading` | Mensagens, estados vazios com ilustração e carregamento |
| `FilterBar`, `FilterSelect`, `SearchField`, `PeriodFields` | Filtros suspensos, com "Limpar filtros" |
| `usePeriodFilter` | Períodos prontos e datas personalizadas |
| `Pagination` | Paginação |
| `StatusBadge` | Situação com cor, ícone e texto |
| `Modal`, `useConfirm` | Janela com `<dialog>` nativo: prende o foco e fecha com Esc |
| `BarChart`, `MonthlyChart` | Gráficos de uma série e uma cor, com valores em texto |

Botões: `ui-button-primary` azul institucional, `maintenance-secondary-button` branco com contorno discreto, `ui-button-danger` vermelho.

### Padrão das telas (12/11/2026)

Regras únicas, na seção "Padronização visual" do fim de `theme.css`:

- **Cabeçalho:** toda tela usa `PageHeader`. O rótulo acima do título (`eyebrow`) só em telas de um registro ("Usuário", "Veículo", "Minha conta"), nunca em listas.
- **Cartões:** todo conteúdo fica em `ui-card` (branco, borda `--border`, cantos `--radius`, sombra `--shadow`, 20 px de espaço). Cartões dentro de cartões usam `--radius-small` e sem sombra.
- **Filtros:** sempre dentro de um cartão. Nas listas, no cartão da tabela; soltos na página, `FilterBar` ganha cartão próprio automaticamente.
- **Botões:** 42 px de altura e o mesmo tamanho de letra. Dentro de tabelas, versão compacta de 34 px ("Ver", "Gerenciar", "Encerrar"), sempre como botão, nunca como link de texto.
- **Mensagens:** `Alert` para erro, sucesso e aviso; `Loading` para carregamento; `EmptyState` dentro de cartão para lista vazia. Nada de parágrafo solto com `role="alert"`.
- **Rodapé de cartão:** ações finais em `ui-card-actions`, alinhadas à direita.
- **Paginação:** sempre o componente `Pagination`.

## Gráficos

- Só dados reais das APIs. Sem dados, estado vazio.
- Uma série, uma cor (azul executivo). Identidade e valor sempre em texto.
- Barras não mudam de cor conforme o valor. Colunas mensais mostram o valor ao passar o mouse ou focar.

## Navegação

- Menu lateral em azul executivo, com grupos: Serviços, Acompanhamento, Administração e Conta. O item ativo tem fundo azul institucional, ícone branco e um traço amarelo à esquerda.
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

Foco visível (azul institucional no claro, amarelo no azul executivo), controles nativos, rótulos em todos os campos e respeito a `prefers-reduced-motion`.

`e2e/visual-review.e2e.cjs` verifica em computador, tablet e celular:

- contraste de 4,5:1 (3:1 em texto grande);
- nome acessível em cada controle;
- alvos de ao menos 24 px;
- ausência de rolagem lateral;
- ausência dos textos removidos.

## Controle de Demandas

Segue os componentes acima, com estilos em `styles/demands.css`. Botões e item ativo seguem o padrão do sistema, em azul institucional. "Vence em breve" usa o laranja de atenção. O azul marca o que é próprio do módulo: progresso, seleção de visualização, linha do tempo, colunas do quadro, repetição e marcas.

## Telas modernizadas

Também seguem estes padrões as telas do Supercomando 04: Central SLM, Pesquisa, Veículos, Equipamentos, Estoque interno, Monitoramento e Revisão de acessos. Estilos em `styles/operations.css`.

Entrada, Início, Dashboard, Manutenção, Frota, Passagens (listas, formulários e detalhes), Almoxarifado (todas as abas, pedido e conferência), Calendário, Relatórios, Configurações, Cadastros pendentes, Usuários, Auditoria, Minha conta e Acesso negado.

## Visual moderno (13/11/2026)

As telas internas seguem o padrão da página inicial, por meio de `frontend/src/styles/modern.css`, carregado depois de `theme.css`. O arquivo muda só a aparência, sem cor nova:

- menu lateral, abas dos módulos e telas de entrada usam o degradê azul executivo com uma grade sutil;
- o logotipo fica maior, num cartão branco levemente inclinado;
- o título de cada tela vira uma faixa clara com um filete azul, e o sobretítulo ganha o traço amarelo;
- cantos são mais arredondados e as sombras mais suaves;
- indicadores e cartões sobem levemente ao passar o mouse;
- campos ganham um halo azul quando estão em foco.

Todo degradê tem uma cor sólida equivalente por trás, para o teste automático de contraste e para navegadores antigos. Animações são desligadas com `prefers-reduced-motion`, e degradês e sombras são desligados na impressão.
