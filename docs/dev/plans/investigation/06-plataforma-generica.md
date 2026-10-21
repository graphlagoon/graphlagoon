# 06 · Plataforma de investigação genérica e AI-first

> Status: **aprovado em 2026-10-19**. Supera o [05-plano-v2.md](05-plano-v2.md) §7 (compliance no fluxo)
> e §9 ("compliance BR fica no núcleo"); o resto do 05 (itens, anotações, diário, agente com a identidade
> da pessoa) continua valendo. Progresso: seção "Progresso" no fim deste arquivo e o decision log.

## Contexto

As fases F0–F6 do plano v2 construíram o caso de investigação com PLD/fraude
brasileira cravada no núcleo. O 05 §9 chega a dizer "compliance BR fica no núcleo".
Exemplos confirmados no código:

- **Decisão:** `outcome: Literal[comunicar|arquivar|medida|parecer]` e
  `actions: Literal[dict|spa|bloqueio_cautelar]` (`api/graphlagoon/models/schemas.py:1874-1875`).
  Os rótulos COAF/Siscoaf/DICT/SPA estão em `frontend/src/utils/investigationStatus.ts:43-54`.
  É uma decisão por caso, ela é terminal e congela tudo.
- **"Tipo" = `kind_preset`:** enum fixo de 7 valores, definido em 4 lugares (TS, Pydantic,
  `cases.py:132`, seeds). Só quem edita código cria um tipo.
- **No núcleo:** tipologias CC 4.001 (TS e Python gêmeos), import SIMBA/QSA, exports
  SIMBA/Siscoaf, máscara por regex de CPF/CNPJ, ER por miolo de CPF, normalizadores
  Pix/CPF/+55, parse de número `1.234,56`, `BRL` padrão, prazos 45+45, citações de lei,
  papéis "vítima/mula" com cor fixa, cerca de 80 strings pt-BR inline.
- **O que já é genérico e fica:** itens com versões e sha256, fixar = evidência, anotações
  sugerido→confirmado, diário append-only, agente com a identidade da pessoa, ferramentas
  MCP 1:1 com as rotas humanas, grafo unificado por chaves de identidade, paths, links por
  atributo compartilhado, comunidades, rastreio de fluxo FIFO/LIFO/proporcional/LIBR.

**Decisões do usuário (2026-10-19):**
1. O que é Brasil/PLD sai do código. O caso de uso brasileiro precisa ser *configurável
   como dado*: tipo de caso, catálogo de decisões, templates.
2. Uma investigação tem **várias decisões**, com catálogo **configurável**, **alvos por
   entidade** e **quatro olhos** opcional por resultado.
3. **O admin define os tipos de caso.** Existe sempre o tipo "General", sem regras.
4. A UI fica em **inglês**. Rótulos de domínio vêm dos dados.
5. **A máscara de dados para agentes sai inteira.** A minimização fica nas colunas
   expostas pelo context, nos shares e nos tokens com escopo de caso. O envelope
   `untrusted_data` fica, como proteção contra prompt injection.
6. **A ER é generalizada.** A chave de bloqueio é qualquer chave de identidade; não há
   mais nada de CPF.
7. **"Entidade vista em outros casos" entra no escopo** como a fase P7.

O branch `feature/investigations` não foi para a `main` e a migração
`alembic/versions/016_cases.py` só existe nele. Por isso a migração é editada no lugar,
sem migração nova.

---

## 1. Conceitos novos (o núcleo genérico)

### Tipo de caso (substitui `kind_preset` e `org_vocabularies`)

A tabela `org_vocabularies` vira `case_types(slug PK, spec JSON, updated_at)`. O serviço
`services/case_types.py` substitui `org_vocabularies.py` e segue o mesmo padrão seed/stored.
`general` é uma constante de código, read-only.

```
spec = {
  label, description?,
  vocabularies: {roles[], tags[], link_attributes[]},
  outcomes: [{id, label, description?, closes_case, requires_review}],
  actions:  [{id, label, due_hours?}],          # viram tarefas
  stages?:  [label],                             # etapas livres, sem semântica
  fields?:  [{id, label, type, options?, required?, in_queue?}],  # campos do caso
  sla_hours?: {open?, analysis?},                # substitui investigation_deadline_days
  retention_years?,                              # sobrepõe o global
  notice?,                                       # aviso de sigilo (ex.: tipping-off)
  agent_suggest_kinds?, playbook?,               # slug da org_library
  starter_queries?: [{title, language, query}],  # viram itens query no caso criado
  report_templates?: [slug],                     # docs kind=template da org_library
}
```

- O que é **copiado ao criar o caso** (mecanismo atual, `cases.py:584`): vocabulários,
  suggest kinds, prazos e consultas iniciais. Depois disso o caso é editável.
- O que é **lido ao vivo:** rótulo, catálogo, aviso, playbook, templates.
- Erros: tipo em uso → 409 `CASE_TYPE_IN_USE`; tipo desconhecido → 422.
- Admin: superusuário em `PUT/DELETE /api/admin/case-types/{slug}`, auditado
  `case_type.write|delete`. Leitura: `GET /api/org/case-types`.

### Decisões (várias, configuráveis)

`investigations.decision/frozen_hash/frozen_at` → `decisions JSON []`, append-only e só
humano. Rota `POST /{id}/decisions`.

```
{id, outcome|null, outcome_label, closes_case, targets[]?, task_ids[], rationale,
 evidence[{item_id, version, sha256}], reviewer_email?, review: pending|approved|null,
 decided_by, decided_at, hash}
```

- Cada decisão faz um snapshot de `outcome_label` e `closes_case`. Editar o catálogo depois
  não reescreve o histórico.
- **Tipo sem catálogo** (General): resultado em texto livre, mais a caixa "encerra o caso".
- **`targets`:** decisão sobre entidades. Exemplos: aprovar o limite da empresa A e negar o
  da B; bloquear a conta X e monitorar a Y.
- **`requires_review`** (quatro olhos): a decisão fica `pending` até outra pessoa aprovar
  (`POST /decisions/{id}/review`, humano ≠ autor). Só então ela encerra o caso.
- **Hash por decisão:** sha256 do prefixo do diário até o `decision.recorded` dela. Isso
  corrige o bug de `cases.py:781`, que corta o diário na primeira decisão.

### Status e ciclo de vida

- Status: `open | analysis | closed`. `archived` sai, e com ele a armadilha
  arquivado-depois-de-decidido.
- O caso só fecha por uma decisão com `closes_case`. "Arquivar com motivo" vira um
  resultado de catálogo, ou texto livre no General.
- Caso `closed` = congelado (409). `POST /reopen` é só humano e volta para `analysis`; as
  decisões ficam.
- `stage` é um campo livre e opcional, escolhido entre os `stages` do tipo. Serve para
  etapas como "aguardando cliente" ou "escalado" sem criar uma máquina de estados.

### Tarefas (as ações da decisão viram tarefas; pessoas e agentes coordenam)

São um novo kind de anotação, `task`. Reusam sugerido/confirmado, diário, PATCH e contadores.

```
value = {title, state: open|done|cancelled, assignee_kind: human|agent,
         assignee?: email, agent_name?, due_at?: datetime, action?, decision_id?}
```

- O prazo é em datetime, para casos como "notificar em 24 h". `due_hours` vem da ação do
  catálogo.
- `agent_name` casa com o nome do token, então vários agentes da mesma pessoa podem
  receber trabalho. O agente acha o que é dele com `list_tasks(mine)` e `changes_since`.
- Tarefas ficam **fora do congelamento**: dá para concluir o follow-up depois de fechar.
  Também ficam fora do hash, como os shares hoje.
- O agente cria tarefas `suggested`. A pessoa confirma.

### Extensão por dados (o que substitui o código de domínio)

| Antes (código) | Depois (dado da org) |
|---|---|
| Tipologias CC 4.001 (TS e Python) | `starter_queries` do tipo de caso e templates de consulta. Resultado = item, que o agente roda com `run_query` |
| Presets SIMBA/QSA | **Templates de mapeamento:** a doc `kind=mapping` na org_library, salva pelo próprio wizard ("salvar este mapeamento para a org") |
| Exports SIMBA/Siscoaf, laudo | **Templates de relatório** (`kind=template`, hoje sem uso) com placeholders do caso. O humano ou o agente gera um item `document/markdown` com status `suggested` para aprovação, e imprime |
| Máscara por regex de CPF/CNPJ | **Nada.** Sai `services/masking.py`, o `agent_view` (26 pontos em `routers/investigations.py` e `routers/explorations.py`), o MCP `_out`/`MASKED`, a máscara do `resolve_uid` (vira só um teste de existência), os `secrets` do `case_graph.py:233-236`, a coluna e o checkbox `agent_tokens.unmasked`, `agents_allow_unmasked_data` (config, `auth.py:328`, `CONFIG_FIELD_KINDS`), o chip do olho (`caseFilters.unmasked`) e `maskDocument`/`hiddenRawDocumentKeys` |
| ER por miolo de CPF | **ER genérica:** a chave de bloqueio é qualquer chave de identidade, mais similaridade de nome (Jaro-Winkler já existe), sem stopwords pt. O resultado são sugestões `same_as` |
| Normalizadores cpf_cnpj, pix_key, +55, endereço pt | `phone` = só dígitos, `address` = minúsculas sem acento; o resto via `regex` |
| Parse `1.234,56`, `dd/mm/yyyy`, BRL | Número/data neutros; `decimal_comma` como opção explícita no mapeamento; moeda opcional por context |

---

## 2. Teste de estresse: cenários de crédito e fraude

Pergunta para cada cenário: o plano consegue rodá-lo **só com configuração** (tipo de caso,
templates, contexts)?

| # | Cenário | Grafo / análise | Decisão e ações | Coberto? | Falta → resposta no plano |
|---|---|---|---|---|---|
| 1 | **BR · golpe Pix com MED** | contas↔Pix, rastreio FIFO em camadas, saídas | "Comunicar ao COAF" (fecha) · tarefas "marcar no DICT" (24 h), "devolução MED" | sim | prazo em horas → `sla_hours` e `due_at` datetime; SIMBA → template de mapeamento; Siscoaf → template de relatório |
| 2 | **BR · grupo econômico para limite de crédito** | QSA: sócios↔empresas, links por sócio, grupos | resultado **por empresa** (aprovar/reduzir/negar) | parcial | decisão com `targets`; exposição somada do grupo → `starter_query`. Soma por grupo na UI = fora do escopo |
| 3 | **BR · fuga de garantia / duplicata fria** | recebível↔credores, links por id do título | "executar garantia" + tarefa "notificar registradora" | sim | — |
| 4 | **EUA · identidade sintética (crédito)** | pedidos↔SSN/telefone/device/endereço, links, ER | "negar e reportar ao bureau" | sim | ER genérica (não a do CPF); o mesmo SSN em pedidos antigos → P7 |
| 5 | **EUA/EU · AML com SAR em 30 dias** | rastreio, contrapartes, sanções como enriquecimento | "File SAR" (fecha, **quatro olhos**) / "No SAR" | sim | `requires_review`; prazo 30 d; aviso de tipping-off por tipo; narrativa SAR = template + rascunho do agente |
| 6 | **UK · APP fraud / reembolso PSR** | vítima→mulas, rastreio | "reembolsar" + tarefa "recuperar da instituição receptora" | sim | SLA em dias úteis = limite conhecido (aceito) |
| 7 | **Adquirência global · lojista conivente** | lojistas↔cartões↔terminais, comunidades | "descredenciar" + tarefa "incluir na MATCH" | sim | — |
| 8 | **EU · UBO / propriedade efetiva > 25%** | cadeia de participação com % | "EDD" / "recusar onboarding" | parcial | multiplicar % ao longo do caminho não é rastreio temporal → `starter_query` Cypher/SQL; motor dedicado fora do escopo |
| 9 | **Seguro · anel de sinistros** | segurados↔oficinas↔médicos, telefones | "negar" / "encaminhar ao SIU" | sim | — |
| 10 | **Cripto · rastreio on-chain** | UTXO grandes, LIBR | "congelar via exchange" | sim | multimoeda/FX não existe (limite documentado) |
| 11 | **Interno · vazamento de dados** | acessos↔sistemas, linha do tempo | "disciplinar" / "jurídico" / "improcedente" + "revogar acesso" | sim | sem dinheiro: o rastreio não se aplica, o resto sim |
| 12 | **Triagem AI-first em volume** | sistema de alertas abre casos via API/MCP; agente de triagem roda o playbook | agente sugere tarefas e status; humano decide | sim | vários agentes por pessoa → `agent_name` na tarefa |

| 13 | **Anel recorrente (qualquer país)** | a mesma conta/telefone/device aparece em vários casos | "escalar como anel" + tarefa "unir investigação" | sim | **P7**: o inspector mostra "seen in N other cases" |
| 14 | **Grupo de crédito revisitado** | empresa revisada ano passado volta noutro pedido | consultar a decisão anterior antes de decidir | sim | P7 retorna os casos com as decisões que tiveram a entidade como alvo |

**Conclusão:** com as adições abaixo, os 14 cenários rodam sem código de domínio:
- na decisão: `targets` e `requires_review`;
- nas tarefas: prazo em datetime e agente nomeado;
- `sla_hours`;
- templates de mapeamento e de relatório;
- ER genérica;
- busca entre casos (P7).

Sem máscara, minimizar dado sensível exposto a agentes é trabalho do context: quais
colunas ele expõe e quais tokens têm escopo de caso. A guia diz isso de forma explícita.

**Fora do escopo, documentado como limite:**
- multimoeda/FX;
- propriedade efetiva multiplicativa;
- SLA em dias úteis;
- fusão de casos.

---

## 2b. Teste de estresse: adquirência (maquininha, tipo Getnet, Stone, Cielo, Adyen)

As entidades típicas são: estabelecimento (EC), sócios, terminal (número de série),
domicílio bancário, MCC, cartão (PAN tokenizado/BIN), transação, chargeback, agenda de
recebíveis/antecipação, vendedor/ISO e subcredenciado (PayFac).

| # | Cenário | Plano cobre? | Como / o que falta |
|---|---|---|---|
| AQ1 | **Credenciamento fraudulento** (EC de fachada, sócio laranja, dados repetidos de EC descredenciado) | sim | links por telefone/e-mail/conta/endereço; **P7** acha o sócio ou a conta em casos antigos; lista interna de descredenciados (ou MATCH) como tabela de enriquecimento |
| AQ2 | **Bust-out / EC conivente** (pico de volume, antecipação, some, chargebacks) | parcial | grafo e decisão ok: "reter agenda" e "descredenciar" como tarefas, com quatro olhos. **Falta ver série temporal** (volume e taxa de chargeback por dia): as `starter_queries` geram a tabela, mas não há gráfico |
| AQ3 | **Transaction laundering** (EC de fachada processa aposta ilegal; MCC não bate) | parcial | terminal↔EC↔conta e links ok. Geolocalização (terminal longe do endereço) só por consulta; **não há mapa** |
| AQ4 | **Maquininha emprestada / terminal clonado** (o mesmo terminal em vários ECs) | sim | links por número de série, comunidades, ER genérica |
| AQ5 | **Vendedor/ISO conivente** (um vendedor credencia vários ECs falsos) | sim | comunidades, grupos, P7 |
| AQ6 | **Duplicidade de cessão de recebíveis** (agenda cedida a dois bancos via registradora) | sim | enriquecimento da registradora; links por id da UR; decisão com `targets` |
| AQ7 | **Programas das bandeiras** (VAMP/VDMP, ECM/EFM: EC acima do limite → plano de remediação) | sim | tipo de caso com SLA, tarefas com prazo e decisão "remediar / descredenciar" |
| AQ8 | **Disputa de chargeback em volume** (milhares por dia, prazo da bandeira, documentos) | **não, hoje** | um caso por disputa via API com `external_ref` (P2) funciona, mas **a fila carrega todos os casos sem paginação** (`services/cases.py:501`, sem `limit`/`offset`) e não há ação em lote |
| AQ9 | **Card testing / BIN attack** (e-commerce: muitas autorizações pequenas por IP/device) | sim, com ressalva | links cartão↔IP↔EC e comunidades no servidor via MCP; o teto do grafo no browser (Q5) limita a visão |
| AQ10 | **Conta de pagamento do EC recebendo Pix de golpe** | sim | rastreio de fluxo e o tipo de caso configurado (cenário 1) |

**Veredito:** a plataforma se adapta bem ao que é **investigação sobre EC, terminal,
sócios e vendedores**, que é o centro da prevenção a fraude numa adquirente: AQ1, AQ4,
AQ5, AQ6, AQ7 e AQ10. Fica fraca em três frentes, e duas entram neste plano:

1. **Fila em volume** (AQ8): paginação e filtros no servidor em `GET /api/investigations`
   (`limit/offset/sort`, filtros por `case_type`, `status`, `stage`, `assignee`,
   `external_ref` e prazo vencendo), e a `InvestigationsView` paginada. Entra na **P2**. A
   ação em lote (decidir N casos de uma vez) vai para o plano 07, junto com a triagem por
   agente (A3).
2. **Série temporal de uma tabela** (AQ2): item `table` com "ver como gráfico" (linha ou
   barra, eixo X e série escolhidos da tabela), feito como componente SVG simples, sem
   biblioteca nova. A configuração fica no item, e o agente cria pelo `update_item`.
   Entra na **P5**. Até lá, o Claude Code pode gerar um PNG e anexar como documento (A7).
3. **Mapa / geolocalização** (AQ3): fora do escopo; documentado como limite.

### Vocabulário de adquirente: onde cada termo mora

| Termo | Mecanismo do plano |
|---|---|
| EC, Terminal, Sócio, Domicílio bancário, Vendedor/ISO, Subcredenciado, UR (unidade de recebível) | **tipos de nó** do context ou do mapeamento do arquivo (vêm dos dados); rótulo pelo `label_templates` do caso |
| captura, liquidação, cessão, antecipação, chargeback, "opera em" | **tipos de aresta** dos dados; `edge_semantics` diz qual coluna é valor e qual é tempo |
| EC suspeito, sócio laranja, terminal emprestado, EC beneficiário, vendedor conivente | `vocabularies.roles` do tipo de caso (vários papéis por entidade, P2) |
| bust-out, transaction laundering, MCC divergente, card testing, cessão duplicada | `vocabularies.tags` |
| domicílio bancário, telefone, e-mail, sócio, número de série, IP, endereço | `vocabularies.link_attributes` e chaves de identidade |
| TPV, ticket médio, taxa de chargeback 30 d, prazo de antecipação | `starter_queries` (tabela) + gráfico (P5) |
| Descredenciar, Manter com monitoramento, Bloquear terminal, Pedir documentos (KYC), Comunicar COAF | `outcomes` (cada um diz se `closes_case` e `requires_review`) |
| Reter agenda, Bloquear captura, Cancelar antecipação, Lista restritiva interna, Reportar MATCH/VMAS, Notificar EC, Acionar registradora | `actions` → tarefas com `due_hours` |
| Aguardando documentos do EC, Em análise da bandeira, Escalado para jurídico | `stages` |
| Laudo de descredenciamento, Carta ao EC, Resposta à bandeira (representment) | `report_templates` (org library) |
| arquivo de agenda da registradora, arquivo de chargeback da bandeira, conciliação | templates de mapeamento (P5) |

### Dois tipos de caso de exemplo (vão para o seed de dev)

```
merchant_review  "Revisão de EC"
  roles: EC suspeito, sócio laranja, terminal emprestado, vendedor conivente, EC beneficiário
  tags: bust-out, transaction laundering, MCC divergente, card testing
  fields: ec_id (texto, na fila), mcc (enum), tpv_90d (dinheiro, na fila), valor_em_risco (dinheiro, na fila)
  outcomes: Descredenciar (fecha, quatro olhos) · Manter com monitoramento (fecha)
            · Bloquear terminal (não fecha) · Comunicar COAF (fecha, quatro olhos)
  actions: Reter agenda (2 h) · Bloquear captura (2 h) · Lista restritiva · Reportar MATCH (5 d) · Notificar EC
  stages: Aguardando documentos · Escalado para jurídico
  sla_hours: open 24, analysis 120
  starter_queries: TPV e chargeback por dia · terminais com mais de 1 EC em 90 d
                   · ECs que compartilham domicílio ou sócio · ticket médio vs MCC

chargeback_dispute  "Disputa de chargeback"
  fields: reason_code (enum: 10.4, 13.1, 4837, 4853…), valor (dinheiro), bandeira (enum), prazo_bandeira (data)
  outcomes: Aceitar (fecha) · Contestar/representment (não fecha) · Pré-arbitragem (não fecha) · Ganha/perdida (fecha)
  actions: Juntar comprovante de entrega · Pedir nota ao EC (48 h)
  report_templates: representment
```

### O que o vocabulário de adquirente expôs (lacunas novas)

1. **Campos estruturados por tipo de caso.** Hoje o caso só tem título, descrição, tags e
   datas (`schemas.py:1784`). Uma adquirente precisa filtrar a fila por `valor_em_risco >
   100k` ou `reason_code = 10.4`. Crédito (limite pedido) e AML (score do alerta) têm a
   mesma necessidade.
   - **Proposta (P2):** o tipo de caso ganha `fields: [{id, label, type:
     text|number|money|date|enum, options?, required?, in_queue?}]`. Os valores ficam em
     `investigations.fields JSON`.
   - Validação pelo tipo; filtro e ordenação no servidor (enum, número, data); colunas na
     fila para os campos `in_queue`; edição no header.
   - O agente escreve pelo `update_case` e cria o caso já com os campos (`create_case`).
2. **Arquivo posicional (largura fixa).** Os EDIs de conciliação e as agendas de
   registradora costumam ser posicionais, e o parser só aceita delimitador.
   - **Proposta (P5):** a opção `widths: [n…]` no spec do mapeamento, como alternativa a
     `delimiter`, nos gêmeos `file_mapping.py`/`fileMapping.ts`. É pequena.
   - Até lá, o Claude Code converte o arquivo para CSV antes do `import_file`.
3. **Vários papéis por entidade** (EC suspeito e beneficiário ao mesmo tempo): já está na
   P2 (`case_annotations.py:135`).
4. **Idioma:** os termos de domínio aparecem em português porque vêm dos dados, mas a
   interface fica em inglês (decisão 4). Para uma adquirente brasileira, a tela mistura as
   duas línguas. O i18n pt-BR da interface entra no plano 07.

**Nota PCI** (vai para a guia na P6): sem máscara, a plataforma não pode receber PAN
aberto. O context expõe só o PAN tokenizado ou com hash, e o normalizador `card` trabalha
sobre o token. Um upload com PAN aberto coloca o Volume no escopo PCI, e a guia diz isso.

## 3. Fases (cada uma termina com a suíte verde)

Rodar em todas as fases:
- `cd api && .venv/bin/pytest tests/ -q`
- `make test-unit-frontend`
- `npx vue-tsc --noEmit`
- `make test-e2e` (no mínimo os specs de investigations, workspace, user-journeys e admin)

Cada fase ganha uma entrada no decision log, com as linhas "Public docs" e "Admin area".

**P0 · Spec (XS).** Escrever `docs/dev/plans/investigation/06-plataforma-generica.md` com
este plano (incluindo a matriz §2). Banner "superado pelo 06" no 05 §7/§9. README aponta
para o 06. Criar `07-ai-first-runtime.md` só como esqueleto, com a tabela A1/A2/A3/A6 da §3b.

**P1 · Tirar o domínio do código (L, quase só deleção).** Mexe nos gêmeos TS e Python juntos.
- **Apagar:**
  - `services/typologies.py`, `utils/typologies.ts`, `TypologyBadgesPanel.vue`, a rota
    `/analysis/typologies`, o kind `typology` e o botão no AnalysisBar;
  - `file_mapping_presets.py`, `fileMappingPresets.ts` e o branch `qsa_receita`;
  - exports `simba`/`siscoaf`;
  - normalizadores BR, `DEFAULT_STOP_TYPE`, parse BR e `BRL`;
  - `ROLE_COLORS`/`ROLE_LABELS` (`graphAppearance.ts:492-509`), substituídos pela paleta
    por hash de `roleColor()`;
  - os 6 playbooks BR, que viram 2 em inglês (`triage`, `assemble_brief`);
  - as citações de lei em `cases.py:91-93`;
  - **a máscara inteira** (lista na tabela da §1). Testes afetados: `test_agent_tokens`,
    `test_mcp_server`, `test_agent_route_scoping`, `CaseFilterChips.test`,
    `SelectionInspector.test`, os testes de `caseLabels` e `AgentTokensView`.
- **Generalizar:**
  - ER: bloqueio por chave configurável, sem CPF nem stopwords pt;
  - `entity_resolution.links` → `services/links.py`;
  - `decimal_br` → `decimal_comma`;
  - tag `dossie` → `dossier`;
  - `caseLabels.ts` passa a usar as chaves `name/title/label`.
- **Seed:** reescrever `dev/seed_investigations.py` como esqueleto genérico em inglês.
- **Testes:** atualizar fixtures `unify/`, `trace/` e `er/`, os testes gêmeos,
  `e2e/helpers/api-mocks.ts` e `screenshots/generate.ts`.

**P2 · Tipos de caso (L).**
- Migração 016 editada: `kind_preset` → `case_type`, `org_vocabularies` → `case_types`.
- `services/case_types.py`, rotas org/admin, InMemory, admin registry.
- MCP: `get_case_type` (lista quando sem slug) e o recurso `org://case-types/{slug}`
  substituem `list_vocabulary`.
- **Frontend:**
  - a aba Admin "Case types" usa o novo `components/admin/CaseTypeEditor.vue`;
  - os selects de tipo leem da API em `CaseHeader`, `CaseSettingsDrawer`
    (sai `applyPreset`) e `InvestigationsView`;
  - o aviso de sigilo do tipo aparece no ShareDialog.
- **Fila em volume (AQ8):** `GET /api/investigations` com `limit/offset/sort` e filtros
  no servidor; `InvestigationsView` paginada; contadores calculados no servidor; mocks e2e
  paginados.
- **Campos por tipo de caso:**
  - `spec.fields` e a coluna `investigations.fields JSON` (editar a 016);
  - validação no create e no PATCH;
  - filtros `field.<id>=` e `sort=field.<id>` na fila;
  - colunas `in_queue` na `InvestigationsView`, edição no `CaseHeader`, editor de campos
    no `CaseTypeEditor`;
  - `create_case`/`update_case` no MCP aceitam `fields`;
  - testes em `test_case_types.py`: tipo inválido 422, `required`, filtro e ordenação.
- **Testes:** novo `api/tests/test_case_types.py` e um teste de paginação em `test_cases.py`.
- **Seed:** cria os tipos da §2 pela API admin, mais um tipo `merchant_review`
  (adquirência) com 2 casos e um tipo `chargeback_dispute` com cerca de 300 casos
  pequenos, para exercitar a fila paginada.

**P3 · Decisões e ciclo de vida (L).**
- `decisions` JSON, statuses `open|analysis|closed`, `stage`, `targets`, `requires_review`
  com a rota de review, hash por decisão, reopen, retenção por tipo.
- Sai o caminho de arquivar sem decisão.
- Exports só `json|csv` mais relatório impresso, com verificação por decisão.
- **Frontend:**
  - `DecisionPanel.vue` reescrito a partir do catálogo, ou texto livre com "encerra o
    caso", alvos, revisor e tarefas;
  - histórico de decisões no `CaseDossier`;
  - header com Decidir/Reabrir;
  - correção do bug de `investigationEvents.ts:74`.
- **Testes de regressão em `test_cases.py`:**
  - duas decisões, a primeira não fecha o caso;
  - reabrir e decidir de novo, com os dois hashes válidos;
  - quatro olhos com o mesmo autor → 403;
  - catálogo inválido → 422;
  - agente → 403.

**P4 · Tarefas (M).**
- Kind `task` em `case_annotations.py`, com as isenções de congelamento.
- `record_decision` cria as tarefas antes do evento, para que entrem no hash.
- MCP: `add_task`, `update_task`, `list_tasks(mine)`.
- **Frontend:** novo `CaseTasksPanel.vue` (aba "Tasks" no `CaseTimeline` e card no
  dossiê), com filtros minhas / agente / atrasadas.
- **Testes:** agente cria tarefa `suggested`; agente conclui a própria tarefa; concluir
  tarefa depois de fechar o caso.

**P5 · Extensão por dados (M).**
- `starter_queries` copiadas na criação do caso.
- **Arquivo posicional:** opção `widths` no mapeamento (os dois gêmeos), com fixture de
  arquivo de largura fixa nos testes de paridade.
- **Tabela como gráfico (AQ2):** novo `components/investigation/TableChart.vue` (SVG,
  linha/barra, sem dependência). A configuração `{chart: {type, x, series[]}}` fica no
  `state` do item; o agente define pelo `update_item`. Unit test do componente.
- Org library ganha `kind=mapping` (botão "salvar mapeamento" no `FileImportWizard`/
  `MappingStep`) e passa a usar `kind=template` para relatórios: gerar um item
  `document/markdown` a partir do template, também pela ferramenta MCP `render_report`.
- **Seed:** um tipo `pix_scam` de exemplo **só no seed de dev**, com SIMBA como template
  de mapeamento e Siscoaf como template de relatório. Isso prova o cenário 1 sem código.

**P6 · Inglês e documentação (M).**
- Varrer as strings pt-BR inline: o hub `investigationStatus.ts` passa a ter rótulos em
  inglês, e entram `FAMILY_LABELS` e os rótulos do AnalysisBar
  ("Trace", "Links").
- **Critério de pronto:** um grep por `cpf|cnpj|pix|coaf|siscoaf|simba|qsa|typolog|kind_preset|dossie|BRL|mula`
  e por acentos em `frontend/src` e `api/graphlagoon` retorna vazio, exceto nos seeds de
  exemplo.
- **Documentação:**
  - reescrever `docs/guide/investigations.md` (tipos de caso, decisões, tarefas, templates,
    máscara);
  - atualizar `agents-mcp.md`, `configuration.md`, `docs/dev/admin-area.md`, `architecture.md`
    e `agent-capabilities.md`;
  - regenerar os screenshots;
  - `make docs-build`.

**P7 · Entidade vista em outros casos (M).** Vem antes da documentação final da P6; a
guia já cobre isso.
- **Por que dá:** a entidade com chave tem uid estável entre casos,
  `entity:valor_normalizado` (`services/case_graph.py:232`).
- **Duas camadas:**
  1. *Entidades de interesse*, sem tabela nova: uid nos `targets` de anotações (papel,
     tag, grupo, `same_as`, tarefa) e nas decisões.
  2. *Presença no grafo*: a tabela `case_entities(investigation_id, uid, entity, label,
     updated_at)`, regravada sempre que o servidor monta o grafo do caso (`case_graph`
     build em `get_graph` e nas análises). Tem paridade InMemory e entra em
     `CLEARABLE_TABLES`.
- **Rota:** `GET /api/investigations/entities/{uid}/cases`. Retorna `[{investigation_id,
  title, status, case_type, roles/tags, decisions que a tiveram como alvo}]`. Só traz
  casos que o usuário (ou o escopo do token) pode abrir; a existência de outros casos
  não vaza (03 §7). Não é auditada, porque é leitura.
- **MCP:** `find_entity_cases(uid)`, mapeada à rota em `mcp/registry.py`.
- **UI:** chip "Seen in N other cases" no `SelectionInspector` e na `EntityPage`, com
  link para cada caso.
- **Testes:**
  - `test_case_entities.py`: caso sem acesso não aparece; token de caso só vê o próprio
    escopo; anotação e decisão contam;
  - unit test do chip;
  - um passo no `user-journeys.spec.ts`.
- **Seed:** dois casos de `fraud_ring` que compartilham uma conta.

**P8 · Claude Code de ponta a ponta (M).** Alvo: uma sessão do Claude Code conectada
pelo `claude mcp add` (comando já mostrado em `/settings/agents`) investiga um caso do
começo ao fim, sem tocar na UI, até a pessoa decidir.
- **A4 `propose_decision`:** rascunho `suggested`, com resultado do catálogo, alvos,
  fundamentação, evidências e tarefas. O DecisionPanel abre preenchido; só a pessoa grava.
  A rota humana continua sendo a única que grava.
- **A5:** validar `content_json` de `graph/view` e `graph/selection` em `case_items.py` e
  documentar o formato no docstring do `add_item`.
- **A7:** `read_item` devolve PNG/JPG como conteúdo de imagem MCP; o limite de tamanho é
  configurável.
- **Arquivos grandes:** `import_file` (texto inline) fica para arquivos pequenos e o
  docstring diz o limite. Acima disso, o caminho documentado é o upload REST multipart
  com o mesmo token (`/api/investigations/…`, rota já permitida a agentes), que o Claude
  Code faz com `curl`.
- **Descrições das ferramentas:** revisar todos os docstrings de `mcp/server.py` contra o
  modelo novo (case types, decisões, tarefas, sem máscara). É o que o Claude Code lê para
  escolher a ferramenta.
- **Playbook seed `claude_code_quickstart`** na org library: conectar, listar tipos,
  abrir caso, importar, consultar, anotar, tarefa, relatório, propor decisão.
- **Teste de aceite:** um teste estendido em `api/tests/test_mcp_server.py` (cliente SDK
  MCP) roda o fluxo inteiro:
  1. `get_case_type`;
  2. `create_case` com `external_ref`, e de novo com o mesmo valor, que devolve o mesmo
     caso;
  3. `import_file`, `run_query`, `annotate`, `add_task`, `render_report`;
  4. `find_entity_cases`, `propose_decision`;
  5. a pessoa confirma pela rota REST.
- **Validação manual:** a mesma sequência com o Claude Code real contra `make dev`.
- **Guia:** seção "Using Graph Lagoon from Claude Code" em `docs/guide/agents-mcp.md`.

Ordem: P0 → P1 → P2 → P3 → P4 → P5 → P7 → P8 → P6.
Tamanho relativo: P0 1 · P1 6 · P2 7 · P3 5 · P4 3 · P5 4 · P7 3 · P8 3 · P6 3.

**Plano 07 (separado, depois):**
- i18n da interface (en + pt-BR);
- ação em lote na fila (decidir ou fechar N casos);
- A1 webhooks por evento;
- A2 agente de serviço da equipe;
- A3 política do agente como dado (`agent_may_decide` com amostragem, `RULES` gerado);
- A6 assistente dentro do app.

---

## 3b. AI-first: o que ainda falta (verificado no código em 2026-10-19)

**Agente criando caso hoje:** já funciona. A ferramenta MCP `create_case`
(`mcp/server.py:261`) exige a permissão `investigation.create` e cria o caso como dono = a
pessoa do token. Os problemas:
- **Bug de escopo:** `create_investigation` (`services/cases.py:581`) não olha o escopo do
  token. Um token com escopo de caso cria um caso que depois não consegue ler. Correção na
  P1: token de caso → 403 `CASE_SCOPED_TOKEN`.
- **Faltam parâmetros para abrir caso a partir de alerta:** só existem título, descrição,
  preset e tags. Entram `case_type` (P2), `alert_at`, `occurred_at` e **`external_ref`
  idempotente**: o mesmo alerta, mesmo reenviado pelo agente, devolve o caso existente.
  Fica na P2.

**Lacunas para ser AI-first de verdade.** Decisão de escopo (2026-10-19): o que importa
agora é **o Claude Code conseguir operar a plataforma de ponta a ponta**.
- A4, A5 e A7, mais os pontos de criação e upload, entram aqui como **P8**.
- A1, A2, A3 e A6 mudam a política de confiança ou a arquitetura e vão para um **plano 07
  separado**, escrito depois. A P0 deixa só o esqueleto dele, com esta tabela.

| # | Lacuna | Hoje | Proposta |
|---|---|---|---|
| A1 | **Acordar o agente por evento** | nada de webhook ou notificação; o agente faz polling de `changes_since` | webhooks da org (config admin, assinados com HMAC) em `case.created`, `task.assigned` (agente), `suggestion.rejected` e `decision.review_requested`. O payload só leva ids; o agente busca o resto por MCP |
| A2 | **Agente de serviço da equipe** | o token pertence a uma pessoa e herda o acesso dela | um principal `agent:<nome>` criado pelo admin, que entra em grupos e reusa o sistema de permissões; os tokens dele não dependem de uma pessoa |
| A3 | **Política do agente como dado** | `forbid_agents` nas rotas e o texto `RULES` fixo (`org_library.py:16-23`, que ainda cita máscara e tipologias) | o resultado do catálogo ganha `agent_may_decide` (ex.: "false positive" em triagem de volume), sempre com `requires_review` por amostragem; o `RULES` passa a ser gerado da política real |
| A4 | **Agente propõe a decisão** | só pode recomendar no brief | `propose_decision` cria um rascunho `suggested`; a pessoa abre o DecisionPanel já preenchido e confirma |
| A5 | **Agente entrega visualização** | já dá por `add_item(kind="graph", subkind="view", content_json=…)` (`mcp/server.py:392`), mas o formato da visão (nós, filtros, grupos, layout) não é documentado nem validado | validar `content_json` de `graph/view` e `graph/selection` no serviço e descrever o formato no docstring e na guia (pequeno) |
| A6 | **Assistente dentro do app** | o Graph Lagoon é só servidor MCP; o agente roda fora | painel de chat no caso, chamando o Claude com as **mesmas** ferramentas MCP e o token da pessoa (grande; pode ficar para depois) |
| A7 | **Evidência em imagem** | binário nunca chega ao agente | as ferramentas MCP devolvem PNG/JPG como conteúdo de imagem para modelos multimodais |

## 3c. O que ainda ficaria cravado depois do plano

Fica cravado de propósito (é o núcleo):
- status `open|analysis|closed`, kinds de item e de anotação, estados de hipótese;
- regra de congelamento e hash;
- catálogo de permissões;
- allowlist de rotas REST do agente (`auth.py:163`), como piso de segurança.

Ficaria cravado **sem dever**, e entra no plano:

| Onde | O quê | Correção | Fase |
|---|---|---|---|
| `case_annotations.py:135` | um papel confirmado por entidade (em crédito a empresa é tomadora **e** garantidora) | `roles_multi: bool` no tipo de caso | P2 |
| `investigationStatus.ts` `URGENT_DAYS = 7` | limiar de urgência fixo | 20% do SLA restante, ou `urgent_hours` no tipo | P2 |
| `schemas.py:2118-2120` | padrões de rastreio (3 saltos, 24 h, 50) | `analysis_defaults` no tipo; sem tipo, sem limite | P5 |
| `AnalysisBar.vue` | catálogo fixo de análises | as `starter_queries` do tipo aparecem como botões ("Detectors"); análise nova = dado | P5 |
| `org_library.py:16-23` `RULES` | texto fixo das regras do agente | texto corrigido na P1 (sem máscara nem tipologias); gerado da política no plano 07 (A3) | P1 / 07 |
| `SwimlaneTimeline.vue:100-101` | `toLocale…('pt-BR')` | locale do navegador | P6 |
| `case_tables.py:250-254` | nomes padrão "Entidade" e "relacionado" ao promover | vêm do mapeamento; padrão `Entity`/`related` | P6 |

## 4. Permissões, admin e agentes

- **Permissões:** nenhuma nova. Tipos de caso, regras de máscara e biblioteca são de
  superusuário. `investigation.decide` continua; o texto vira genérico.
- **Registries:**
  - `CLEARABLE_TABLES`: `org_vocabularies` → `case_types`, mais `case_entities`;
  - `CONFIG_FIELD_KINDS`: sai `agents_allow_unmasked_data`;
  - `AUDITED_ROUTES`: entram `case-types`, `decisions` e `review`; saem `vocabularies` e
    `decision`;
  - `AUDIT_EXEMPT_ROUTES`: sai `typologies`;
  - `CONFIG_FIELD_KINDS`: sai `investigation_deadline_days`;
  - `describeAudit` passa a cobrir `case_type.*` e decisão com `outcome_label`.
- **Agentes:**
  - **Nunca:** decidir, revisar, compartilhar, apagar, reabrir, exportar.
  - **Sugerem:** papel, tag, `same_as`, status, tarefa.
  - **Fazem direto:** notas, documentos, consultas, análises, rascunho de relatório
    (item `suggested`).
- **Riscos:**
  - os gêmeos TS/Python precisam mudar juntos;
  - `e2e/helpers/api-mocks.ts` (1515 linhas) acompanha cada mudança de API;
  - o JSON `decisions` precisa ser reatribuído, não mutado no lugar;
  - bancos de dev que já rodaram a 016 precisam de `alembic downgrade 015 && upgrade head`.

## 5. Verificação ponta a ponta

1. Subir com `make dev` (ou o venv) e rodar o seed novo.
2. Como `dev@graphlagoon.local`:
   - criar um tipo "Credit review" no Admin;
   - abrir um caso desse tipo e conferir vocabulário e consultas iniciais;
   - registrar uma decisão parcial com alvo, depois uma decisão que fecha com quatro olhos;
   - concluir uma tarefa com o caso fechado;
   - reabrir;
   - exportar JSON e verificar os dois hashes.
3. **Claude Code real** conectado com `claude mcp add --transport http graphlagoon
   http://localhost:8000/graphlagoon/mcp --header "Authorization: Bearer glt_…"` (token
   de usuário), seguindo o playbook `claude_code_quickstart`: abre um caso, investiga e
   propõe uma decisão; a pessoa confirma na UI. Depois, com token de caso:
   - `get_case_type`, `list_tasks(mine)`, `add_task` (chega `suggested`);
   - `render_report` gera um rascunho;
   - `find_entity_cases` só retorna casos do escopo do token;
   - tentar decidir → 403.
   - Os dados chegam sem máscara, dentro do envelope `untrusted_data`.
4. Busca entre casos: no seed com dois casos `fraud_ring` que compartilham uma conta,
   selecionar a conta mostra "Seen in 1 other case". Um usuário sem share não vê o
   outro caso.
5. No caso de exemplo `pix_scam` do seed: importar o CSV SIMBA pelo template de mapeamento
   e gerar o resumo pelo template de relatório. Isso prova o cenário 1 sem código BR.
6. Rodar o grep de pronto da P6, que inclui `mask|unmasked`.

---

## Progresso

- [x] P0 · Spec
- [x] P1 · Tirar o domínio do código
- [x] P2 · Tipos de caso, campos e fila paginada
- [x] P3 · Decisões e ciclo de vida
- [x] P4 · Tarefas
- [x] P5 · Extensão por dados
- [x] P7 · Entidade vista em outros casos
- [x] P8 · Claude Code de ponta a ponta
- [x] P6 · Inglês e documentação
