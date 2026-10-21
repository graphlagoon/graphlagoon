# 07 · AI-first runtime (esqueleto)

> Status: **esqueleto, não aprovado** (2026-10-19). Fica para depois do
> [06-plataforma-generica.md](06-plataforma-generica.md). O 06 entrega o que o Claude Code
> precisa para operar a plataforma pelo MCP. Este plano reúne o que muda a política de
> confiança ou a arquitetura, e por isso precisa de desenho e aprovação próprios.

## Escopo candidato

| # | Item | Hoje (depois do 06) | Ideia |
|---|---|---|---|
| A1 | **Acordar o agente por evento** | o agente faz polling de `changes_since` | webhooks da org (config admin, assinados com HMAC) em `case.created`, `task.assigned` (agente), `suggestion.rejected` e `decision.review_requested`. O payload só leva ids; o agente busca o resto por MCP |
| A2 | **Agente de serviço da equipe** | o token pertence a uma pessoa e herda o acesso dela | um principal `agent:<nome>` criado pelo admin, que entra em grupos e reusa o sistema de permissões; os tokens dele não dependem de uma pessoa |
| A3 | **Política do agente como dado** | `forbid_agents` nas rotas e o texto `RULES` fixo em `services/org_library.py` | o resultado do catálogo ganha `agent_may_decide` (ex.: "false positive" em triagem de volume), sempre com quatro olhos por amostragem; o `RULES` passa a ser gerado da política real |
| A6 | **Assistente dentro do app** | o agente roda fora (Claude Code, outro cliente MCP) | painel de chat no caso, chamando o Claude com as mesmas ferramentas MCP e o token da pessoa |
| — | **Ação em lote na fila** | uma decisão por vez | decidir ou fechar N casos de uma vez (triagem de alertas, chargebacks) |
| — | **i18n da interface** | interface em inglês; termos de domínio vêm dos dados | vue-i18n com en + pt-BR |

## Perguntas em aberto

1. Um agente pode encerrar caso sozinho? Em quais resultados e com qual amostragem de revisão humana?
2. O agente de serviço vê todos os casos de um grupo ou só os que lhe são atribuídos?
3. O assistente no app usa a chave de API da org ou a da pessoa? Quem paga e quem audita?
