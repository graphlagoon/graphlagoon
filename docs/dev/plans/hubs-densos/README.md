# Hubs densos: um nó com centenas de vizinhos diretos

> Status: **proposta** (nada implementado). Análise de 2026-11-13, branch `feature/context-look-clusters`.
> Pasta fora do site VitePress (`srcExclude: dev/**`).
> Incorpora e amplia [ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md) (2026-08-28), que tratava só do layout ego e não foi implementado.

## O problema

Num grafo egocêntrico em que um nó se liga direto a centenas de outros (o quadro societário de uma empresa grande), a tela vira um disco de pontos, mesmo com force layout. O investigador quer saber três coisas e a tela não responde nenhuma:

1. Quantos vizinhos são, e de que tipo e papel.
2. Quais deles têm **outro** vínculo (quase sempre o alvo).
3. Quem é um vizinho específico, sem perder o conjunto de vista.

## A resposta em uma frase

Vizinhos que só se ligam ao hub viram **coleções** com nome e contagem, que se abrem com um clique ou se revelam com o zoom; quem tem outro vínculo fica solto. O meta-nó necessário já existe no produto (clusters fechados); o que falta é a regra centrada no hub, a apresentação e a integração com expansão, ego e zoom.

## O que a sonda mostrou

| Hoje | Com coleções (protótipo, sem mudar o código do app) |
|---|---|
| ![1507 nós, force](screens/10-force-1500.png) | ![1507 nós, 11 coleções](screens/11-force-1500-colecoes.png) |
| 1507 nós: disco de ~1420 folhas esmaecidas, sem nome nem contagem | Os mesmos dados: 11 coleções nomeadas + 75 sócios com outro vínculo + 6 holdings |

O protótipo também expôs o que falta para isso ser produto: sem rótulo no zoom de encaixe, tamanho que satura, leque de arestas paralelas, coleção aberta sem rastro, e tudo se perde ao expandir um nó. Detalhe em [00-diagnostico.md](00-diagnostico.md).

## Resposta por caso

| Caso | Resposta recomendada | Fase |
|---|---|---|
| **Chegada**: o hub ainda não foi carregado | Contar vizinhos por tipo antes de carregar; acima de 50, diálogo de expansão seletiva; selo "carregados N de M" | F0.5, F3 |
| **Force layout** com a estrela carregada | Coleções de folhas por (tipo de vínculo, direção, tipo de nó), fechadas, com contagem e uma aresta somada | F0, F1 |
| **Ego layout** | Coleção fechada vira um nó do anel; anel lotado se quebra em sub-anéis | F0.1, F4 |
| **Zoom que revela** | Coleção *empacotada*: membros reais num disco rotulado; aproximar os nomeia. Os dados não mudam com o zoom | F0.4, F5 |
| **Colapsar e explodir** | Fechada ↔ aberta pelo menu, sem mover nenhum outro nó; tirar um membro pela lista | F1 |
| **3D** | Fechada e aberta funcionam; empacotada só em 2D | F5 |
| **Consultar a lista** | Resumo de vizinhos no painel do nó; modal de membros com "tirar" | F2 |

Rejeitado, com motivo em [02](02-opcoes-e-tradeoffs.md): filtrar por grau, edge bundling, esmaecer por densidade, fisheye, agrupar vizinhos que têm outros vínculos, e abrir/fechar sozinho pelo zoom (este último fica como experimento).

## Ordem de leitura

| # | Arquivo | Para quê |
|---|---|---|
| 1 | Este README | Problema, resposta, decisões em aberto |
| 2 | [00-diagnostico.md](00-diagnostico.md) | O que a tela faz hoje (11 capturas), o que já existe no código, 16 lacunas, restrições de produto |
| 3 | [01-referencias.md](01-referencias.md) | Literatura com resultados medidos; o que Maltego, GraphXR, Linkurious, KeyLines e outros entregam |
| 4 | [02-opcoes-e-tradeoffs.md](02-opcoes-e-tradeoffs.md) | Opções por caso, com o que cada uma esconde e quanto custa aqui |
| 5 | [03-design.md](03-design.md) | Modelo, regra, estados, aparência, interação, API de contagem |
| 6 | [04-plano-de-implementacao.md](04-plano-de-implementacao.md) | Fases F0 a F6 com critérios de aceitação, arquivos, verificações, portões e riscos |
| — | [screens/](screens/) | Capturas da sonda |
| — | [../ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md) | Especificação dos sub-anéis do ego (fase F4) |

## Decisões em aberto

Cada uma tem recomendação; o plano segue a recomendação até alguém decidir o contrário.

| # | Decisão | Opções | Recomendação | Trava |
|---|---|---|---|---|
| D1 | O que dispara o agrupamento | (a) aviso com botão; (b) automático acima do limiar, por contexto; (c) só manual | **(a)**, com (b) disponível como behavior de contexto, desligado por padrão. Automático troca a tela sem pedido | F1 |
| D2 | Clique numa coleção fechada | (a) manter: abre o modal de membros; (b) clique seleciona, duplo clique abre e fecha (KeyLines, Linkurious) | **(a) em F1**; reavaliar (b) com o `ux-reviewer` depois de F2. Trocar agora muda um gesto que os usuários de clusters já conhecem | F1 |
| D3 | Construir o estado empacotado | (a) sim, depois de F1; (b) não, ficar em fechada + lista + sub-anéis | **Decidir com protótipo** (uma tarde). É a única resposta ao "zoom libera mais nós" que não troca dados com o zoom | F5 |
| D4 | Agrupar também por propriedade (papel do sócio) | (a) só tipo de vínculo e de nó; (b) propriedade escolhida no painel de vizinhos; (c) propriedade padrão por contexto | **(a) em F1, (b) em F2.** No protótipo, a propriedade foi o que deu significado aos grupos | F2 |
| D5 | O que a coleção afirma | (a) "ligados só ao hub **entre os nós carregados**"; (b) consultar o grau real de cada membro na base | **(a) agora**; (b) como experimento de F6. Um membro-folha pode ter dezenas de vínculos que ainda não vieram | F1 |
| D6 | Limiares iniciais | hub = grau > 30; coleção ≥ 5 membros; diálogo de expansão > 50 arestas | Começar com esses e calibrar olhando a tela com dado real | F1, F3 |

## Regras de trabalho

- Nada de dado escondido em silêncio. Toda agregação mostra contagem e pode ser aberta. (`decision_log`, 2026-07-20.)
- Coleção é um `Cluster`. Não criar um segundo conceito de grupo.
- O determinismo do ego layout é requisito.
- Cada fase termina com `verify.sh`, capturas com a fixture do anexo do [04](04-plano-de-implementacao.md) e uma entrada no `decision_log`.
- Números de linha citados são de `0cf9d78`; reencontrar pelo nome da função.
