# Explore Protocol — Jornada Completa (2026-03-25)

## 1. Origem — Morph WarpGrep como inspiração

Said mencionou que já havia feito melhorias no deepflow inspiradas pelo Morph (morphllm.com). O Morph WarpGrep é um AI-powered code search que reduz o 60% do tempo que agentes gastam em busca (não em coding). A ideia: retornar **linhas relevantes agregadas com contexto**, não arquivos inteiros.

Buscamos no git e encontramos dois commits de 17/03 (scope `context-efficient-search`):
- `e0ef697` — inverteu a ordem no plan.md: Impact Analysis (LSP) antes de Targeted Exploration
- `c3be319` — adicionou Search Protocol ao explore-agent.md: DIVERSIFY/CONVERGE/EARLY STOP, formato `filepath:startLine-endLine`

## 2. Diagnóstico — protocolo documentado mas não enforced

Verificamos todos os consumidores do template:
- `plan.md` e `spec.md` referenciavam `explore-agent.md` vagamente ("Follow templates/...")
- `execute.md` ignorava completamente
- O template dependia do agente **ler** o arquivo, mas o prompt de spawn não o incluía
- **Resultado**: protocolo existia no filesystem mas agentes nunca o viam

## 3. Decisão de arquitetura — Hook vs Shell Injection

Avaliamos 3 abordagens:
1. **Shell injection** (`!cat templates/...`) — já usado no deepflow para estado estático, mas cada comando precisaria lembrar de incluir
2. **Hook PreToolUse** — intercepta toda chamada Agent(subagent_type="Explore") centralmente
3. **Custom agent type** — perderia otimizações do Explore built-in

Escolhemos o **hook** por ser determinístico e cross-cutting. Avaliamos também todos os 12 usos existentes de shell injection — todos corretos para estado estático (PLAN.md, config.yaml, checkpoint). O explore protocol é diferente: é regra de comportamento para sub-agentes, não estado.

## 4. Separação do template

Dividimos `explore-agent.md` em dois:
- **`explore-agent.md`** — regras para orquestradores (como spawnar agentes): spawn rules, prompt structure
- **`explore-protocol.md`** — protocolo para o agente seguir (injetado via hook): DIVERSIFY/CONVERGE/EARLY STOP, formato de retorno

## 5. Implementação do hook

Criamos `hooks/df-explore-protocol.js`:
- `@hook-event: PreToolUse`
- Intercepta `Agent` com `subagent_type === "Explore"` (case-insensitive)
- Lê `explore-protocol.md` de `{cwd}/templates/` ou `~/.claude/templates/`
- Retorna `updatedInput` com protocolo appendado ao prompt
- Fail-open: nunca bloqueia em caso de erro
- 9 unit tests + registro no tag test (26 total passando)

Descoberta durante teste: o hook precisa do template em `~/.claude/templates/` para funcionar em projetos que não são o repo do deepflow.

## 6. Primeiro benchmark — bingo-go (4 testes)

| Teste | Tool calls | Duração | Formato | Output |
|---|---|---|---|---|
| Sem protocolo (Explore) | 30 | 71s | Narrativo | ~2000 tok |
| Com protocolo (Explore) | 19 | 27s | Parcial | ~500 tok |
| Protocolo (general) | 16 | 22s | 100% limpo | ~100 tok |
| Protocolo + LSP (general) | 24 | 27s | 100% limpo | ~120 tok |

**Descoberta-chave**: a frase "Your ENTIRE response MUST be filepath:startLine-endLine lines. Nothing else." foi o que fez o formato funcionar 100%.

## 7. LSP — disponível mas ignorado

Confirmamos que `ENABLE_LSP_TOOL=1` está configurado e o LSP tool existe em sub-agentes (testamos com chamadas diretas em general-purpose, Explore, haiku e sonnet).

Porém nos benchmarks os agentes **nunca usaram LSP**. O hook de tool-usage (`df-tool-usage.js`) não logava `tool_input`, então corrigimos para incluir um `input` summary por tipo de tool (LSP: `operation:filename:line`, Read: `filename:offset-limit`, etc).

## 8. Otimização do Read em execute e debate

Aplicamos a mesma filosofia fora do Explore:
- **`execute.md` §6**: `Read all Impact files` → `LSP documentSymbol → Read with offset/limit on relevant ranges only`
- **`debate.md` §2**: `Glob/Grep/Read relevant files` → `LSP documentSymbol first → Read with offset/limit`
- **`verify.md`**: analisamos e concluímos que não há otimização — verify não lê source code, todas verificações são machine-verifiable via CLI

## 9. Por que haiku ignora LSP — e a solução U-curve

Testamos 3 abordagens em paralelo:
- Haiku + "Prefer LSP" (genérico) → **ignorou LSP**
- Haiku + "You MUST use LSP" (imperativo) → **ignorou LSP**
- Haiku + chamadas LSP literais no prompt → **ignorou LSP**

Mas quando pedimos "Run LSP(...)" como **única tarefa**, haiku executou perfeitamente. O problema: em prompts complexos com múltiplas instruções, haiku prioriza Grep/Glob que conhece melhor e descarta LSP do meio do prompt.

**Solução**: aplicar o **attention U-curve** do deepflow — info crítica no START e END, não no MIDDLE.

Reestruturamos o protocolo:
- **START (alta atenção)**: STEP 1 com chamadas LSP concretas (`workspaceSymbol`, `documentSymbol`, `findReferences`) + Grep/Glob
- **MIDDLE (baixa atenção)**: CONVERGE, EARLY STOP, antipattern
- **END (alta atenção)**: OUTPUT FORMAT imperativo

## 10. Resultado final — U-curve + findReferences

| Teste | Tool calls | Duração | LSP usado | Formato |
|---|---|---|---|---|
| Sem protocolo | 35 | 61s | Não | Narrativo |
| Protocolo original | 16-28 | 22-43s | Não | 100% |
| **U-curve + LSP prescritivo** | **13** | **20s** | **Sim (2 calls)** | **100%** |

O U-curve fez haiku **finalmente usar LSP**. Resultado: **63% menos tool calls, 67% menos duração** vs baseline.

## Arquivos criados/modificados

- `hooks/df-explore-protocol.js` — PreToolUse hook (novo)
- `hooks/df-explore-protocol.test.js` — 9 unit tests (novo)
- `templates/explore-protocol.md` — protocolo para agentes (novo, extraído de explore-agent.md)
- `templates/explore-agent.md` — simplificado para regras de orquestrador
- `hooks/df-hook-event-tags.test.js` — adicionado df-explore-protocol
- `hooks/df-tool-usage.js` — adicionado campo `input` summary
- `src/commands/df/execute.md` — LSP documentSymbol + Read offset/limit
- `src/commands/df/debate.md` — LSP documentSymbol + Read offset/limit

## 11. Economia real — dados da API (não inferidos)

Tokens reais do `total_tokens` retornado por cada agente:

| Teste | total_tokens | tool_uses | duration_ms |
|---|---|---|---|
| Sem protocolo (Explore) | 64,742 | 35 | 61,001 |
| Com protocolo (Explore) | 50,853 | 23 | 37,070 |
| Protocolo (general) | 43,807 | 28 | 33,073 |
| **U-curve + LSP** | **35,805** | **13** | **19,874** |

Economia net U-curve vs baseline: **-28,937 tokens (45%)**, ROI 1:96 (cada token do protocolo economiza 96).

## 12. Impacto no cache — crescimento quadrático

Dados reais de `subagent-sessions.jsonl` (cache_read, cache_creation por agente):

| | Sem protocolo (35 calls) | U-curve (13 calls) |
|---|---|---|
| cache_hit | 1,862,873 tok | 408,727 tok |
| cache_write | 209,420 tok | 69,791 tok |
| tokens_in | 341 tok | 4,131 tok |
| tokens_out | 5,990 tok | 1,271 tok |

### Por que cache_hit é 4.6x maior (não 2.7x)?

Cada tool call relê o **prefixo inteiro acumulado** como cache_hit. O prefixo cresce a cada call:

```
Call 2:  relê    ~4,500 tok
Call 5:  relê   ~26,000 tok
Call 13: relê   ~63,500 tok
Call 35: relê  ~153,500 tok
```

Total cache_hit = soma de todos os prefixos → cresce com **N²**, não N.

### Cache refresh: não é problema

- Duração máxima: 61s (baseline), 20s (U-curve)
- TTL do cache: 300s (5 min)
- Cada call renova o TTL automaticamente
- Zero expirations durante execução

### Custo real (preços oficiais Haiku 4.5)

| Componente | $/MTok | Baseline | U-curve | % do custo baseline |
|---|---|---|---|---|
| cache_hit | $0.10 | $0.1863 | $0.0409 | 39% |
| **cache_write** | **$1.25** | **$0.2618** | **$0.0872** | **55%** |
| tokens_in | $1.00 | $0.0003 | $0.0041 | 0% |
| tokens_out | $5.00 | $0.0299 | $0.0064 | 6% |
| **TOTAL** | | **$0.4784** | **$0.1386** | |

**Economia: $0.34/agent (71%)**

### Projeção para df:plan (5 Explore agents)

| Modelo | Baseline | U-curve | Economia |
|---|---|---|---|
| Haiku 4.5 | $2.39 | $0.69 | -$1.70 |
| Sonnet 4.6 | $7.18 | $2.08 | -$5.10 |
| Opus 4.6 | $11.96 | $3.47 | -$8.49 |

### Insight: cache_write domina o custo

- cache_write ($1.25/MTok) é **12.5x** mais caro que cache_hit ($0.10/MTok)
- Cada tool call cria ~5,900 tok de cache_write (tool result + model turn)
- 22 calls a menos = 139,629 tok a menos de cache_write = **$0.17 economizados**
- Menos tool calls reduz AMBOS: cache_write (linear) e cache_hit (quadrático)

## Arquivos criados/modificados

- `hooks/df-explore-protocol.js` — PreToolUse hook (novo)
- `hooks/df-explore-protocol.test.js` — 9 unit tests (novo)
- `templates/explore-protocol.md` — protocolo para agentes (novo, extraído de explore-agent.md)
- `templates/explore-agent.md` — simplificado para regras de orquestrador
- `hooks/df-hook-event-tags.test.js` — adicionado df-explore-protocol
- `hooks/df-tool-usage.js` — adicionado campo `input` summary por tool type
- `src/commands/df/execute.md` — LSP documentSymbol + Read offset/limit
- `src/commands/df/debate.md` — LSP documentSymbol + Read offset/limit

## Princípios validados

1. **Hook > Shell injection** para enforcement cross-cutting em sub-agentes
2. **Formato imperativo** ("Your ENTIRE response MUST be X. Nothing else.") > formato sugestivo ("Return ONLY:")
3. **U-curve attention** funciona na prática — LSP no START do protocolo fez haiku obedecer
4. **findReferences** é a operação LSP mais valiosa para Explore (onde X é usado?)
5. **Haiku segue instruções concretas**, não abstratas — chamadas literais > "Prefer LSP"
6. **ROI 1:96** — 300 tokens de protocolo economizam 28,937 tokens
7. **Cache_hit cresce quadraticamente** com tool calls — reduzir calls tem efeito composto
8. **cache_write domina** o custo (55%) — cada call eliminada economiza ~$0.007 em write
