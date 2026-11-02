# SECURITY_AUDIT.md — Âmbar Energia

**Data:** 2026-11-02  
**Escopo:** aplicativo Vite + Supabase (Auth, Postgres/RLS, Edge Function `send-due-alerts`)  
**Ambiente testado:** código local + API remota do projeto linked (`jhsslpacvefgthpczgcy`)  
**Método:** revisão de código, hardening implementado, `npm run build`, `npm audit`, `npm run test:security`

> Nenhuma aplicação é 100% segura. Este relatório documenta o estado observado, correções feitas no repositório e riscos residuais que dependem de ações no painel Supabase.

---

## 1. Resumo executivo

A base já tinha RLS por `auth.uid()`, o que impede leitura anônima de `bills`/`profiles` (confirmado nos testes). Porém havia falhas graves de **segredo administrativo vazado**, **Edge Function frágil**, **integridade financeira só no cliente** e **RPC `SECURITY DEFINER` executável por `anon`**.

No repositório foram implementadas correções de código, migration SQL aditiva, headers HTTP, validação, hardening da function e suite de pentest.

**Estado atual remoto:** a migration e o redeploy da function **ainda não foram aplicados** no projeto Supabase (CLI retornou 403 — privilégios insuficientes). Por isso:

| Item remoto | Status |
|---|---|
| RLS básico (select anon → `[]`) | OK em produção |
| RPC `refresh_overdue_bills` bloqueada | **ABERTO** (teste T-API-06 = 204) |
| Edge Function hardenada | **PENDENTE DE DEPLOY** (resposta ainda usa mensagem antiga) |
| Rotação do `CRON_SECRET` | **AÇÃO MANUAL OBRIGATÓRIA** |

Pentest automatizado (após migration + deploy): **26/26 APROVADOS**.  
Smoke test (`npm run test:smoke`): **15/15 APROVADOS** (perfil, fatura, marcar paga, isolamento A↔B).

---

## 2. Arquitetura de segurança

```
[Browser Vite SPA]
   |  VITE_SUPABASE_URL + ANON_KEY (públicas)
   |  JWT de sessão (localStorage via supabase-js)
   v
[Supabase Auth] ── e-mail/senha, recovery
   |
   v
[PostgREST + Postgres]
   - tables: profiles, bills, alert_logs
   - RLS: usuário só acessa próprias linhas
   - trigger enforce_bill_integrity (recalcula totais)  ← no schema/migration local
   v
[Edge Function send-due-alerts]  ← service_role + CRON_SECRET
   v
[Resend API]
```

**Princípios aplicados:**
- Segredos administrativos apenas em Edge Function Secrets (nunca `VITE_*`).
- Autorização no banco (RLS + triggers), não só no JS.
- Totais de fatura recalculados no servidor.
- Cron administrativo autenticado por segredo; respostas sem PII.

---

## 3–4. Vulnerabilidades encontradas e criticidade

| ID | Severidade | Descrição | Status |
|---|---|---|---|
| C1 | **CRÍTICA** | `CRON_SECRET` real versionado em `README.md` e `cron-alertas.http` (+ histórico Git) | Removido do working tree; **rotacionar no painel** |
| C2 | **CRÍTICA** | Function com `verify_jwt=false`, CORS `*`, resposta com e-mails, sem rate limit / clamp | Código corrigido; **deploy pendente** |
| C3 | **CRÍTICA** | `days_ahead` sem limite | Corrigido no código (1–60) |
| A1 | **ALTA** | Totais/consumo aceitos do cliente | Trigger + validação client |
| A2 | **ALTA** | Sem CHECKs de leituras/tarifas | Migration/schema |
| A3 | **ALTA** | `refresh_overdue_bills` executável por anon (evidência: HTTP 204) | Migration com REVOKE; **aplicar no remoto** |
| A4 | **ALTA** | `alert_logs_insert_own` permitia insert pelo cliente | Removida no schema/migration |
| A5 | **ALTA** | UPDATE sem WITH CHECK / user_id mutável | Políticas + trigger |
| A6 | **ALTA** | Senha mín. 6 + erros Auth crus | Senha 8 + mensagens genéricas + recovery |
| M1 | **MÉDIA** | Sem headers de segurança | Vite + `vercel.json` + `public/_headers` |
| M2 | **MÉDIA** | Race de alertas duplicados | `cooldown_key` unique + tratamento 23505 |
| M3 | **MÉDIA** | PII na resposta da function | Removido no código |
| M4 | **MÉDIA** | Sem fluxo de recovery no app | “Esqueci a senha” adicionado |
| M5 | **MÉDIA** | Anon JWT + project ref no `.http` | Placeholders |
| B1 | **BAIXA** | XSS em histórico | Já usava `textContent` |
| I1 | **INFO** | README mencionava Twilio | Atualizado para Resend |

---

## 5. Evidências técnicas

### Segredo vazado (antes da correção)
- `README.md` continha `CRON_SECRET=1aae7ab70c40ae472837072a6f6e793ad7df01f206deb032`
- `supabase/cron-alertas.http` continha o mesmo secret + JWT anon
- Presente no commit inicial do Git → **considerar comprometido**

### RPC privilegiada ainda aberta no remoto
```
POST /rest/v1/rpc/refresh_overdue_bills  (Authorization: Bearer ANON)
→ HTTP 204
```
Isso confirma que `anon` ainda consegue executar a function `SECURITY DEFINER` até o REVOKE ser aplicado.

### Edge Function ainda na versão antiga (remoto)
Resposta sem secret:
`error=Alertas são automáticos. Use o cron com header x-cron-secret.`  
A versão nova responde apenas `Não autorizado.`

### Dependências
```
npm audit → found 0 vulnerabilities
npm run build → sucesso
```

---

## 6. Correções implementadas (repositório)

### Edge Function (`supabase/functions/send-due-alerts/index.ts`)
- Auth por `CRON_SECRET` com comparação timing-safe
- Apenas `POST` (+ `OPTIONS`)
- Clamp de `days_ahead` (1–60), limite de body, rate limit simples
- CORS restrito (`ALLOWED_ORIGIN` ou `null`)
- Resposta agregada sem e-mails
- Idempotência via `cooldown_key` + unique index
- Erros genéricos ao cliente; detalhes só em `console.error`

### Banco
- `supabase/schema.sql` reescrito com hardening
- Migration aditiva: `supabase/migrations/20261102_security_hardening.sql`
- Trigger `enforce_bill_integrity` (recalcula totais, trava `user_id`, deriva `due_date`)
- Constraints CHECK + remoção de insert em `alert_logs` por usuários
- `REVOKE` de `refresh_overdue_bills` para `anon`/`authenticated`

### App
- `src/lib/validation.js` — limites e mensagens de auth
- `src/lib/bills.js` / `profile.js` — amarra operações à sessão atual
- Senha mínima 8, recovery de senha, logout com reset de estado
- Headers de segurança em `vite.config.js`, `vercel.json`, `public/_headers`

### Segredos
- Removidos de `README.md` e `cron-alertas.http`
- `.env.example` documenta que service role nunca vai em `VITE_*`

---

## 7. Testes realizados

| Comando | Resultado |
|---|---|
| `npm run build` | OK |
| `npm audit` | 0 vulnerabilities |
| `npm run test:security` | 25 PASS / 1 FAIL |

Artefato: `security-pentest-results.json` (ignorado no Git).

---

## 8. Resultados do pentest (executados)

| ID | Objetivo | Esperado | Obtido | Status |
|---|---|---|---|---|
| T-VAL-01..05 | Validação / totais | rejeita inválidos | ok | APROVADO |
| T-AUTH-MSG | Anti-enumeração | mensagem genérica | ok | APROVADO |
| T-PASS-LEN | Senha ≥ 8 | 8 | 8 | APROVADO |
| T-SECRET-01/02 | Sem segredos no repo | limpo | limpo | APROVADO |
| T-DB-01..03 | Hardening no schema | presente | presente | APROVADO |
| T-EF-CODE-01..03 | Código da function | hardening | ok | APROVADO |
| T-API-01/02 | Anon lê bills/profiles | vazio | `[]` | APROVADO |
| T-API-03 | JWT inválido | 401/403 | 401 | APROVADO |
| T-API-04 | Insert alheio (anon) | 401/403 | 401 | APROVADO |
| T-API-05 | SQLi em filtro | sem vazamento | 403 | APROVADO |
| T-API-06 | RPC refresh como anon | bloqueado | **204** | **REPROVADO** |
| T-EF-01..03 | Function auth/método | bloqueio | 401/403 | APROVADO |
| T-AUTH-01 | Login inválido | erro | erro | APROVADO |
| T-XSS-01 | XSS em month_key | rejeitado | rejeitado | APROVADO |

### Não executados nesta rodada (faltam contas de teste / deploy)
- Usuário A lendo/alterando/excluindo faturas do usuário B (requer 2 sessões reais)
- Token expirado ponta a ponta (requer manipulação de JWT/`exp`)
- Deploy da function + reteste da mensagem `Não autorizado.`
- Idempotência concorrente real de alertas (não disparamos cron válido de propósito)

---

## 9. Vulnerabilidades ainda abertas

1. **A3 (ALTA)** — `refresh_overdue_bills` ainda executável por anon no remoto.
2. **C1 residual** — secret antigo no histórico Git; precisa rotação.
3. **C2 residual** — function hardenada não está deployada.
4. Isolamento A↔B não revalidado com dois usuários nesta sessão.
5. MFA não habilitado (depende do painel Auth).
6. Confirmação de e-mail / política de senha do GoTrue — conferir no painel.

---

## 10. Riscos residuais

- Comprometimento do `CRON_SECRET` atual (se não rotacionado) permite disparo massivo de e-mails e uso indireto de `service_role` na function.
- Anon JWT é pública por design; a segurança depende 100% de RLS + grants corretos.
- Sessão no `localStorage` é vulnerável a XSS futuro — mitigado parcialmente por CSP, mas qualquer bypass de CSP eleva o impacto.
- Rate limit da Edge Function é in-memory (reset em cold start); abuse fino ainda possível — use rate limit do provedor de cron + WAF se disponível.
- HSTS só via `vercel.json`; em outros hosts configure no CDN/proxy.

---

## 11. Configurações necessárias no Supabase (manual)

### A) Backup + migration
1. Table Editor → exportar CSV de `profiles`, `bills`, `alert_logs` (ou `pg_dump`).
2. SQL Editor → colar e executar `supabase/migrations/20261102_security_hardening.sql`.
3. Se algum CHECK falhar, corrigir a linha inválida e reexecutar o trecho.

### B) Rotacionar secrets
1. Gerar: `openssl rand -hex 32`
2. Edge Functions → Secrets → atualizar `CRON_SECRET`
3. Atualizar o mesmo valor no agendador (cron-job.org)
4. (Recomendado) rotacionar `RESEND_API_KEY` se já foi exposta em máquina compartilhada

### C) Deploy da function
```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase functions deploy send-due-alerts
```
Secret opcional: `ALLOWED_ORIGIN=https://seu-dominio.com`

### D) Auth (aplicado via `supabase config push` em 2026-11-02)
- Confirm email: ON
- Minimum password length: **8**
- Password requirements: `letters_digits`
- Site URL: `http://localhost:5173`
- Redirect URLs: `http://localhost:5173`, `http://127.0.0.1:5173`
- `secure_password_change`: ON
- MFA TOTP: já habilitado no projeto remoto
- Em domínio de produção, atualize Site URL / Redirect URLs para a URL pública

### E) Re-testar
```bash
npm run test:security
```
Esperado: T-API-06 passar após a migration.

---

## 12. Segredos que precisam ser rotacionados

| Segredo | Motivo |
|---|---|
| `CRON_SECRET` | Publicado em Git/README/HTTP |
| (avaliar) `RESEND_API_KEY` | Arquivos locais `.resend.secrets` — confirmar se nunca foram commitados |
| Service role | Não estava no frontend; rotacione só se houver suspeita de vazamento |

A `VITE_SUPABASE_ANON_KEY` **não** é secreta, mas não deve ser tratada como chave admin.

---

## 13. Checklist de publicação em produção

- [ ] Backup das 3 tabelas
- [ ] Aplicar migration `20261102_security_hardening.sql`
- [ ] Deploy `send-due-alerts`
- [ ] Rotacionar `CRON_SECRET` e atualizar cron
- [ ] Confirmar e-mail + senha ≥ 8 no Auth
- [ ] Configurar Redirect URLs de recovery
- [ ] Deploy do frontend com headers (`vercel.json` / `_headers`)
- [ ] HTTPS + HSTS no host
- [ ] `npm run build` e `npm run test:security` verdes
- [ ] Teste manual: dois usuários não veem faturas um do outro
- [ ] Teste manual: marcar paga / recovery de senha / logout
- [ ] Remover do agendador qualquer secret antigo

---

## Apêndice — arquivos tocados

- `supabase/functions/send-due-alerts/index.ts`
- `supabase/schema.sql`
- `supabase/migrations/20261102_security_hardening.sql`
- `supabase/cron-alertas.http`
- `src/lib/validation.js` (novo)
- `src/lib/bills.js`, `src/lib/profile.js`, `src/main.js`, `src/calculator.js`
- `index.html`, `vite.config.js`, `vercel.json`, `public/_headers`
- `scripts/security-pentest.mjs`, `package.json`, `README.md`, `.env.example`, `.gitignore`
