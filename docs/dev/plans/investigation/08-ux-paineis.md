# 08 · UX dos painéis: workspace do caso e painéis laterais do grafo

> Avaliação feita em 2026-11-10 sobre `feature/context-look-clusters` (após o v0.42.0), sem alterar
> código de produto. Evidência: screenshots reais em **1440×900 e 1024×700** (390 px deixado de fora a
> pedido), API mockada pelos specs do e2e, capturadas por dois agentes `ux-reviewer`; inventário
> controle a controle feito sobre o código. As imagens citadas estão em
> [`screens/ux-2026-11-10/`](screens/ux-2026-11-10/) (`case-*.png`, `graph-*.png`), com os relatórios
> brutos (`case-report.md`, `graph-report.md`) e as medições (`*.json`, `graph-measurements.jsonl`).
> Nada aqui repete o que `docs/dev/ux-review.md` (#1–#30) marca como corrigido ou rejeitado; as
> rejeições registradas no decision log (tirar o Info e o chip MULTI; aba central no visualizador de
> item) ficaram fora da proposta.

> **Status (2026-11-10, mesmo dia):** aplicado por decisão delegada — todos os ganhos rápidos de §6.1,
> as médias M4 (parcial: Enrich e Console saíram da barra; Metrics ficou), M6 (parcial), M7 (rótulos),
> M8, M9 (coluna e linha clicável), M10, M11 e a estrutural A em versão reduzida (material dobrável em
> trilho, colunas mais estreitas abaixo de 1200 px, faixa de chips rolável), C em versão reduzida
> (Undo ao limpar filtros), D (rótulos) e E (o item pede o caso em vez de sumir). Ficaram para depois:
> M1 (header em duas camadas), M2 ("About the case"), M3 (menu "…" por linha), M5, M12, B (um modelo de
> painel), F (Similarity). Registro: `docs/dev/ux-review.md` #31–#46 e o decision log de 2026-11-10.

**Como ler.** §1 é a tabela de achados com screenshot e medida. §2 é o percurso das cinco tarefas.
§3 é o inventário com a classificação MANTER / JUNTAR / MOVER / ESCONDER / REMOVER. §4 é o esboço
antes/depois do workspace. §5 trata da manipulação direta dos painéis. §6 agrupa tudo em ganhos rápidos,
mudanças médias e mudanças estruturais que precisam de decisão sua. §7 diz o que foi verificado e está
correto e o que não foi possível verificar. **O foco pedido foi o médio e o estrutural**; os ganhos
rápidos estão listados em uma linha cada só para não se perderem.

## 0. Resumo em dez linhas

1. O workspace do caso cabe em 1440 e **não cabe em 1024**: colunas fixas de 290 + 320 px deixam um
   canvas de 414×349 px, que cai para 414×216 com oito grafos e 414×177 com um título longo
   (`case-1024-workspace-many-all.png`, `case-1024-workspace-long-names.png`).
2. O painel **Layout** do caso sai do canvas e cobre o header e a própria toolbar
   (`case-1024-workspace-panel-layout-measured.png`); no grafo, **Layout e Info** abrem no mesmo canto e
   o Info tapa o fechar do Layout (`graph-1440-layout+info-populated.png`).
3. **Filtrar e voltar** falha nos dois lugares: no caso, um filtro sem resultado deixa o canvas em branco
   com a status bar dizendo "10 nodes" (`case-1440-workspace-T4-filtered.png`); no grafo, o painel Filters
   reaberto mostra tudo marcado com o canvas ainda filtrado (`graph-1440-filters-task-reopened.png`).
   Não há desfazer em nenhum dos dois.
4. **Registrar a decisão** não dá retorno nenhum (`case-1440-workspace-decide-recorded.png`); exportar só
   existe no dossiê.
5. **Adicionar entidade ao caso** a partir do grafo depende de um chip no canto da barra superior que
   nada liga ao grafo; sem caso atual a ação some do menu sem explicar
   (`graph-1440-case-step2-menu-no-case.png`).
6. O mesmo número de sugestões aparece **quatro vezes** na primeira tela do caso; "Confirm all" confirma
   sem mostrar o quê (`case-1440-workspace-strip-suggestions.png`).
7. Erros chegam como texto bruto do servidor ("boom", "Request failed with status code 500") e um
   snapshot que falha vira canvas vazio com um ⚠ de 12 px sem tooltip
   (`case-1440-workspace-error-snapshot.png`).
8. O vocabulário de evidência é "Pin" no botão, "Pinned · hash eeeeeeee" no toast e "E1" no dossiê.
9. Nada no caso é redimensionável, movível ou persistido além do grupo da lista e do canvas escolhido;
   no grafo só os drawers redimensionam, e esquecem o tamanho ao recarregar.
10. Acessibilidade: foco visível em todos os 40 stops, Escape fecha drawer e popover, overflow horizontal
    zero; mas 34 alvos abaixo de 24 px por tela, abas sem `role=tab`, Escape não fecha o dock do grafo e
    três legendas abaixo de 4,5:1.

## 1. Achados por severidade

Severidade: 4 bloqueia a tarefa · 3 atrasa muito ou induz a erro · 2 atrito claro · 1 polimento.
Heurísticas de Nielsen H1–H10. "Custo" é o que o analista paga.

| # | Sev | Superfície · largura | O que acontece (screenshot) | Custo para o usuário | Heur. | Menor correção |
|---|---|---|---|---|---|---|
| C1 | **4** / 3 | Caso · painel Layout · 1024 / 1440 | O `.layout-panel` é absoluto no `.canvas-area` com `bottom` fixo e `max-height: calc(100vh − 150px)`; cresce para cima até **y −82** em 1024 (título, ✕ e "Force" fora da tela) e cobre nav, header e a própria toolbar; o probe não conseguiu clicar em Table com ele aberto (`case-1024-workspace-panel-layout-measured.png`, `case-1440-…`) | Perde o header; em 1024 a única saída é o toggle que ele cobre | H8, H3 | Posicionar como `panel-filters` (dentro do canvas, `top:12px`, altura limitada) ou colocá-lo no mesmo dock dos outros três |
| C2 | **3** | Caso · workspace · 1024 | Grid `290px 1fr 320px` sem `@media` (`InvestigationView.vue:928`): canvas **414×349**; **414×216** com 8 chips (faixa de 160 px); **414×177** com título de 140 caracteres (header 213 px); toolbar e barra de análises quebram em duas linhas (`case-1024-workspace-populated.png`, `-many-all.png`, `-long-names.png`) | O grafo, razão da página, vira um selo | H8 | Abaixo de ~1200 px: material vira trilho de 48 px, inspector vira overlay como os painéis; chips em uma linha rolável a partir de 4 |
| C3 | **3** | Caso · chips de filtro · ambas | `role: mule` sem nó confirmado → canvas em branco, nenhuma mensagem, status ainda "10 nodes · 9 edges", botão de limpar rotulado "✕ 1" (`case-1440-workspace-T4-filtered.png`) | Não distingue "nada casa" de "o grafo sumiu"; a status bar contradiz a tela | H1 | Overlay "No node matches role: mule · Clear" quando o conjunto filtrado é vazio; status "0 of 10 nodes"; rótulo "Clear (1)" |
| C4 | **3** | Caso · decisão · ambas | Decide → preencher → **Record decision**: sem toast, sem confirmação, o inspector volta à seleção anterior; a única pista é "Journal · 2 → 3" na faixa recolhida (`case-1440-workspace-decide-recorded.png`); Escape não cancela o painel | Não sabe se D2 foi registrada, numerada, hasheada ou se fechou o caso | H1 | Toast "Recorded D2 · <outcome>" com ação "Dossier"; limpar a seleção para "Decisions so far" aparecer; Escape = Cancel |
| C5 | **3** | Caso · grafo com snapshot em erro · ambas | `GET …/snapshot` 500: canvas vazio, status "0 nodes", nenhum `canvas-error`; o ⚠ do chip tem **12×12 px e nenhum `title`**; o ⚠ da lista mostra o texto bruto "boom" só em tooltip (`case-1440-workspace-error-snapshot.png`) | Grafo vazio sem motivo; o único sinal é minúsculo e mudo | H9 | Reusar o overlay `canvas-error` ("Bank B transfers could not be loaded: … · Retry · Open exploration") e dar o mesmo `title` ao chip |
| G1 | **3** | Grafo · Filters · ambas | Desmarcar *Company* → "34 nodes 38 edges"; fechar: nenhum chip; reabrir: **as 7 caixas marcadas**, canvas ainda filtrado (`graph-1440-filters-task-company-hidden.png`, `graph-1440-filters-task-reopened.png`). Estado local do painel, que desmonta com o dock | Não vê o que escondeu nem consegue remarcar só aquilo; "34 nodes" parece o tamanho do dataset; o próximo clique apaga o filtro anterior | H1, H6 | Guardar os conjuntos ocultos na store do grafo; chip "Filtered: 1 type hidden ✕" na status bar (mesmo componente de `status-isolation`) |
| G2 | **3** | Grafo · canvas · ambas | O grafo assenta ocupando **12 % da largura** do canvas e nunca é enquadrado (3/3 recargas); Fit → 42 % (`graph-1440-fit-run0-before.png`, `-after.png`); drawers encolhem o canvas sem re-enquadrar (Console em 1024 deixa 208 px, `graph-1024-console-populated.png`) | Todo load começa com um ponto no meio | H1, H7 | `zoomToFit()` no layout-done de um load novo e, com debounce, no resize do container |
| G3 | **3** | Grafo · barra superior · 1024 | O controle *Unsaved* fica com **8×20 px** e os toggles pintam por cima do título do contexto (`elementFromPoint` no título devolve o ícone de Filters) (`graph-1024-topbar-with-case.png`) | O ponto de entrada do Save (#6 do ux-review) some numa largura comum de laptop | H8, H4 | `.toolbar-left { flex: 0 1 auto; min-width: 0 }`, `.exploration-state { flex-shrink: 0 }`, badge vira ícone abaixo de ~1100 px; asserção em `responsive-layout.spec.ts` |
| G4 | **3** | Grafo · Layout + Info · ambas | Ambos flutuam no canto superior esquerdo: Layout `16,70 240×750`, Info `16,68 300×728`; o Info cobre o ✕ do Layout (`graph-1440-layout+info-populated.png`, `graph-1024-…`) | Dois painéis "livres" que a regra de exclusividade (#4) não cobre | H4, H1 | Exclusivos via `setDocked`, ou Info ancorado à direita; duas linhas em `GraphVisualizationView.vue` |
| C6 | 2 | Caso · evidência (T3) · ambas | Transformar a nota em evidência exige achar o item na lista, abrir detalhes e apertar **Pin** (sem tooltip); toast "Pinned · hash eeeeeeee"; o dossiê chama de "E1"; a decisão de "pinned evidence" (`case-1440-workspace-T3-pinned.png`) | Três nomes para um conceito; um hash como confirmação | H2, H4 | "Pin as evidence" no botão e na linha da nota do inspector; toast "Pinned as E1 (v1)" |
| C7 | 2 | Caso · faixa Suggestions · ambas | Só "role · agent 1 ✓ Confirm all ✕ Reject all"; entidade, valor e motivo só aparecem selecionando o nó (`case-1440-workspace-strip-suggestions.png` vs `case-1440-workspace-node-selected.png`) | Confirmar saída do agente às cegas contraria o quatro-olhos | H6, H5 | Listar as sugestões (entidade · valor · motivo) sob o grupo; manter o "Confirm all" |
| C8 | 2 | Fila · título longo · ambas | Coluna CASE encolhe a ~70 px, uma palavra por linha, linha de **495 px** (`case-1440-queue-long-names.png`) | A fila deixa de ser varrível | H8 | `th.case { width: 32%; min-width: 220px }`, `overflow-wrap: anywhere` na linha de id/tag, e-mail com ellipsis + `title` |
| C9 | 2 | Caso · material e faixa · ambas | **34 alvos < 24 px** na tela populada: remover 11×19, pin 16×19, checkbox 13×13, ↗ 26×14, ⚠ 12×12 (`case-1440-workspace-populated.png`) | Erro de clique em ações destrutivas e frequentes | H7 | `min-width/height: 24px` nas ações de linha; checkbox 16 px nas superfícies do caso |
| C10 | 2 | Caso e fila · erros · ambas | Texto bruto do servidor: fila "boom Retry" com contadores em 0; caso "boom · Retry · ← Queue"; salvar título → toast "boom" e o título volta; salvar nota → "boom" em vermelho 260 px acima do botão, sem toast (`case-1440-queue-error.png`, `case-1440-workspace-error-save-note.png`) | Não sabe o que falhou nem o que fazer | H9 | Um `describeError(e)` ("Could not save the note (HTTP 500)") nos quatro sítios; erro da nota junto do botão; contadores "—" quando a lista falhou |
| G5 | 2 | Grafo · adicionar ao caso (T2) · ambas | Sem caso atual o item "Add selection to case" **não existe** no menu (`graph-1440-case-step2-menu-no-case.png`); o painel de detalhes nunca oferece; com caso, funciona e o toast não tem o "view" que o código promete (`graph-1440-case-step7-toast-single.png`) | O analista não descobre o caminho; precisa saber que o chip no canto é pré-requisito | H6, H10 | Item sempre visível; sem caso abre o menu do chip; a mesma ação no header do `SidePanel` |
| G6 | 2 | Grafo · seleção múltipla · 1440 | Nenhuma contagem visível da seleção; o painel segue "Node Details" do último nó; a segunda adição levou 2 de 3 nós em silêncio, com o mesmo toast de 1 nó (`graph-1440-case-step8-multi-selected.png`) | Não sabe quantos está adicionando | H1 | Chip "N selected ✕" (mesmo componente do `status-isolation`) e a contagem no toast |
| G7 | 2 | Grafo · filtros × "Show only" · 1440 | Isolamento diz "24 of 46 nodes shown" mas os contadores ficam "46 nodes 77 edges"; Filters → Reset não limpa o isolamento; ✕ de 18×19 px | Dois modelos de "o que está visível" que se ignoram | H4, H1 | Uma contagem de nós visíveis para ambos; Reset limpa os dois |
| G8 | 2 | Grafo · Clusters · ambas | Largura do dock salta **360 → 177 px** na aba Similarity; o painel tem 720 de 848 px de altura, dock em dois tons (`graph-1440-clusters-results-populated.png`, `graph-1440-clusters-similarity-populated.png`) | Canvas, toolbar e status pulam ao trocar de aba | H4, H8 | `width` fixo e `height: 100%` em `.cluster-panel` |
| G9 | 2 | Grafo · drawers · 1024 | Console de 440 px deixa **208 px** de canvas; Table 280 px; o redimensionar funciona (alça de 8 px, só mouse) mas nada persiste (`graph-1024-console-populated.png`) | Em laptop, abrir o console apaga o grafo; o tamanho ajustado se perde | H7, H3 | Default `min(440px, 45vh)` em `useDrawerResize`; persistir altura por drawer |
| G10 | 2 | Grafo · teclado · 1440 | Escape nunca fecha um painel do dock; 9 Tabs do botão Look até suas abas; setas não trocam aba apesar do `role=tablist` | Usuário de teclado preso no painel | H3, H4 | Estender `useEscapeToCloseModals` para `setDocked(null)` sem overlay; focar o `h3` ao abrir; setas no tablist do `LookPanel` |
| C11 | 2 (1024) | Caso · faixa inferior · ambas | Nada redimensiona; a faixa expandida (207 px) não sobrevive ao reload (`timelineCollapsed = ref(true)`), ao contrário dos grupos da lista (`localStorage`) | Reabre a cada visita; em 1024 a faixa tira 207 dos 349 px | H7 | Persistir `timelineCollapsed`/`timelineTab` por caso como a lista já faz |
| C12 | 1 | Caso · texto `muted` · 1440 | `.muted` 12 px `#6c757d` sobre `#f5f5f5` = **4,30:1** (rótulos Type/Assignee/Tags); sobre branco 4,69 | Falha AA em texto normal | WCAG 1.4.3 | `--color-text-muted: #5f6b76` (5,0:1) |
| G11 | 1 | Grafo · erro de query · 1440 | Modal + toast com prefixo dobrado "Query failed: Query failed: …"; um clique POSTou duas vezes (`graph-1440-query-error-modal.png`) | Ruído | H8, H9 | Sem toast quando há modal; `getErrorMessage` não re-prefixa |
| G12 | 1 | Grafo · erro de carga · 1440 | "Failed to load graph — Request failed with status code 500", sem botão (`graph-1440-no-panel-context-error.png`) | Beco sem saída | H9 | Mapear erros axios uma vez; "Back to contexts" no `.error-state` |
| G13 | 1 | Grafo · Filters · 1440 | Tipo longo cortado sem `title`; o painel rola de lado (`graph-1440-filters-long-type.png`) | — | H8 | `overflow-wrap: anywhere; min-width: 0` + `title` |
| G14 | 1 | Grafo · Node Details · ambas | O título "Node Details" quebra em duas linhas; ações ocupam 196 de 267 px (`graph-1440-node-details-populated.png`) | — | H8 | Ações em ícones ou abaixo do título |
| G15 | 1 | Grafo · alvos e contraste · 1440 | Checkboxes 13×13, trilhos de slider 4 px, ✕ do Layout 20×20, `group-eye-*` 19×19; `.help-text` do Clusters `#999/#f9f9f9` = **2,71:1**, `.section-hint` de Labels 3,54, `.hint` de Behaviors 4,11 | — | H7, WCAG | Uma passada em `main.css` (tokens e tamanhos mínimos) |
| C13 | 1 | Caso · tooltip do canvas · ambas | O hover card WebGL ("a1@ctx-a · Person") fica pintado por cima do drawer ⚙ e do popover Add (`case-1440-workspace-add-popover.png`) | — | H8 | Esconder o tooltip ao abrir qualquer overlay |

Não entrou por falta de screenshot (hipóteses do código a confirmar numa rodada futura): o drawer ⚙ ignora
Escape embora o comentário prometa; o `Type` do drawer não é travado após decisão como o do header; o
chip "⚠ truncated" abre Behaviors, onde não há controle de limite de arestas; "Cancel" do drawer fecha
sem perguntar sobre mudanças.

## 2. Percurso cognitivo das cinco tarefas

Para cada passo: **sabe o que fazer? · vê o controle? · entende o rótulo? · recebe retorno?**

### T1 · Abrir um caso e entender o estado em 10 segundos (`case-1440-workspace-populated.png`, `case-1024-workspace-populated.png`)

| Passo | Sabe | Vê | Rótulo | Retorno | Problema |
|---|---|---|---|---|---|
| Fila → título do caso | sim | sim (só o link do título; a linha não é clicável) | sim | spinner "Opening the case…" | linha de 495 px com título longo (C8) |
| Ler o header | sim | status, prazo, responsável, "● 2 suggestions", Dossier/Decide/⚙/Share/… | sim | — | a contagem de sugestões repete em header, Material, faixa e status bar; "Open" dentro do select parece um segundo status |
| Ver o que está no canvas | sim | chips de grafo + status "10 nodes · 1 source" | sim | auto-fit em até 4 s | em 1024 são 5 linhas antes do canvas; 8 grafos = faixa de 160 px (C2) |
| Ver o que está pendente | parcial | "DECISIONS SO FAR" só com nada selecionado; Tasks · 2 só na faixa recolhida | sim | — | o que mudou desde a última visita exige expandir a faixa → Journal → "Since my last visit"; abrir o caso já sobrescreve o carimbo |
| Ver o brief | sim | "★ Brief — No brief yet. Write" | sim | — | brief e descrição são dois campos livres sobre o caso |

Veredito: a primeira tela responde estado, prazo, responsável e canvas em 1440; o custo é redundância e,
em 1024, a altura do que vem antes do canvas.

### T2 · Adicionar uma entidade ao caso a partir do grafo (`graph-1440-case-step*.png`)

| Passo | Sabe | Vê | Rótulo | Retorno | Problema |
|---|---|---|---|---|---|
| Página do grafo, nenhum caso atual | **não** | chip "No current case" no canto direito da barra | sim | — | nada liga o chip à ação no grafo (G5) |
| Botão direito no nó | — | menu sem item de caso, sem dica | — | — | a ação some em vez de explicar (G5) |
| Painel de detalhes do nó | — | Default focus · Open details · × | — | — | nunca oferece "Add to case" (G5) |
| Abrir o chip, buscar, escolher o caso | sim | busca, RECENT, "New case", "With a type…" | sim | chip verde | id truncado no chip |
| Botão direito → "Add selection to case" | sim | item 187×29 | sim | toast "Added to case …" | sem "view"; mesmo texto para 1 ou N nós (G6) |
| No caso: onde foi parar? | parcial | nova linha em Graphs ("Selection · N nodes"), desmarcada | sim | journal | **não entra no canvas** (default pula itens congelados); precisa marcar a caixa ou clicar no chip |

Veredito: completa, mas só para quem já conhece o chip; o item some sem caso, e o resultado não aparece
no canvas do caso.

### T3 · Anotar uma evidência e ligá-la a um item (`case-1440-workspace-notes-add-form.png` → `-T3-pinned.png`)

| Passo | Sabe | Vê | Rótulo | Retorno | Problema |
|---|---|---|---|---|---|
| Selecionar o nó → aba Notes | sim | sim | sim | — | — |
| "Add a note…" → Add note | sim | sim (y 552/900) | sim | nota na lista, "Notes (2)", N3 na lista; sem toast (aceitável) | — |
| Virar evidência | **não** | não há pin na aba Notes; caminho: lista → N3 → detalhes → **Pin** | "Pin" não diz "evidência" | toast "Pinned · hash eeeeeeee", "📌 Pinned" | vocabulário (C6) |
| Ligar a um item | **não** | não existe controle: âncoras são só entidades/arestas; "Items (N)" do nó lista quem cita | — | — | lacuna de modelo, não de tela |
| Ligar a uma hipótese | parcial | só no dossiê, só evidência já pinada | sim | chip "E1 …" | fluxo em duas páginas |

### T4 · Filtrar o canvas e voltar ao estado anterior

Caso (`case-1440-workspace-T4-role-menu.png` → `-filtered.png` → `-cleared.png`): chip role ▾ → "mule" →
canvas vazio com status "10 nodes" (C3) → "✕ 1" limpa tudo de uma vez; não há desfazer; `views ▾` salva e
aplica uma vista nomeada, não "o estado anterior"; aplicar uma vista **grava `groups_closed` e
`canvas_items` no caso para todos**. Grafo (`graph-1440-filters-task-*.png`): Filters esconde um tipo,
fecha sem chip, reabre tudo marcado (G1); Reset zera tudo, sem toast nem Undo; "Show only" tem chip
próprio e contadores próprios (G7); a única volta real é recarregar a exploração salva.

Veredito: completa nos dois, mas "voltar" é sempre "zerar", e o estado filtrado é invisível ou
contraditório.

### T5 · Registrar uma decisão e exportar o relatório (`case-1440-workspace-decide-mode.png` → `-decide-recorded.png` → `case-1440-dossier-decisions-exports.png`)

| Passo | Sabe | Vê | Rótulo | Retorno | Problema |
|---|---|---|---|---|---|
| **Decide** no header | sim | sim (61×23) | sim | inspector vira "Record the decision" | escondido sem permissão/durante revisão, sem explicação |
| Preencher 1 · Outcome, 2 · About, Rationale, Reviewer | sim | sim | sim | "Add your own words" | "About" só aparece com nó selecionado |
| **Record decision** | sim | sim | sim | **nenhum** (C4) | Escape não cancela |
| Exportar | **não** do canvas | só no dossiê: JSON package · CSV · Print report | sim | download (próprio retorno); print sem toast | "Export" da toolbar é PNG do canvas: colisão de nome |
| Draft report | parcial | ausente no tipo General, sem explicar | — | — | estado vazio mudo |

## 3. Inventário por painel

Classificação: **MANTER** · **JUNTAR** (fundir com outro controle) · **MOVER** (outro lugar) ·
**ESCONDER** (divulgação progressiva: menu "…", "Advanced", hover) · **REMOVER**. Marcação **P** =
poluição: não serve a nenhuma das cinco tarefas, duplica informação visível em outro lugar ou quase
nunca muda. Controles homogêneos estão agrupados numa linha; o inventário exaustivo (com condição de
visibilidade e test id de cada um) está nos relatórios brutos da pasta de evidência.

### 3.1 Header do caso (`CaseHeader.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| ← Queue, #número, título editável | MANTER | T1; frequência alta |
| Status (select), Stage (select) | MANTER | T1; estado do caso |
| ⏱ prazo + barra | MANTER | T1 |
| "Decision proposed", "Decision waiting for review" | MANTER | estados raros mas decisivos para T5 |
| "● N suggestions" (badge inerte) | JUNTAR | virar o **único** ponto clicável que abre a faixa Suggestions; remover as cópias em Material e status bar (**P**: 4 cópias) |
| Dossier / Canvas | MANTER | vira segmentado "Canvas · Dossier" |
| Decide | MANTER | ação primária de T5 |
| Share · N | ESCONDER | sob "…": ação por caso, baixa frequência |
| ⚙ | ESCONDER | sob "…": chaves de identidade, SLA e vocabulário quase nunca mudam (**P** na primeira linha) |
| "…" (Agent tokens, Reopen, Delete) | MANTER | recebe Share e Settings |
| Type (select) | ESCONDER | travado após decisão e quase nunca muda: texto com edição em ⚙ (**P**) |
| Campos do tipo (chips editáveis) | MANTER | dados do caso; frequência média |
| Assignee | MANTER | T1 |
| Tags (texto) | MANTER | — |
| Descrição ("Add a description…") | JUNTAR | com o Brief: dois campos livres sobre o caso (**P**) |
| Banner read-only | MANTER | — |

### 3.2 Lista de material (`CaseItemsPanel.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| "MATERIAL", + Add | MANTER | T2/T3 |
| "N suggested" | REMOVER | duplicado no header (**P**) |
| ícone de upload | JUNTAR | a aba File do popover Add já faz isso (**P**) |
| ★ Brief (chip vN, Edit/Write, texto até 160 px) | MOVER | para o topo do inspector vazio ("sobre o caso"), junto da descrição e de "Decisions so far": é leitura de T1, não material |
| Busca; "hide N rejected" | MANTER | — |
| Cabeçalhos de grupo com contagem | MANTER | — |
| Linha: checkbox "on canvas", anel/dot da fonte, título, id curto (G1, N3) | MANTER | T1/T4 |
| chip de autor "you" | ESCONDER | mostrar só "agent"; humanos em tooltip (**P**: toda linha diz "you") |
| badge 📌 vN, badge "suggested", ⚠ | MANTER | ⚠ ganha `title` |
| ↗ abrir exploração | MANTER | hover/foco |
| 🔗 (sem URL) | REMOVER | duplica o ↗ (**P**) |
| ação "only" (hover) | REMOVER | clicar na linha já mostra só aquele grafo (**P**) |
| checkbox de seleção de tabela | ESCONDER | só com ≥ 2 tabelas |
| ▸ expandir query, ▶ rodar | MANTER / ESCONDER | ▶ vai para o card expandido |
| ✓ ✕ da sugestão | MANTER | inline; alvo 24 px |
| pin, × remover | MOVER | para um menu "…" por linha ("Pin as evidence", "Remove"); some a fileira de 5 ícones de 11–16 px |
| sub-linha "last run …" | MANTER | — |
| barra de operações de tabela | MANTER | condicional |
| Removed (restore) | MANTER | — |
| compor Note / Markdown | JUNTAR | "Note" fica (atalho de T3); Markdown vai para Add › Paste (**P**) |

### 3.3 Faixa sobre o canvas: chips de grafo + toolbar (`CaseGraphChips.vue`, `GraphCanvasToolbar.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| chips de grafo (clique = só este; Shift soma) | MANTER | T1/T4; acima de 4 chips: uma linha rolável + "+N" |
| All graphs (N) / One at a time | MANTER | — |
| "N entities merged by identity key: …" | ESCONDER | no menu legend ▾ (**P**: texto longo na faixa) |
| legend ▾ | MANTER | — |
| Filters | JUNTAR | com os chips de filtro: o chip `type ▾` já é o filtro de tipos; o painel só acrescenta busca e tipos de aresta → entram nos chips |
| Table, Layout, Look, Clusters, Fit, 3D/2D, Fullscreen | MANTER | Layout corrigido (C1) |
| Export (PNG) | ESCONDER | colide com "exportar relatório" (T5); vai para "…" do canvas ou para o Look |
| Metrics (sem botão; só via barra de análises) | MOVER | para a toolbar, ao lado de Clusters; o popover "Metrics" da barra some |

### 3.4 Chips de filtro (`CaseFilterChips.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| source ▾ | REMOVER | os chips de grafo já escolhem a fonte: duas formas de esconder um grafo (**P**) |
| role ▾, tag ▾, group ▾, type ▾ | MANTER | chips sem opção **somem** em vez de ficarem cinza (**P**: tag/group vazios na tela) |
| ⏱ janela | MANTER | — |
| "✕ N" | MANTER | rótulo "Clear (N)" |
| views ▾ (aplicar / salvar) | MANTER | aplicar não deve gravar `groups_closed`/`canvas_items` no caso sem avisar |

### 3.5 Inspector (`SelectionInspector.vue`, `ItemDetails.vue`, `ItemPreview.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| Vazio: dica + "Decisions so far" | MANTER | T1; recebe o Brief |
| Entidade: tipo · id, nome, chips de fonte/grupo/anotação, Seen in other cases | MANTER | — |
| Role, Tags | MANTER | T3 |
| card de sugestão (✓ Confirm / ✕ Reject) | MANTER | — |
| Follow the money →, Path to… | MANTER | duplicam barra e menu, mas são o atalho natural |
| Full profile, Open details | JUNTAR | duas portas para "mais detalhe" → uma ("Details") |
| Default focus | ESCONDER | configuração por item, quase nunca muda: footer do Look ou "…" (**P**) |
| abas Data · Items · Enrichment · Notes · Origin | MANTER | Enrichment escondida sem fonte de enriquecimento; `role=tab` |
| Data › Events (últimos 5) | MOVER | filtro "about this entity" no Journal (**P** na aba de dados) |
| Notes › textarea + Add note | MANTER | ganha "Pin as evidence" por nota (T3) |
| Aresta: extremos clicáveis, chips, trace nos dois sentidos, Data · Notes | MANTER | — |
| Multi: Role/Tag/Group/Same as/Note em lote | MANTER | Group aqui é o lugar; sai do popover Groups |
| Save selection, Compare | MANTER | — |
| Use as parameter | ESCONDER | power-user |
| Item: Author, Status, Versions, Hash, Run, Query, Mapping, Params | ESCONDER metade | Status bruto só quando ≠ confirmed; Hash e Params dentro de Versions (**P**) |
| Open exploration ↗, Show analysis, Use in the dossier | MANTER | — |
| Pin | MANTER | renomear "Pin as evidence" |
| Preview · ⤢ Expand · Download | MANTER | — |
| Edit, Edit text, Upload new version, Versions | MANTER | — |
| ↑ ↓ reordenar | ESCONDER | raro (**P**) |
| Modo decisão (DecisionPanel) | MANTER | retorno ao gravar (C4) |

### 3.6 Barra de análises (`AnalysisBar.vue`, `GroupsPanel.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| Follow the money, Paths, Links | MANTER | análises de fato |
| Groups | MANTER | tira "From the selection" (duplicado no inspector multi); fica "By…" e a lista |
| Enrich | REMOVER | é uma lista + botão de upload; vai para Add › File (papel enrichment) e para a aba Enrichment (**P**) |
| Metrics | MOVER | botão na toolbar do canvas abre o painel; "Save as a table" vira botão do próprio painel |
| Detectors · N | MANTER | condicional ao tipo |
| Console | JUNTAR | com + Add › Query (é o que ele abre) (**P**) |
| Formulários (trace, paths, links) | MANTER | "Trace"/"Find paths" desabilitados em caso read-only |

Resultado: 8 botões → 5 (Follow the money · Paths · Links · Groups · Detectors), uma linha em 1024.

### 3.7 Faixa inferior e status bar (`CaseTimeline.vue`, `CaseTasksPanel.vue`, `GraphStatusBar.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| abas Dated edges · Journal · Tasks · Suggestions · Result; ▴/▾ | MANTER | `role=tab`; estado persistido |
| Suggestions: grupos + Confirm all | MANTER | lista as sugestões (C7) |
| Journal: filtros Person/Agent/System, kind, Since my last visit, busca | MANTER | — |
| Tasks: filtros, lista, novo | MANTER | — |
| Status bar: N nodes · N edges | MANTER | contar o conjunto visível |
| ⚠ truncated, N clusters, Showing only ✕ | MANTER | — |
| N sources (+ restricted) | MANTER | — |
| N groups | ESCONDER | duplica chip group ▾ (**P**) |
| ● N suggestions | REMOVER | 4ª cópia (**P**) |
| ◆ agentes | MANTER | — |
| "Journal" (link) | REMOVER | duplica a aba (**P**) |
| ? Shortcuts | MANTER | — |

### 3.8 Drawer ⚙, Share, Add, Look (`CaseSettingsDrawer.vue`, `ShareDialog.vue`, `AddItemsPopover.vue`, `LookPanel.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| ⚙ › General (Name, Type, Description) | REMOVER | duplica o header, e com regra diferente (Type não travado) (**P**) |
| ⚙ › Deadlines, Members + Share…, Agent, Vocabularies, Identity keys, Edge semantics, Label templates | MANTER | Escape fecha; Cancel pergunta se há mudanças |
| Share: e-mail, papel, lista | MANTER | — |
| Add: My recent · New exploration · Query · File · Paste/link | MANTER | recebe Console e Markdown |
| Look: Style · Labels · Behaviors · Presets; Save look / Reset look | MANTER | recebe "Default focus" |

### 3.9 Dossiê (`CaseDossier.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| Summary (descrição, brief, chips) | MANTER | — |
| tiles Graphs · Material · Evidence · Hypotheses · Journal · Suggestions | ESCONDER metade | Material e Journal são contagens sem decisão associada (**P**); ficam Evidence, Hypotheses, Suggestions |
| Hypotheses, Evidence, Notes and documents, Tables, Tasks | MANTER | — |
| Journal (últimos 8 + "See all") | MANTER | — |
| Decisions: lista, revisar, DecisionPanel, "Record another decision" | MANTER | — |
| JSON package · CSV · Print report | MANTER + MOVER | também em "Export ▾" do header, alcançável do canvas (T5) |
| Draft report | MANTER | desabilitado com motivo quando o tipo não tem template |

### 3.10 Fila (`InvestigationsView.vue`)

| Controle | Classe | Motivo |
|---|---|---|
| Busca, Status, Type, Assignee, Cases; campos do tipo | MANTER | — |
| contadores (toggles) | JUNTAR | duplicam o select Status; ficam como filtros, o select perde as opções que eles cobrem |
| abas Cases · My tasks | MANTER | — |
| colunas CASE, TYPE, SUGGESTIONS, STATUS, ASSIGNEE, DEADLINE, UPDATED | MANTER | linha inteira clicável |
| coluna MATERIAL ("0 items") | ESCONDER | não decide nada na fila (**P**) |
| coluna CREATED | ESCONDER | quase nunca muda; UPDATED basta (**P**) |
| paginação | MANTER | — |

### 3.11 Painéis laterais do grafo (resumo; inventário completo em `graph-report.md` e no relatório do explorador)

| Painel | Controles | Classe | Motivo |
|---|---|---|---|
| Barra superior | 7 toggles (Filters, Query, Templates, Look, Metrics, Clusters; Precomputed no menu), Load, Save, Add to case, chip de caso, Export, ⓘ, usuário | MANTER | abaixo de 1600 px só ícone + `title`; corrigir a sobreposição em 1024 (G3) |
| Node/Edge Details | Default focus, Open details, ×, ID, Type, Properties (+ hints), Computed Metrics | MANTER; **falta** "Add to case" | Default focus ESCONDER em "…" (**P**: raro) |
| Filters | Reset, Search, Node Types, Edge Types | MANTER | estado na store (G1); contagem por tipo; busca rotulada ("highlight" é o default e não parece filtro) |
| Look › Style | Edges (6), Nodes (2), Node/Edge Colors & Icons, Labels (6), Details Display, Property Visibility | ESCONDER | Details Display e Property Visibility vão para Behaviors › Advanced: não são "look" |
| Look › Labels | templates, tooltips, regras | MANTER | — |
| Look › Behaviors | lente, dimming, Advanced (busca, render, loading, culling, blower, clipping) | MANTER | já progressivo |
| Look › Presets | salvar, exportar, importar JSON, lista (★, ⬇, 🔗, 🗑) | ESCONDER | Import JSON atrás de "Import…"; ícones sem `aria-label` |
| Layout | modo (4), Ego (12 controles + Advanced), Hive (8), Hierarchical (6), Force (8 + Advanced 9), Layout by Edge Type | ESCONDER | "Layout by Edge Type" e os sliders de força sob Advanced; o painel tem 750 px |
| Info | Check schema, General, Tables, Node/Edge Structure, Properties, Statistics | MANTER; Statistics REMOVER | Statistics duplica a status bar (**P**); não remover o painel (rejeitado) |
| Query, Templates | editor, modo, Run; lista, Use/Edit/× | MANTER | "+ New" sem permissão deve sumir |
| Metrics | Compute · Visual Mapping · Custom; Resource Monitor | MANTER | Resource Monitor ESCONDER (**P**) |
| Clusters | Groups · Similarity; run bar; lista; Display | MANTER | largura fixa (G8); Similarity é outra coisa: aba própria em Metrics ou painel próprio é decisão sua |
| Table, Console | drawers redimensionáveis | MANTER | tamanho persistido (G9) |
| Menu de contexto | Copy ID, Add selection to case, sketch (2), Expand, Ego, comunidade (3), programas, ações configuradas | MANTER | "Add selection to case" sempre visível (G5) |

## 4. Reorganização do workspace do caso — antes e depois

Critérios: ordem pela sequência da tarefa (abrir → ler → anotar → filtrar → decidir → exportar) e pela
frequência; o que muda a cada seleção fica no inspector, o que muda a cada caso no header, o que quase
nunca muda vai para "…" ou ⚙.

### Antes (1440; `case-1440-workspace-populated.png`)

```
┌ ← Queue #id  Título            [In analysis ▾] ⏱ analysis · 6 d  ● 2 suggestions      [Dossier] [Decide] [⚙] [Share] [...] ┐
│ Type [General ▾]  Assignee [ana@…]  Tags MED  Add a description…                                                         │
├──────────────┬─────────────────────────────────────────────────────────────────────┬──────────────────────────────────┤
│ MATERIAL     │ ○ Bank A  ○ Bank B  All graphs (2)   [Filters][Table][Layout][Look]  │ Select a node…                   │
│ 2 suggested  │                                      [Clusters][Fit][Export][3D 2D]  │                                  │
│ [+Add] [⬆]   │ source▾ role▾ tag▾ group▾ type▾                     [Fullscreen] views▾│ DECISIONS SO FAR                 │
│ ★ Brief      │                                                                     │ D1 · Keep monitoring             │
│ No brief yet │                         (canvas 830×580)                            │                                  │
│ [search]     │                                                                     │                                  │
│ ▾ Graphs 2   │                                                                     │                                  │
│  ☑ ○ Bank A… G1 [you] ↗ 📌 ×                                                       │                                  │
│  ☐ ○ Bank B… G2 [you] ↗ 📌 ×                                                       │                                  │
│ ▾ Queries 1  │                                                                     │                                  │
│ ▾ Tables 1   │ [Follow the money][Paths][Groups][Links][Enrich][Metrics][Console]   │                                  │
│ ▾ Documents 2├─────────────────────────────────────────────────────────────────────┴──────────────────────────────────┤
│ ▾ Notes 2    │          Dated edges · Journal · 0 · Tasks · 2 · ● 2 suggestions                        ▴             │
│ Note Markdown├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
└ 10 nodes 9 edges 1 source ● 2 suggestions                     Journal                                 ? Shortcuts ┘
```

### Depois (proposta)

```
┌ ← Queue #id  Título                [In analysis ▾] ⏱ 6 d   [● 2 suggestions]   [Canvas | Dossier] [Decide] [Export ▾] [...] ┐
│ General · Assignee [ana@…] · Tags MED · Amount at risk [—]                                   ("…": Share · Settings · Reopen · Delete)│
├────────────┬───────────────────────────────────────────────────────────────────────┬──────────────────────────────────┤
│ MATERIAL   │ ○ Bank A  ○ Bank B  All (2)  legend▾  ·  role▾ tag▾ type▾  Clear (1) views▾ │ ABOUT THE CASE                   │
│ [+ Add]    │                            [Table][Layout][Look][Clusters][Metrics][Fit][3D 2D][⤢]│ Brief (2 linhas) · Edit          │
│ [search]   │                                                                       │ Decisions so far · D1 · Keep…    │
│ ▾ Graphs 2 │                                                                       │ Tasks open · 2                   │
│  ☑ ○ Bank A G1  ↗ …          (canvas 850×620)                                       │                                  │
│  ☐ ○ Bank B G2  ↗ …                                                                 │ (ao selecionar: entidade/aresta/ │
│ ▾ Queries 1│                                                                        │  item/seleção/decisão, como hoje,│
│ ▾ Tables 1 │                                                                        │  com "Pin as evidence" nas notas)│
│ ▾ Documents│ [Follow the money][Paths][Links][Groups][Detectors · 3]                 │                                  │
│ ▾ Notes 2  ├────────────────────────────────────────────────────────────────────────┴──────────────────────────────────┤
│ + Note     │        Dated edges · Journal · 0 · Tasks · 2 · Suggestions · 2 · Result                       ▴ (persistido)│
└ 10 of 10 nodes · 9 edges · 1 source · ◆ 1 agent                                                           ? Shortcuts ┘
```

O que muda, em ordem de impacto:

1. **Header em duas camadas.** Sempre visível: identidade (número, título), estado (status, stage,
   prazo), o único badge de pendência (sugestões, clicável) e as três ações da tarefa (Canvas/Dossier,
   Decide, Export ▾). Em "…": Share, Settings, Reopen, Delete, Agent tokens. Segunda linha: tipo como
   texto, responsável, tags, campos do tipo, sem descrição (vai para o brief).
2. **Inspector vazio vira "About the case"**: brief (2 linhas + Edit), decisões até aqui, tarefas abertas.
   É a resposta a T1 e tira o brief da lista de material, que volta a ser só material.
3. **Uma faixa sobre o canvas**: chips de grafo, legenda, chips de filtro (sem `source`, sem chips vazios,
   "Clear (N)"), views e a toolbar, numa linha em 1440 e duas em 1024; Metrics entra na toolbar,
   Export PNG sai (fica em Look ou "…" do canvas).
4. **Linha do material**: checkbox, anel, título, id, ↗ e um "…" por linha (Pin as evidence, Remove, Run
   again, Select for table ops); chip de autor só para agente; ✓ ✕ da sugestão inline.
5. **Barra de análises com 5 botões**; Groups sem o bloco "From the selection"; Console e Enrich saem.
6. **Status bar com uma contagem** ("10 of 10 nodes") que vale para chips, tipos e "show only"; some a
   4ª cópia de sugestões e o link "Journal".
7. **Exportar do canvas**: "Export ▾" no header com JSON package, CSV, Print report, Draft report (com
   motivo quando não há template); o botão PNG muda de nome ("Save canvas as PNG").
8. **Abaixo de ~1200 px**: material vira trilho de 48 px (ícones por grupo, expansível), inspector vira
   overlay como Filters/Look; a faixa de chips rola em uma linha. Isto é o item estrutural A de §6.

## 5. Manipulação direta dos painéis

### O que existe hoje

| Superfície | Redimensionar | Mover | Recolher | Destacar | Persiste |
|---|---|---|---|---|---|
| Caso: colunas 290 / 320 px | não | não | não | não | — |
| Caso: painéis flutuantes (Filters, Look, Clusters, Metrics: 320 px) | não | não | fechar | não | não (`panels` ref) |
| Caso: Layout (flutuante) | não | não | fechar | não | não |
| Caso: faixa inferior | não | não | sim (▴/▾) | não | **não** (`ref(true)`) |
| Caso: grupos da lista de material | — | — | sim | — | sim (`localStorage`) |
| Caso: canvas escolhido, look, foco, vistas | — | — | — | — | sim (estado do caso / item) |
| Grafo: dock exclusivo (7 painéis, 250–360 px) | não (`resize:none`) | não | fechar | não | não (memória) |
| Grafo: Layout e Info (flutuantes) | não | não | fechar | não | não |
| Grafo: drawers Table / Console | **sim** (alça de 8 px, só mouse; 120–60 % / 240–80 %) | — | fechar | — | **não** (fecham e voltam ao default no reload) |
| Grafo: legenda de grupos | — | — | sim (dobrar) | — | não |

### Onde resolveria um problema medido

| Problema medido | Manipulação que resolve | Alternativa sem manipulação |
|---|---|---|
| Canvas 414×349 em 1024 (C2) | **Recolher** material e inspector (trilho + overlay) ou **redimensionar** as colunas | regra responsiva fixa abaixo de 1200 px — resolve sem ensinar nada ao usuário; é a recomendada |
| Faixa inferior de 207 px sobre 349 px (C11) | **redimensionar** a altura da faixa + **persistir** recolhido/aba | altura máxima proporcional (`min(300px, 35vh)`) |
| Layout cobrindo header (C1) e Layout × Info (G4) | não é caso de arrastar: é posicionamento errado | dock/exclusividade |
| Console deixa 208 px em 1024 (G9) | **persistir** a altura que o usuário já pode ajustar; default proporcional | — |
| Lista de material com 8 grafos + 30 itens (scrollH 1705 / 694) | recolher grupos (já existe e persiste) | — |

### Onde seria só complexidade

Arrastar painéis flutuantes (Filters/Look de 320 px cabem em qualquer canto), redimensionar painéis de
overlay, destacar painéis em janela própria, e redimensionar colunas em 1440, onde a medida mostra o
canvas com 830×580 e nada cortado. A regra do `ux-review.md` ("uma terceira forma de fazer a mesma coisa é
regressão") vale aqui: cada alça nova é um estado a persistir, testar e explicar.

### Recomendação

Persistir o que já é manipulável (faixa do caso: recolhido e aba; drawers do grafo: altura; dock do
grafo: último painel aberto) numa chave por usuário em `localStorage` (`graphlagoon.layout.*`), como a
lista de material já faz com `graphlagoon.case.hideRejected`. Redimensionar colunas só como parte da
mudança estrutural A (trilho + overlay), e só o material e o inspector, com mínimo 240 e máximo 480 px,
persistido na mesma chave. Isso é o backlog M1 do plano 05, reduzido ao que a medição justifica.

## 6. Três grupos

### 6.1 Ganhos rápidos (uma linha cada; não são o foco desta rodada)

C1 Layout do caso dentro do canvas · C3 overlay "no match" + contagem "0 of 10" + "Clear (N)" · C4 toast
e Escape no Record decision · C5 overlay de erro de snapshot + `title` no ⚠ · G1 filtros na store + chip
"Filtered" · G2 fit no load e no resize · G3 barra superior em 1024 · G4 Info/Layout exclusivos ·
C7 listar as sugestões · C6 "Pin as evidence" + toast "Pinned as E1" · C8 largura da coluna CASE ·
C9/G15 alvos ≥ 24 px e tokens de contraste · C10/G11/G12 `describeError` + ação de volta · C11/G9
persistência de faixa e drawers · G8 largura fixa do Clusters · G10 Escape fecha o dock + setas no
tablist · G13/G14/C13 polimento.

### 6.2 Mudanças médias (uma a três sessões cada, sem decisão de modelo)

| # | Mudança | Resolve | Toca |
|---|---|---|---|
| M1 | Header em duas camadas: Canvas/Dossier · Decide · Export ▾ · "…" (Share, Settings, Reopen, Delete); Type como texto; descrição fundida ao brief | T1, T5, redundância | `CaseHeader.vue`, `CaseDossier.vue` (exports como ações reutilizáveis), `CaseItemsPanel.vue` |
| M2 | Inspector vazio = "About the case" (brief, decisões, tarefas abertas); brief sai da lista | T1 | `SelectionInspector.vue`, `CaseItemsPanel.vue` |
| M3 | Linha do material com "…" (Pin as evidence, Remove, Run again, Select); autor só agente; sem 🔗 e "only" | C9, C6, ruído | `CaseItemsPanel.vue` |
| M4 | Barra de análises 8 → 5; Metrics na toolbar; Console = Add › Query; Enrich = Add › File | ruído, 1024 | `AnalysisBar.vue`, `GraphCanvasToolbar` (botão `metrics`), `InvestigationView.vue` |
| M5 | Uma superfície de filtro no caso: chips (sem `source`, sem chips vazios) + busca e tipos de aresta; painel Filters sai do caso; uma contagem de visíveis na status bar | T4, C3 | `CaseFilterChips.vue`, `stores/caseFilters.ts`, `GraphStatusBar.vue` |
| M6 | Status bar e faixa: sem "Journal" link, sem 4ª cópia de sugestões, "N groups" escondido; sugestões listadas; `role=tab` nas abas do inspector e da faixa | T1, C7, a11y | `InvestigationView.vue`, `CaseTimeline.vue`, `SelectionInspector.vue` |
| M7 | Notas pináveis no lugar ("Pin as evidence" na linha da nota) e "Draft report" sempre visível com motivo | T3, T5 | `SelectionInspector.vue`, `CaseDossier.vue` |
| M8 | ⚙ sem a seção General; Escape fecha; Cancel pergunta se há mudanças; Type travado como no header | consistência | `CaseSettingsDrawer.vue` |
| M9 | Fila: linha inteira clicável; sem MATERIAL e CREATED; contadores como único filtro de status | T1 | `InvestigationsView.vue` |
| M10 | Grafo: "Add selection to case" sempre visível (sem caso abre o chip); a mesma ação no header de Node Details e um chip "N selected"; toast com contagem e "view" | T2 | `useContextMenu.ts`, `SidePanel.vue`, `GraphStatusBar.vue`, `useAddToCase.ts` |
| M11 | Grafo: tipos ocultos + isolamento + busca num só conjunto visível, uma contagem, Reset limpa tudo, "Filtered …" na status bar | T4 | `stores/graph.ts`, `FilterPanel.vue`, `GraphStatusBar.vue` |
| M12 | Grafo: Look › Style sem Details Display e Property Visibility (vão para Behaviors › Advanced); Presets com "Import…" dobrado; Layout com força e "by edge type" sob Advanced; Info sem Statistics | ruído | `AestheticsPanel.vue`, `BehaviorPanel.vue`, `StylePresetList.vue`, `LayoutPanel.vue`, `ContextInfoPanel.vue` |

### 6.3 Mudanças estruturais (precisam de decisão sua)

**A. Workspace do caso responsivo e canvas-first.** Abaixo de ~1200 px, material vira trilho de 48 px e o
inspector vira overlay (como Filters/Look); acima, colunas redimensionáveis (240–480 px) persistidas por
usuário. É o único jeito de o canvas passar de 414 px em 1024 sem tirar função. Decisão: trilho + overlay
(recomendado) ou só colunas redimensionáveis (M1 do plano 05).

**B. Um modelo de painel para as duas páginas** (débito #41, `GraphWorkspace`): dock exclusivo que inclui
Layout e Info, um host de drawers, uma status bar com uma contagem, Escape e persistência em um lugar.
Resolve C1, G4, G8, G10 de uma vez e evita que cada página reimplemente a regra. Decisão: fazer agora
junto com A, ou manter as duas implementações e aplicar as correções pontuais.

**C. "Voltar ao estado anterior" como função**: histórico curto de filtros/isolamento (toast "Filter
applied · Undo", como já existe para deletar rótulos e clusters) e "views" só para estados nomeados;
aplicar uma vista deixa de gravar `groups_closed`/`canvas_items` para todos sem avisar. Decisão: undo
local (recomendado) ou histórico persistido no caso.

**D. Evidência como conceito único na UI**: "Pin" → "Pin as evidence" em todo lugar, E-números no toast,
notas pináveis onde são escritas, hipóteses ligáveis a partir do inspector e não só do dossiê. Toca
vocabulário do guia público e dos tools MCP (texto, não modelo). Decisão: só rótulos (sem risco) ou
também o atalho "nota → evidência → hipótese" no inspector.

**E. Adicionar ao caso sem pré-requisito escondido**: o "caso atual" passa a ser perguntado no momento da
ação (menu "Add to case ▸ caso recente / escolher…") em vez de depender do chip. Decisão: manter o chip
como memória e acrescentar o submenu (recomendado) ou tirar o chip.

**F. Similarity fora do painel Clusters** (aba própria em Metrics ou painel próprio): hoje muda a largura do
dock e mistura dois conceitos. Decisão de produto, não de UX.

## 7. Verificado e correto · não verificado

**Verificado e correto (com screenshot):** nenhum overflow horizontal em nenhum estado nas duas larguras;
painéis flutuantes do caso nunca sobrepõem a barra de análises (gap de 12 px); estados read-only (caso
fechado e share de leitor) com banner e ações escondidas (`case-1440-workspace-readonly-reader.png`);
caso vazio e canvas vazio dizem o que fazer e oferecem "+ Add exploration"; erro de carga do caso oferece
Retry e ← Queue; Escape fecha o drawer ⚙ e o popover Add e o foco entra neles; anel de foco visível em
todos os 40 stops de Tab; `aria-label` em ⚙ e "…"; `aria-pressed` nas duas toolbars; exportações baixam
`investigation-<id>.json/.csv` e Print chama `window.print()`; paginação da fila escreve `?page=2` e
mantém filtros; no grafo, overlays de vazio/carregando/erro, modal de erro de query (nomeia a falha, copia,
Escape fecha), nomes longos em detalhes/templates/tabela com ellipsis e `title`, 20 templates e 30 tipos
rolam, chip de caso persiste no reload, "Showing only ✕" funciona, Table "Add to case (n)" funciona.

**Não verificado:** 390 px (fora do escopo desta rodada); estados de carregamento (mock instantâneo);
abas do inspector por teclado (a caminhada de 40 Tabs não saiu do header e da lista); drawer Table em
1024 (coberto pelo Layout, C1); "Draft report" com tipo que tem template; Save do ⚙ para leitor; fluxo
quatro-olhos e badge de proposta do agente (não semeados); 403 real ao adicionar a caso read-only (o mock
aceita); SidePanel flutuante em fullscreen; painel Precomputed; por que o segundo Ctrl-clique de T2
falhou. Hipóteses do código sem screenshot ficaram fora da tabela de §1 (listadas ao fim dela).

## Apêndice · índice de evidência

| Arquivo | Mostra |
|---|---|
| `case-1440-workspace-populated.png`, `case-1024-workspace-populated.png` | workspace populado nas duas larguras (canvas 830×580 / 414×349) |
| `case-1024-workspace-many-all.png`, `case-1440-workspace-many-all.png` | 8 grafos: faixa de chips de 160 / 86 px |
| `case-1024-workspace-panel-layout-measured.png`, `case-1440-…` | painel Layout fora do canvas (C1) |
| `case-1024-workspace-long-names.png` | header de 213 px, canvas 414×177 |
| `case-1024-workspace-strip-tasks.png` | faixa Tasks de 207 px em 1024 |
| `case-1440-workspace-T4-filtered.png` | filtro sem resultado (C3) |
| `case-1440-workspace-error-snapshot.png` | snapshot com erro (C5) |
| `case-1440-workspace-decide-mode.png`, `-decide-recorded.png` | T5 antes e depois de Record (C4) |
| `case-1440-workspace-strip-suggestions.png`, `case-1440-workspace-node-selected.png` | Confirm all vs card da sugestão (C7) |
| `case-1440-workspace-T3-pinned.png` | Pin e toast de hash (C6) |
| `case-1440-workspace-error-save-note.png`, `case-1440-queue-error.png` | erros brutos (C10) |
| `case-1440-queue-long-names.png`, `case-1440-queue-populated.png` | fila (C8) |
| `case-1440-dossier-decisions-exports.png` | exportações no dossiê (T5) |
| `case-1440-workspace-settings-drawer.png`, `case-1440-workspace-add-popover.png`, `case-1440-workspace-readonly-reader.png` | drawer, Add, leitor |
| `graph-1440-filters-task-company-hidden.png`, `graph-1440-filters-task-reopened.png` | Filters esquece (G1) |
| `graph-1440-case-step2-menu-no-case.png`, `-step6-menu-with-case.png`, `-step7-toast-single.png`, `-step8-multi-selected.png` | T2 (G5, G6) |
| `graph-1024-topbar-with-case.png` | barra superior em 1024 (G3) |
| `graph-1440-layout+info-populated.png`, `graph-1024-layout+info-populated.png` | Layout × Info (G4) |
| `graph-1440-fit-run0-before.png`, `-after.png` | grafo a 12 % e após Fit (G2) |
| `graph-1024-console-populated.png` | Console deixa 208 px (G9) |
| `graph-1440-clusters-results-populated.png`, `graph-1440-clusters-similarity-populated.png` | largura do dock salta (G8) |
| `graph-1440-node-details-populated.png`, `graph-1440-look-style-populated.png`, `graph-1024-look-style-populated.png`, `graph-1440-layout-populated.png`, `graph-1440-info-populated.png` | painéis do grafo (inventário) |
| `graph-1440-query-error-modal.png`, `graph-1440-no-panel-context-error.png`, `graph-1440-filters-long-type.png` | G11, G12, G13 |
| `case-report.md`, `graph-report.md`, `*.json`, `graph-measurements.jsonl` | relatórios brutos e medições |
