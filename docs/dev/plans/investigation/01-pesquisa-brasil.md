# 01 · Pesquisa: contexto brasileiro

> Pesquisa de outubro de 2026. Itens marcados **(a confirmar)** vêm de fonte única
> ou secundária. Não invente números de norma.

## Conclusão

A regulação brasileira já descreve boa parte do produto:
- **Circ. 3.978:** dossiê com prazos;
- **CC 4.001:** indicadores que são padrões de grafo;
- **MED 2.0:** rastreio Pix em camadas;
- **SIMBA:** layout das quebras de sigilo.

O produto é uma **ferramenta auxiliar self-hosted**. A análise em si não pode ser
terceirizada (Circ. 3.978 art. 44).

## 1. Normas → requisito de produto

| Norma | Exige | Consequência no produto |
|---|---|---|
| [Circ. BCB 3.978/2020](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50905/Circ_3978_v6_P.pdf), art. 30 | Registro de pagamentos com origem e destino: nome, CPF/CNPJ, instituição, agência, conta | Esquema mínimo da aresta "transação" |
| Circ. 3.978, art. 31 | Com participantes não autorizados (subcredenciadores), acesso contratual aos **beneficiários finais** | Tipologia de subcredenciador e conta-bolsão |
| Circ. 3.978, art. 39 a 43 | Até 45 dias para selecionar e mais 45 para analisar; **dossiê** de toda análise, comunicada ou não | Investigação = dossiê; prazos visíveis |
| Circ. 3.978, art. 40 | Parâmetros, regras e cenários documentados e auditáveis | Parâmetros do rastreio gravados na evidência |
| Circ. 3.978, art. 44 | A análise não pode ser terceirizada; serviços auxiliares podem | Ferramenta auxiliar, self-hosted |
| Circ. 3.978, art. 48 e 55 | Decisão registrada; comunicação via **Siscoaf** no dia útil seguinte | Resumo para o Siscoaf; sem e-filing (API pública não conhecida, **a confirmar**) |
| Circ. 3.978, art. 49 | Comunicação de operações em espécie de R$ 50 mil ou mais (Res. BCB 591/2026 amplia para câmbio em espécie e cripto em autocustódia ≥ US$ 10 mil) | Tipologia de fracionamento com limite configurável |
| Circ. 3.978, art. 50 | Vedação de tipping-off | Compartilhamento só nominal |
| Circ. 3.978, art. 67 | Retenção de 10 anos de cadastros, registros e dossiês | Caso decidido imutável; arquivos com hash |
| [CC BCB 4.001/2020](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50911/C_Circ_4001_v4_P.pdf) | Indicadores de atipicidade (ver §2) | Selos de tipologia com o item da norma |
| Res. BCB 493/2025, MED 2.0 ([Fórum Pix](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Forum_Pix_Plenaria/20251204-Forum_Pix.pdf)) | Rastreio de fraude Pix além da 1ª conta, com bloqueio e devolução em camadas; obrigatório desde 2/2/2026; Pix intra-instituição enviado ao BCB desde 25/11/2025 | O fluxo A espelha o MED 2.0; profundidade de 2 camadas oficial, 5 em fontes secundárias (**a confirmar**) |
| Res. BCB 501/2025 | Rejeitar pagamentos a contas sob "fundada suspeita de fraude" | Listas de contas e chaves marcadas para exportar |
| [Res. BCB 587/2026](https://cesconbarrieu.com.br/resolucao-bcb-no-587-2026-novas-obrigacoes-e-impactos-para-participantes-do-pix/) | Marcação de fraude no DICT por CPF/CNPJ, 5 anos, justificativa, revisão em 7 dias | Justificativa por entidade marcada |
| [Res. Conj. 6/2023](https://www.mattosfilho.com.br/unico/resolucao-dados-fraudes/) + Res. BCB 343/2023 (+ Res. BCB 569/2026) | Compartilhar dados de fraude entre instituições em 24 h; ampliado para cripto e bets ilegais | Importar e exportar registros RC6 |
| Res. BCB 518/2025 + Res. CMN 5.261/2025 | Fim das contas-bolsão | Tipologia de hub |
| [Portaria SPA/MF 566/2025](https://www.migalhas.com.br/depeso/427163/a-portaria-566-da-spa-mf-e-as-instituicoes-financeiras-e-de-pagamento) (sucessora 2.750/2026 **a confirmar**) | Reportar contas de bets não autorizadas em 24 h, com agência, conta, CPF/CNPJ, chave Pix, ISPB; contas rotativas = mesma operação | Tipologia de bets e prazo de 24 h na fila |
| [LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm) art. 7 II/IX, 20, 37 | Base legal, revisão de decisão automatizada, registro de tratamento | Nada decidido automaticamente; diário |
| [LC 105/2001](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp105.htm) | Sigilo bancário; troca de informação de fraude permitida entre instituições | Need-to-know; auditoria de leitura |

## 2. Indicadores da CC 4.001 que são padrões de grafo

- **I-c:** aumento súbito de depósitos em espécie seguido de envio rápido a destino sem
  relação.
- **I-d, I-e, I-k, I-m:** fracionamento de depósitos (inclusive boletos) ou saques, ou
  várias operações em 5 dias úteis, para ficar abaixo de limites.
- **I-f:** depósitos fracionados em caixas próximos, numa conta ou em várias.
- **I-h:** saques em conta que recebe muitos créditos eletrônicos de muitas origens.
- **III-f:** muitas contas abertas juntas com elementos em comum (titulares,
  procuradores, sócios, endereço, telefone).
- **III-h, III-i, III-k, III-l:** mesmo procurador para várias empresas; mesmo endereço,
  e-mail ou IP entre pessoas ou empresas sem relação.
- **III-n:** sócios sem capacidade financeira para o negócio.
- **IV-b:** valores redondos ou logo abaixo de limites.
- **IV-e, IV-f:** conta dormente que passa a movimentar muito, ou o inverso.
- **IV-k, IV-ad:** recebe e repassa em seguida (passagem).
- **IV-n, IV-o, IV-p:** muitas origens sem relação; pagamentos a fornecedores sem
  relação com o negócio ou distantes.
- **IV-v a IV-z (adquirência):** valores altos no mesmo POS, incompatíveis com o
  perfil; horário atípico; POS longe do lojista.
- **IV-ac:** volume incompatível com o faturamento.
- **X-l, X-m:** transferências internacionais fracionadas; valores parecidos no mesmo
  dia com origem ou destino em comum.

## 3. Tipologias: padrão no grafo e dados que ligam

| Tipologia | Padrão no grafo | Dados que ligam |
|---|---|---|
| Laranjas e contas de passagem | Entrada de muitos seguida de saída imediata; saldo perto de zero; conta dormente que volta a movimentar | CPF, dispositivo, IP, telefone, e-mail, endereço, chave Pix, marcação DICT, MED |
| Golpe Pix (falsa venda, falsa central) | Vítima → laranja da 1ª camada → divisão em camadas → saque, cripto, aposta ou boleto; valores encolhendo; minutos entre saltos | EndToEndId, chave Pix, notificação de infração, dispositivo |
| Lojista de fachada e bust-out | CNPJ novo (MEI), CNAE incompatível, sócios do QSA em comum com lojistas que saíram; antecipação seguida de chargeback | CNPJ, QSA, domicílio bancário, terminal, CEP |
| Transaction laundering | Lojista processa vendas de outro negócio; ticket padronizado; vários lojistas liquidando na mesma conta | URL, subcredenciador, conta de liquidação, MCC/CNAE |
| Chargeback combinado | Anéis de portador e lojista; contestadores com dispositivo em comum | PAN com hash, CPF, dispositivo, lojista |
| Card testing | Estrela: muitos cartões → um lojista online, valores mínimos | BIN, IP, dispositivo |
| Triangulação | Loja falsa compra de lojista legítimo com cartão roubado e entrega ao comprador real | Endereço de entrega e de cobrança, vendedor, conta de repasse |
| Fraude de boleto | Linha digitável alterada desvia o pagamento; boletos em espécie fracionados | Código de barras, beneficiário, ISPB |
| Subcredenciador e conta-bolsão | Hub com grau enorme; beneficiários finais só no razão interno (ex.: [Fluxo Oculto](https://viva.com.br/noticias/operacao-fluxo-oculto-mira-lavagem-do-pcc-em-fintechs-e-desvio-de-nafta.html), [Spare](https://www.revistaoeste.com/brasil/pcc-lavou-r-5-bi-com-maquininhas-de-cartao-diz-receita-federal/)) | Beneficiário final, regras de split, ID de sub-lojista |
| Bets não autorizadas | Muitos CPFs → uma conta intermediária; valores repetidos; contas ou chaves rotativas atrás do mesmo site | CNPJ contra a lista da SPA, chave Pix, QR/txid, domínio |
| Fracionamento | Muitos→um ou um→muitos em 1 a 5 dias úteis, logo abaixo de R$ 50 mil ou em valores redondos | Janela de tempo, agência/ATM, CPF do portador |

A [Serasa](https://www.serasaexperian.com.br/sala-de-imprensa/prevencao-a-fraude/contas-laranja-potenciais-crescem-mais-de-60-em-dois-anos-no-brasil-aponta-estudo-da-serasa-experian/)
estimou 2,6 milhões de perfis prováveis de laranja em 2025, dos quais só 3,2% foram
detectados.

## 4. SIMBA e outros formatos de entrada

O SIMBA foi criado pela SPPEA da PGR. É usado por MPF, PF, MPs e polícias estaduais,
Justiça do Trabalho e Fisco ([PC-GO](https://goias.gov.br/policiacivil/simba)). O
layout vem da Carta-Circular BCB 3.454/2010 e do
[memorando MI001-SPPEA v3.1](https://www.ancord.org.br/wp-content/uploads/2021/08/MI-001_SigiloBancario_Bancos-3-arquivos-para-publicacao-no-ASSPAWEB-PGR-00269961-2021.pdf).

- 5 arquivos `.TXT` separados por **TAB**, com o nome `<NumeroCaso>_<ARQUIVO>.TXT`.
- Datas em `ddmmaaaa`; valores inteiros em **centavos**.

| Arquivo | Campos principais |
|---|---|
| AGENCIAS | `NUMERO_BANCO` (COMPE), `NUMERO_AGENCIA`, nome, endereço, CEP, datas |
| CONTAS | banco, agência, `NUMERO_CONTA`, `TIPO_CONTA`, datas, `MOVIMENTACAO_CONTA` (1 investigada com movimento, 2 sem, 3 contraparte do mesmo banco) |
| TITULARES | chave da conta, `TIPO_TITULAR` (T, 1, 2…, R, L, P, O), `PESSOA_INVESTIGADA`, `TIPO_PESSOA`, `CPF_CNPJ_TITULAR`, nome, documento, endereço, telefone, `VALOR_RENDA`, datas |
| EXTRATO | `CODIGO_CHAVE_EXTRATO`, chave da conta, `DATA_LANCAMENTO`, `NUMERO_DOCUMENTO`, `DESCRICAO`, `TIPO_LANCAMENTO` (ex.: 120/209 transferência interbancária, 114 saque, 220 depósito em espécie, 222 recebíveis de cartão, 223 crédito Pix por QR), `VALOR`, `NATUREZA` (C, D ou `*`), saldo, `LOCAL_TRANSACAO` |
| ORIGEM_DESTINO | `CODIGO_CHAVE_OD`, `CODIGO_CHAVE_EXTRATO`, `VALOR_TRANSACAO`, `NUMERO_BANCO_OD`, `AGENCIA_OD`, `CONTA_OD`, `TIPO_PESSOA_OD`, `CPF_CNPJ_OD`, `NOME_PESSOA_OD`, `CODIGO_DE_BARRAS`, endossante, `OBSERVACAO` |

- **Contraparte não correntista:** agência `9999`, conta `999…9` e observação
  NAO-CORRENTISTA.
- **Qualidade:** o [diagnóstico ENCCLA 2019](https://www.gov.br/mj/pt-br/assuntos/sua-protecao/lavagem-de-dinheiro/enccla/acoes-enccla/arquivos-enccla-2019/e2019a10-produto-i-diagnostico-simba.pdf)
  achou 29 a 35% das transações sem origem ou destino identificados, e de 78 a 97 dias
  de resposta média dos bancos.
- **Lacuna do layout:** a v3.1 não tem chave Pix nem EndToEndId (**a confirmar** em
  versões mais novas).
- **Outras entradas que o investigador recebe:**
  - RIFs do COAF: inteligência, não prova;
  - [CCS](https://www.bcb.gov.br/content/acessoinformacao/ccs_docs/manual_do_CCS.pdf)
    via Sisbajud: só vínculo CPF/CNPJ–instituição, sem saldo;
  - notificações do MED;
  - registros RC6.

## 5. Ferramentas em uso no Brasil

- **Bureaus e antifraude:**
  - Serasa Experian comprou a ClearSale por cerca de R$ 2 bi
    ([Bloomberg Línea](https://www.bloomberglinea.com.br/negocios/serasa-experian-acerta-aquisicao-da-clearsale-por-r-21-bi-e-avanca-em-antifraude/))
    e vende o score "Perfil Laranja" e RC6;
  - Boa Vista (Equifax) comprou a Konduto;
  - Quod, usada pelo Itaú contra laranjas desde junho de 2026
    ([Let's Money](https://www.letsmoney.com.br/noticias/itau-quod-base-fraude-conta-laranja/));
  - dados e identidade: Neoway, BigDataCorp, idwall, unico;
  - Feedzai no BTG+ ([Feedzai](https://feedzai.com/pressrelease/btg-implements-feedzais-artificial-intelligence-solution/)).
- **Grafo feito em casa:**
  - Nubank: Neptune + SageMaker
    ([Building Nu](https://building.nu.com/scaling-fraud-defense-how-nubank-evolved-its-risk-analysis-platform/));
  - Banco Inter: "Delator", GNN sobre grafo temporal
    ([BRASNAM](https://sol.sbc.org.br/index.php/brasnam/article/download/20513/20340)).
  - Stone, Cielo, Mercado Pago, PagBank, Getnet e Rede não publicaram as suas
    ferramentas.

## 6. Dados abertos para enriquecimento

| Fonte | Formato | Como junta |
|---|---|---|
| [CNPJ aberto da Receita](https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf) (Empresas, Estabelecimentos, Sócios/QSA, Simples) | CSV separado por `;`, mensal, ~10 partes | CNPJ básico (8 dígitos); CPF de sócio **mascarado** (`***XXXXXX**`), então o match é por nome + 6 dígitos e sempre revisado; telefone, e-mail e endereço viram vínculos |
| [Portal da Transparência](https://portaldatransparencia.gov.br/) (CEIS, CNEP, CEPIM, CEAF) | CSV e API | CPF/CNPJ |
| Lista de PEP ([OpenSanctions](https://www.opensanctions.org/datasets/br_pep/)) | CSV | Nome + CPF mascarado |
| [TSE, prestação de contas](https://dadosabertos.tse.jus.br/ne/dataset/prestacao-de-contas-eleitorais-2024/resource/c74840a4-f303-4771-af44-ecbf15bfc302) | CSV em ZIP | CPF/CNPJ |
| Listas do BCB (ISPB/COMPE), da SPA (bets autorizadas), CNAE, sanções do CSNU | CSV e listas | Código do banco, CNPJ, CNAE, nome |
