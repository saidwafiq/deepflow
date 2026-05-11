# Plano V2 — Deepflow minimalista + ponte pra Meta-Harness

Branch: `v2-rewrite` (criado em 2026-05-11)
Rollback: tag `v0.1.140-pre-v2` aponta pro último estado de v1 (commit 589ffde).

## Contexto

V1 acumulou ~22.500 LOC em hooks e arquitetura curator+sub-agentes que estão produzindo:
- Lentidão vs. usar Claude Code direto
- Consumo alto de tokens (contexto duplicado: curator + sub-agente)
- Sub-agentes ignoram protocolo (nunca emitem `CONTEXT_INSUFFICIENT`; sempre tentam Bash)
- Hook-policiamento numa corrida armamentista contra o próprio modelo

O paper Meta-Harness (Lee et al., 2026) valida empiricamente: hand-designed harnesses perdem pra harnesses descobertos por busca, e compressão de feedback destrói o sinal mais importante (traces brutos de execução).

V2 é o passo "limpar a casa". Não é a meta final — a meta é Mode B (Meta-Harness rodando sobre v2). V2 é a base mínima que torna B tratável.

## Princípios

1. **Core imutável vs. zona mutável.** Skills/templates/schemas são fixos. Hooks ativos e prompts de execute/verify são a zona que B vai evoluir.
2. **Execução serial no thread principal.** Sem orchestrator, sem Task spawns, sem agentes `df-*`.
3. **Filesystem-first.** Sem inlining de arquivos. Sem compressão de contexto.
4. **Trace nativo.** V2 emite no shape de `bash-telemetry.jsonl`/`events.jsonl` — esse shape vira contrato pra B.

## Decisões travadas

| # | Decisão |
|---|---|
| 1 | Sem `legacy/` no branch. Rollback via tag `v0.1.140-pre-v2`. Código antigo é removido, não preservado. |
| 2 | `/df:execute` é nativo, prompt único, tasks serial dentro da mesma conversa Claude. Script externo (`tools/eval-runner.js`) só existe pra Mode B. |
| 3 | Dogfood A4 = spec nova pequena (~3 tasks, cross-stack) do backlog real do bingo-rgs. Não reusa specs do corpus. |

## Superfície alvo

| Camada | V1 | V2 | Delta |
|---|---|---|---|
| Comandos | 13 | 6: `discover, spec, execute, verify, map, eval` | -7 |
| Skills | 22 | ~8: mantém `atomic-commits, df-decisions, df-ac-coverage, browse-verify` + os 6 comandos | -14 |
| Agentes | 11 | 0 | -11 |
| Hooks | 24 ativos (~22.500 LOC) | 6 (~2.000 LOC): `spec-transition, df-spec-lint, df-codebase-inject (leve), df-codebase-staleness, df-statusline, df-check-update` | -18 hooks, ~-20.000 LOC |

### O que morre

- Todos hooks `df-bash-*` (rewrite/scope/worktree-guard/telemetry-pesado): sem sub-agentes, sem policiamento.
- `df-implement-protocol`, `df-explore-protocol`, `df-verify-protocol`: sem sub-agentes, sem contract enforcement.
- `df-delegation-contract`: sem sub-agentes.
- `df-snapshot-guard`, `df-worktree-guard`, `df-worktree-precheck`: sem worktree compartilhado.
- `df-artifact-validate` (1.896 LOC), `df-invariant-check` (1.266 LOC): validação pesada que não pagou seu peso.
- `df-implement-test-invocation-cap`: idem.
- Todos os agentes em `src/agents/df-*`: sem sub-agentes.
- Comandos `df:debate`, `df:fix`: pouco uso, alta complexidade.
- Skills relacionadas a worktree/curator.

## Fases

### A0 — Branch + scaffold (em andamento)

- ✅ Branch `v2-rewrite` criado
- ✅ Tag `v0.1.140-pre-v2` no commit 589ffde
- ⏳ Este `PLAN-V2.md` versionado

### A1 — Strip-down

- Remove `src/agents/*`
- Remove hooks que morrem (listados acima)
- Remove comandos `df:debate`, `df:fix`
- Remove skills relacionadas a worktree/curator
- Ajusta `bin/install.js` para superfície reduzida
- Garante que `npm install -g .` continua funcionando

### A2 — Reescrita do `/df:execute`

- `src/commands/df/execute.md` vira prompt único
- Lê spec, itera tasks sequencialmente no thread principal
- Commits atômicos por task (mantém `atomic-commits` skill)
- Sem worktree compartilhado — execução in-place na branch atual do usuário
- `df-codebase-inject` injeta `.deepflow/codebase/*.md` **uma vez** no início da sessão (não por delegação)
- Grava `.deepflow/spec-outcomes/{date}-{spec}/outcome.json` ao fim de cada spec, contendo: `{spec_id, merged: bool, tokens, wall_s, reverts, manual_edits_after}`. Esse arquivo alimenta o feedback loop futuro (Mode B contínuo).
- Trace: hooks PostToolUse mínimos preservam `bash-telemetry.jsonl` e `events.jsonl` no shape atual.

### A3 — Corpus builder

- `tools/build-corpus.js` (~300 LOC Node):
  - Lê `~/apps/bingo-rgs/specs/done-*.md`
  - Casa cada spec com seu merge commit via `git log --merges --grep="merge verified"`
  - `baseline_sha` = parent do primeiro commit ligado ao spec
  - `git archive baseline_sha | gzip > ~/meta-harness/corpus/{spec}/baseline.tar.gz`
  - `git diff baseline_sha..merge_sha > ~/meta-harness/corpus/{spec}/ground_truth.patch`
  - Extrai `tests_added.txt` (filtra `_test.go|.test.ts`)
  - Escreve `reward_spec.json` com comandos de build/test/AC check
- Humano marca 12 specs canônicas em `~/meta-harness/corpus/index.yaml`
- Subset inicial recomendado (cobertura cross-domain):
  - Backend Go: `03a-data-contracts`, `03b-event-streaming`, `rgs-postgres-integration`, `rgs-wallet-mtls-hardening`
  - Compliance/Security: `rgs-security-hardening`, `compliance-debt`, `audit-r1-r7-hardening`
  - Engine/Math: `gold-standard-rng`, `fix-rng-c-chacha8`, `provably-fair-envelope`
  - Cross-stack: `e2e-player-journey`, `public-rtp-api`

### A4 — Dogfood em bingo-rgs

- `npx deepflow` (v2) instala em `~/apps/bingo-rgs`
- Escreve spec nova pequena (~3 tasks, cross-stack) do backlog real
- Roda fluxo completo: `/df:discover` → `/df:spec` → `/df:execute` → `/df:verify`
- Mede: tokens, wall time, Bash calls, reverts manuais
- Critério de pass: spec completa sem intervenção humana significativa
- Não reusa specs do corpus (evita viés de retrospecto)

### A5 — Eval runner (ponte pra B)

- `tools/eval-runner.js`:
  - Input: caminho pra um harness, id de task
  - Extrai `corpus/{task}/baseline.tar.gz` → `runs/.../workdir/`
  - `cp -r` da harness → `workdir/.claude/` e `workdir/.deepflow/`
  - Copia `corpus/{task}/spec.md` → `workdir/specs/`
  - Invoca Claude Code via SDK (uma chamada por spec, não por task)
  - Captura trace, computa reward via `reward_spec.json`
  - Arquiva em `runs/{run-id}/evals/{task}/{trace.jsonl, diff.patch, result.json}`
- Roda v2 baseline nas 12 tasks → **scoreboard inicial** (12 × `{pass, tokens, time}`)
- Documenta `TRACE-SCHEMA.md` (contrato congelado pra B)

## Critério de saída de A

- Superfície reduzida ≥80% (LOC)
- V2 completa 1 spec real end-to-end sem intervenção (A4)
- `eval-runner` produz scoreboard determinístico das 12 tasks (A5)
- Trace schema documentado

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Specs com dependências em cadeia (03a→03b→03c) | `requires:` no `corpus/index.yaml`; eval ordena topologicamente |
| Specs UI não dão reward via test | Subset canônico exclui UI específica; `browse-verify` opcional pra L5 |
| SDK do Claude Code não captura trace adequado | Hook nativo + `bash-telemetry` cobre; SDK só pra spawn |
| Dogfood revela função load-bearing perdida | Rollback via tag; readd cirúrgico permitido no branch |
| bingo-rgs sofrer side effects de B | B usa apenas read (`git archive`, `git show`). Tarballs e workdirs ficam em `~/meta-harness/`, isolados. |

## Ponte pra B (Mode 1 / Meta-Harness) — fora do escopo de A

Saída de A5 é input direto pra B:
- `eval-runner.js` vira a função `Evaluate(H, M, X)` do paper Lee et al. 2026
- `~/meta-harness/runs/` vira o filesystem `D`
- `~/meta-harness/corpus/` vira `X` (search set)
- Proposer (Claude Opus 4.7) lê `runs/{prior-candidates}/` via filesystem livre
- Outer loop = `tools/meta-harness.js` (~200 LOC Node)

### Feedback loop (Mode B contínuo, escopo futuro)

- `.deepflow/spec-outcomes/` em projetos-usuário (ex: bingo-rgs) acumula `outcome.json` por spec executada
- `tools/curate-corpus.js` (humano-supervisionado) promove outcomes para `corpus/` quando: clean merge, has tests, well-scoped
- Re-trigger de B: threshold de 10 novas entradas canônicas OU manual override
- Warm start: população inicial = top-K do Pareto do run anterior
- Cold start ocasional: a cada 4 warm starts, pra detectar mínimo local
- Holdout permanente: 20% do corpus nunca entra no search set, só no test final
- Distribution shift: embedding de spec nova vs. corpus; OOD → flag (não bloqueia)

## Referências

- Paper: Lee et al. 2026, *Meta-Harness: End-to-End Optimization of Model Harnesses*. https://yoonholee.com/meta-harness/
- Codebase corpus: `~/apps/bingo-rgs` (38 done specs, 99 merge commits "merge verified changes")
- Modelo proposer (B futuro): Claude Opus 4.7
