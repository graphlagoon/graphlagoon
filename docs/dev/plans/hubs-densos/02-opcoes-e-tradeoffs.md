# 02 · Opções e trade-offs, caso a caso

> Cada seção responde: que pergunta do investigador a opção atende, o que ela esconde ou distorce, quanto custa no código de hoje, e o veredito.
> As lacunas L1…L18 estão em [00-diagnostico.md](00-diagnostico.md); as fontes [n], em [01-referencias.md](01-referencias.md).
>
> **Revisto em [05](05-estrategias-de-visualizacao.md).** Este documento parte da coleção (um cluster) como núcleo. O 05 mostra que o arranjo das folhas, as arestas implícitas e o revelar por zoom não precisam de cluster, e reverte dois vereditos daqui: 4D (revelar por zoom com ocultação) passa a viável, dependendo da decisão D7; 2D (empacotar) passa a ser a primeira entrega, sem cluster. Onde houver conflito, vale o 05.

## As sete famílias, julgadas para este produto

| Família | Responde bem | Esconde ou distorce | Custo aqui | Veredito |
|---|---|---|---|---|
| **(a) Limitar na consulta** (expansão seletiva, páginas) | "Traga alguns, ou só os deste tipo" | O resto. Dado parcial engana se a tela não disser "N de M" | Médio: falta contagem no backend (L11) e a UI (L10) | **Fazer**, com "N de M" sempre visível |
| **(b) Agrupar folhas em meta-nó que abre** (coleção) | "Que tipos de vizinho há, e quantos de cada" | A identidade individual, até abrir | **Baixo: o meta-nó já existe** (clusters fechados) | **Fazer primeiro.** É o núcleo |
| **(c) Fusão por equivalência estrutural** (leque, conector) | Visão geral; achar o vizinho que *não* é sem graça | Comparar número de vizinhos fica pior [3] | Baixo para leque (grau 1); médio para conector (hash do conjunto de vizinhos) | Leque **já é o critério de (b)**; conector fica para depois |
| **(d) Zoom semântico / DOI** | "O que importa nesta escala" | Itens de nota baixa somem **em silêncio** | Alto se trocar dados com o zoom; baixo se for só geométrico | **Só a forma geométrica** (ver caso 4) |
| **(e) Só layout** (anéis, empacotar em disco) | Proporção entre grupos; mantém todo nó na tela | Nada, mas rótulos ainda colidem e não passa de alguns milhares | Médio | **Fazer** como estado "empacotado" e sub-anéis do ego |
| **(f) Vista de lista** (membros, vizinhos por tipo) | Consultar, ordenar, "qual destes 2000 é sancionado" | A topologia entre os vizinhos | Baixo: o modal de cluster já lista membros | **Fazer** junto com (b) |
| **(g) Filtrar por importância** (grau, podar folhas) | "Só os conectados" | Tudo abaixo do corte | Baixo | **Não fazer.** Já vetado: em fraude, a folha pode ser o achado |

## Caso 1 · Chegada: o hub tem centenas de vizinhos que ainda não foram carregados

Hoje: *Expand neighbors* pede profundidade 1 e 100 arestas. O SQL não ordena e o limite conta também arestas entre vizinhos, então chegam 100 arestas arbitrárias e os nós que elas tocam. Nada avisa que houve corte.

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| 1A. Só avisar o corte ("100 de ?") | Uma linha de UI; honesto | Não diz quantos faltam nem deixa escolher | Mínimo obrigatório |
| 1B. Contagem antes de expandir + diálogo seletivo acima de um limiar (Linkurious: 50) | O usuário escolhe por tipo e direção; nunca recebe um corte às cegas | Endpoint novo em três tipos de fonte (SQL, Neptune, REST); um `GROUP BY` na tabela de arestas por expansão grande | **Recomendada** |
| 1C. Páginas ("carregar mais 100") | Simples de entender | Exige ordem determinística; ordenar uma tabela grande custa; a ordem por id não tem significado | Só dentro do diálogo de 1B |
| 1D. "Mais conectados primeiro" | Traz os vizinhos estruturalmente interessantes | Precisa do grau de cada vizinho na base (subconsulta cara); enviesa para outros hubs | Adiar; medir custo antes |
| 1E. Coleção preguiçosa: o servidor devolve só "114 × Sócio" e os membros vêm ao abrir | Escala para hubs de 50 mil vizinhos | Muda o modelo: hoje todo cluster referencia `node_ids` carregados; toca backend, MCP e exportação | Adiar. Vale quando o hub típico passar de ~5 mil |

Ponto que não é opcional: corrigir a semântica do limite em profundidade 1 (primeiro as arestas do próprio nó, em ordem estável; arestas entre vizinhos depois, se couberem).

## Caso 2 · Force layout com a estrela já carregada

Hoje: disco de folhas esmaecidas; os vizinhos com outro vínculo escapam do disco. Ver capturas 1, 2 e 10.

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| 2A. Coleções de folhas por (hub, tipo de aresta, tipo de nó[, propriedade]), fechadas, com contagem | 1507 nós viram ~95 objetos (captura 11). Destaca exatamente os sócios com outro vínculo. Melhor evidência experimental [3] | Membro some até abrir; comparar tamanhos exige ler o número; se o grupo incluir quem tem outro vínculo, a aresta remapeada mente | **Recomendada**, só com folhas |
| 2B. Um saco único por hub (*Orphan Clusters* de hoje) | Já existe | Mistura PF, PJ e papéis: falha em "o agregado diz o que contém" [10] | Substituir por 2A |
| 2C. Agrupar **todos** os vizinhos por tipo, inclusive os que têm outros vínculos | Redução máxima | Arestas cruzando a fronteira do grupo derrubam o acerto (66% contra 85%) [4]; a aresta "holding → coleção" não diz qual membro | **Não** |
| 2D. Empacotar as folhas em discos em volta do hub, sem trocar nós (estado "empacotado") | Nada é substituído; área do disco é proporcional à contagem; aproximar revela cada membro; colorir por propriedade mostra o ponto fora da curva | Não reduz o número de objetos; custo de render igual ao de hoje; posição fixa das folhas | **Recomendada** como segundo estado da coleção |
| 2E. Forças por grau (carga, distância e colisão diferentes para folha e hub) | Sem conceito novo | Sem evidência de que resolva estrela de mil folhas; mais três botões | Só o mínimo: raio de colisão do nó de coleção |
| 2F. Fisheye / lente | Detalhe local sem perder contexto | Distorce distância; picking em 3D; já rejeitada | Não |

**Por que só folhas.** Maltego, GraphXR e o glifo de leque de Dunne coletam só nós equivalentes. Um membro com um segundo vínculo é justamente o que o investigador quer ver solto. E "folha" aqui quer dizer **folha no grafo carregado**: o sócio pode ter 50 empresas na base que ainda não vieram. O rótulo da coleção não pode dizer "sem outros vínculos"; no máximo "sem outros vínculos carregados" (ver decisão D5 no [README](README.md)).

## Caso 3 · Ego layout (anéis determinísticos)

Hoje: anel de raio ≈ 1240 com 300 nós; cluster flutua fora do anel. Capturas 8 e 9. Análise completa em [ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md), que este pacote incorpora.

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| 3A. Ego enxerga clusters: a coleção fechada é um nó do anel 1 | ~10 linhas; corrige o bug da captura 9; 300 nós viram ~23 no anel | Foco engolido por coleção precisa de aviso | **Fazer primeiro** (era a fase B1) |
| 3B. Sub-anéis concêntricos para anel lotado | Raio cresce com √N em vez de N; ângulos não mudam; puro e testável | Faixas podem ser lidas como saltos extras; muda explorações antigas | **Fazer** (era a fase A) |
| 3C. Ordenar o anel por propriedade | Já existe | Só agrupa visualmente | Sugerir no aviso de anel lotado |
| 3D. Coleção empacotada no ego = setor contíguo com sub-anéis | Mesma ideia do caso 2D sem conceito novo: 3B + ordenação pela chave da coleção | Depende de 3B | Consequência de 3B; sem código próprio |

## Caso 4 · Zoom que revela

O pedido: aproximar libera mais nós. Há três formas de fazer, com custos muito diferentes.

| Opção | Como funciona | Prós | Contras | Veredito |
|---|---|---|---|---|
| 4A. Zoom só de rótulos (existe) + rótulo de coleção e de hub sempre visíveis | Coleções entram no conjunto "forçado" do LOD de rótulos, como seleção e hover | Barato; a contagem aparece no zoom de encaixe | Não revela nós | **Fazer já** |
| 4B. **Zoom geométrico sobre coleção empacotada** | Os membros estão na cena, juntos e pequenos, sob um contorno com nome e contagem. Aproximar os aumenta; o LOD de rótulos que já existe passa a nomeá-los | Nenhum dado muda com o zoom: sem reconstrução, sem reaquecer layout, sem piscar. Nada escondido. Funciona igual em captura e em exploração salva | Todos os membros continuam sendo desenhados; depende do caso 2D | **Recomendada**: é a resposta ao "zoom libera mais nós" |
| 4C. Abrir e fechar coleções automaticamente pelo zoom | Gatilho por raio em tela com histerese, no gancho de câmera parada | É o que se imagina ao ouvir "zoom semântico" | Cada troca muda a contagem de nós, e isso reconstrói a cena inteira (`graphData()` é síncrono) e mexe o layout enquanto o usuário navega. Em 3D não há nível de zoom estável. O estado salvo fica ambíguo (aberta ou fechada?). Quebra o determinismo do ego | **Não na primeira versão.** Experimento com critério de saída (fase 6) |
| 4D. Revelar por nota (DOI): com o zoom, aparecem primeiro os k membros "mais interessantes" | Orçamento de entidades [2][10] | Esconde em silêncio os de nota baixa; dentro de uma coleção de folhas, todas têm a mesma nota estrutural | Não |

## Caso 5 · 3D

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| 5A. Coleção fechada em 3D | Funciona hoje | Rótulo billboard colide mais | Vale como está |
| 5B. Coleção empacotada em 3D como disco orientado ou casca de esfera | Paridade com 2D | Esfera esconde a metade de trás; disco precisa de um plano; mais um caminho de código | Adiar. Em 3D a coleção oferece fechada e aberta |
| 5C. Ao empacotar, sugerir 2D | Honesto com a evidência: 3D sem estéreo não ajuda em tarefas de caminho [43] | Troca de modo | Fazer: os layouts estáticos já mudam para 2D sozinhos |

## Caso 6 · Listas

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| 6A. Resumo de vizinhos no painel do nó: uma linha por (tipo de aresta, direção, tipo de nó) com contagem e ações "agrupar", "mostrar só", "selecionar" | É a porta de entrada das coleções; padrão Graphileon; só usa dado já carregado | Mais uma seção num painel já cheio | **Fazer** |
| 6B. Modal de membros (existe) com "tirar da coleção" por linha e seleção sincronizada | Padrão Maltego; quase tudo pronto | — | **Fazer** |
| 6C. Histogramas e facetas | Bom para atributos numéricos | Componente novo, sem irmão no código | Fora de escopo |
| 6D. Matriz | Ganha em grafos densos [24] | Uma estrela não é densa; matriz foi a mais difícil de entender em redes ego [23] | Não |

## Bifurcações de desenho

### Onde mora a regra de agrupamento

| | Programa de cluster embutido (JS no worker) | Utilitário nativo (`utils/hubCollections.ts`) |
|---|---|---|
| Custo de execução | 0,35 s (300 folhas) a 2,3 s (1500): clona o grafo para o worker | Milissegundos; O(arestas), usa `adjacencyList` e `nodeDegrees` que já existem |
| Reexecutar a cada expansão | Caro e assíncrono | Barato e síncrono |
| Teste | Só por integração | Unitário, puro |
| Editável pelo usuário | Sim | Não (parâmetros apenas) |
| Persistência | Já resolvida | Entra no dict livre `ExplorationState.clusters` |

**Escolha: utilitário nativo** para a ação embutida, produzindo `Cluster[]` comuns (mesmo render, mesmo modal, mesma persistência). O caminho de programa continua valendo para agrupamentos sob medida; o programa da sonda vira exemplo na documentação.

### O que dispara

| | Prós | Contras |
|---|---|---|
| Automático acima de um limiar (Maltego) | Zero cliques | Troca a tela sem o usuário pedir; contraria "nada em silêncio"; surpreende ao reagrupar |
| **Sugerido** (aviso com um botão) | O usuário decide; o aviso ensina que a ação existe | Um clique |
| Só manual (GraphXR) | Simples | Ninguém descobre |

**Escolha: sugerido**, com um behavior de contexto para quem quiser automático (padrão desligado). Depende da decisão D1.

### Regra viva ou foto

Se a coleção for uma foto dos ids no momento do clique, uma expansão posterior pode dar um segundo vínculo a um membro e ele continuaria dentro da coleção. **A coleção tem de ser regra reavaliada** quando os dados mudam, como já são as regras de "mostrar só" (`utils/isolation.ts`). Consequências: ids estáveis (para o estado aberto/fechado sobreviver à reavaliação) e uma lista de exceções (membros que o usuário tirou não voltam).

### Estados de uma coleção

| Estado | Na tela | Quando usar |
|---|---|---|
| **Fechada** | Um nó com nome e contagem; uma aresta agregada até o hub | Visão geral; relatório; hubs de milhares |
| **Empacotada** | Membros reais, juntos num disco sob um contorno rotulado | Ver todos; achar o diferente por cor; zoom que revela |
| **Aberta** | Membros soltos no layout, como hoje | Trabalhar com os membros individualmente |

"Empacotada" é um arranjo de coleção aberta (precedente: arranjos de combo aberto do KeyLines [31]), não um terceiro valor de `state`.

## O que fica de fora, e por quê

- Edge bundling, esmaecer por densidade, filtro por grau: vetados no `decision_log`.
- Fisheye e lentes: distorcem distância, quebram comparabilidade.
- Clusters aninhados: o modelo é N:M plano; nenhum caso acima precisa.
- Matriz, histogramas, facetas: sem irmão no código e fora da pergunta.
- *Power graphs* e decomposição modular: ganho real só em grafos densos; uma estrela não é.
- Auto abrir/fechar por zoom (4C) e coleção preguiçosa no servidor (1E): experimentos, não compromissos.
