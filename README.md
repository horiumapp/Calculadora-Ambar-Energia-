# Âmbar Energia — Calculadora multi-cliente

App web com login de clientes (Supabase Auth), histórico de faturas no Postgres, status **paga / pendente / vencida** e alerta SMS de vencimento via **Twilio** (Edge Function).

## Stack
- Vite + JavaScript
- Supabase (Auth, Postgres, RLS, Edge Functions)
- Twilio SMS

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
3. Execute o arquivo [`supabase/schema.sql`](supabase/schema.sql)

Isso cria:
- `profiles` (nome + telefone)
- `bills` (faturas mensais + status + vencimento)
- `alert_logs` (histórico de SMS)
- RLS por usuário
- trigger de perfil no cadastro

## 3. Auth

No painel Supabase → **Authentication**:
- habilite e-mail/senha
- (opcional) desative confirmação de e-mail em desenvolvimento

## 4. Alerta por e-mail (Resend — gratuito)

### Criar conta Resend
1. Acesse [resend.com](https://resend.com) e crie conta grátis
2. Em **API Keys**, crie uma key e copie
3. (Opcional) Em **Domains**, valide seu domínio para enviar a qualquer e-mail  
   - Sem domínio, o remetente de teste `onboarding@resend.dev` só envia para o e-mail da sua conta Resend

### Segredos no Supabase
**Project Settings → Edge Functions → Secrets**:

```text
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM=Ambar Energia <onboarding@resend.dev>
CRON_SECRET=1aae7ab70c40ae472837072a6f6e793ad7df01f206deb032
```

Com domínio verificado, use por exemplo: `RESEND_FROM=Ambar Energia <alerta@seudominio.com>`

### Deploy da function

```bash
npx supabase login
npx supabase link --project-ref jhsslpacvefgthpczgcy
npx supabase functions deploy send-due-alerts
```

### Cron automático a cada 8 horas

Os alertas **não** são enviados pelo cliente na tela. O sistema envia sozinho por e-mail.

Agende a cada 8 horas em [console.cron-job.org/jobs/create](https://console.cron-job.org/jobs/create) (crie conta em [signup](https://console.cron-job.org/signup) se ainda não tiver):

1. **URL:** `https://jhsslpacvefgthpczgcy.supabase.co/functions/v1/send-due-alerts`
2. **Method:** POST
3. **Schedule:** every 8 hours
4. **Headers:**
   - `Authorization: Bearer <VITE_SUPABASE_ANON_KEY>`
   - `apikey: <VITE_SUPABASE_ANON_KEY>`
   - `x-cron-secret: 1aae7ab70c40ae472837072a6f6e793ad7df01f206deb032`
   - `Content-Type: application/json`
5. **Body:** `{"days_ahead":30}`

Modelo pronto em [`supabase/cron-alertas.http`](supabase/cron-alertas.http).

A function:
- só processa faturas `pending` / `overdue` (pagas são ignoradas)
- envia e-mail para o e-mail de login do cliente
- respeita intervalo de **8 horas** entre alertas da mesma fatura
- para automaticamente quando o status vira `paid`

## 5. Uso no app

1. Cadastre/entre com e-mail e senha
2. Salve **nome** (e telefone, se quiser) no perfil
3. Calcule e salve a fatura do mês
4. Enquanto estiver **pendente/vencida**, o sistema alerta por e-mail sozinho a cada 8h
5. Clique em **Marcar como paga** para parar os alertas
6. Acompanhe o dashboard

## Scripts

- `npm run dev` — desenvolvimento
- `npm run build` — build de produção
- `npm run preview` — preview do build

## Observações

- E-mail automático usa Resend (plano gratuito)
- Sem `.env` válido, o app mostra a tela de configuração
- Cada cliente só vê as próprias faturas (RLS)
