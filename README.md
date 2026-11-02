# Âmbar Energia — Calculadora multi-cliente

App web com login de clientes (Supabase Auth), histórico de faturas no Postgres, status **paga / pendente / vencida** e alerta por **e-mail** via Resend (Edge Function).

## Stack
- Vite + JavaScript
- Supabase (Auth, Postgres, RLS, Edge Functions)
- Resend (e-mail)

## 1. Instalar e rodar

```bash
npm install
cp .env.example .env
```

Preencha no `.env`:

```env
VITE_SUPABASE_URL=https://SEU_PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua_anon_key
```

```bash
npm run dev
```

Abre em `http://localhost:5173`.

## 2. Banco de dados (Supabase)

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Abra **SQL Editor**
3. **Projeto novo:** execute [`supabase/schema.sql`](supabase/schema.sql)
4. **Projeto existente:** faça backup de `profiles`, `bills` e `alert_logs`, depois execute [`supabase/migrations/20261102_security_hardening.sql`](supabase/migrations/20261102_security_hardening.sql)

Isso cria/atualiza:
- `profiles` (nome + telefone)
- `bills` (faturas mensais + status + vencimento + constraints)
- `alert_logs` (histórico de alertas + idempotência)
- RLS por usuário
- trigger de integridade financeira (recalcula totais no servidor)
- trigger de perfil no cadastro

## 3. Auth (painel Supabase)

Em **Authentication → Providers**:
- habilite e-mail/senha
- defina política de senha forte (mín. 8 caracteres no app; alinhe no Auth settings)
- em produção, mantenha **Confirm email** habilitado
- em **Attack Protection**, mantenha rate limiting / CAPTCHA se disponível
- (opcional) habilite MFA (TOTP)

Configure **URL Configuration** com a URL do app para recovery de senha.

## 4. Alerta por e-mail (Resend)

### Segredos no Supabase
**Project Settings → Edge Functions → Secrets** (nunca versionar valores reais):

```text
RESEND_API_KEY=<sua_chave_resend>
RESEND_FROM=Ambar Energia <onboarding@resend.dev>
CRON_SECRET=<gere_com_openssl_rand_-hex_32>
ALLOWED_ORIGIN=https://seu-dominio.com
```

> Se `CRON_SECRET` já apareceu em Git/README/HTTP, considere-o **comprometido** e **rotacione** imediatamente.

### Deploy da function

```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase functions deploy send-due-alerts
```

### Cron automático a cada 8 horas

Agende POST a cada 8 horas (cron-job.org, EasyCron, etc.):

1. **URL:** `https://SEU_PROJETO.supabase.co/functions/v1/send-due-alerts`
2. **Method:** POST
3. **Headers:**
   - `Authorization: Bearer <ANON_KEY>`
   - `apikey: <ANON_KEY>`
   - `x-cron-secret: <CRON_SECRET>`
   - `Content-Type: application/json`
4. **Body:** `{"days_ahead":30}` (`days_ahead` é limitado a 1–60 no servidor)

Modelo sem segredos: [`supabase/cron-alertas.http`](supabase/cron-alertas.http).

## 5. Segurança

Veja o relatório completo em [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md).

Scripts:

```bash
npm run build
npm audit
npm run test:security
npm run test:smoke
```

Auth remoto (senha ≥ 8, confirm email, redirect `localhost:5173`) fica em [`supabase/config.toml`](supabase/config.toml) e foi aplicado com `npx supabase config push`.

## 6. Uso no app

1. Cadastre/entre com e-mail e senha (mín. 8 caracteres)
2. Use **Esqueci a senha** se necessário
3. Salve **nome** e **telefone** no perfil
4. Calcule e salve a fatura do mês
5. Enquanto estiver **pendente/vencida**, o sistema alerta por e-mail a cada 8h
6. Clique em **Marcar como paga** para parar os alertas

## Scripts

- `npm run dev` — desenvolvimento (com headers de segurança)
- `npm run build` — build de produção
- `npm run preview` — preview do build
- `npm run test:security` — pentest controlado / checks automatizados
