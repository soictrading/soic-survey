# SOIC Sales Flow Survey

An AI interviewer that records, step by step, exactly what each SOIC sales/sourcing team member does in two situations:

1. **A load becomes available** (a supplier or mill has material to sell).
2. **A buyer needs a load.**

Each person chooses English or Spanish and does both parts. For each part the interviewer first asks for their process
in their own words, then drills into every step (tools, information, people, pricing inputs, samples, waiting). When
the part is covered, the conversation is turned into a step-by-step write-up that the person corrects and confirms.
The owner (ADMIN_EMAILS) sees everyone's progress, write-ups, notes and full transcripts. Nobody else sees anyone
else's interview.

Cloudflare Worker (API + web page) with a D1 database, protected by Cloudflare Access, using the Anthropic API.
Separate from the SOIC CRM: its own repository, Worker, database and Access application.

## How it fits together

- `src/worker/` — the Worker. Serves `/api/*` and the built web page.
  - `auth.ts` — verifies the Cloudflare Access token on every API request (same checks as the CRM).
  - `interviews.ts` — the interview state and its rules.
  - `prompts.ts` — the interviewer's instructions and the write-up request. Built on the server only; the browser
    sends nothing but the person's answers, so nobody can change the instructions or use the key for anything else.
  - `model.ts` — the Anthropic API call (timeout, one retry for overload/outage, no retry for rate limits).
- `src/web/` — the web page (plain TypeScript), built by Vite into `dist/client`.
- `src/shared/` — types and limits used by both.
- `migrations/` — D1 schema migrations, applied in order.
- `test/` — tests that run inside the Workers runtime against a real D1 database. The language model is replaced by
  a stand-in, so tests never call Anthropic.

**Who can do what.**

| Who | Can |
|---|---|
| Anyone the Access policy lets in | Take their own interview and correct their own write-ups |
| Emails in `ADMIN_EMAILS` | The above, plus read everyone's interviews (read-only) |

A person is identified only by the email in their verified Access token. There is no route that takes another
person's email except the admin's read-only ones.

**Interview states (per part).** `not_started` → `interviewing` → `finished` (the interviewer or the person ends it) →
`review` (write-up created) → `confirmed`. A confirmed part can be reopened to `review`.

**Limits.** Answers up to 8,000 characters; 150 answers per part; write-up edits are size-checked. These bound the
API cost a single person can cause.

**Cost.** Every answer is one Anthropic API call that includes the whole conversation of that part so far, plus one
larger call per write-up. The model is set by `ANTHROPIC_MODEL` in `wrangler.jsonc`.

**Logging.** Workers Logs record each model call's duration and token counts, and every error, with a request id.
Interview content and the API key are never logged.

**Environments.** `wrangler.jsonc` defines two:

| Environment | Hostname | Database | Identity |
|---|---|---|---|
| development (top level) | `localhost` only | local D1 | `DEV_USER_EMAIL` from `.dev.vars` |
| production | `survey.soictrading.online` | `soic-survey-production` | Cloudflare Access |

There is no staging copy: this tool deploys straight to production (Mike, 2026-10-12). `workers.dev` and preview
URLs are disabled so Access cannot be bypassed. The Worker refuses to run while the Access settings are missing or
still placeholders.

## Requirements

- Node.js 22 or later
- npm: `npm ci` works with npm 10 or 11. To **add or upgrade** dependencies use npm 11 (`npx npm@11 install ...`).

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars      # set DEV_USER_EMAIL; ANTHROPIC_API_KEY only if you want the interviewer locally
npm run db:migrate:local
npm run build
npm run dev:api                     # API + built web page on http://localhost:8787
```

Run every check (types, lint, tests, build):

```sh
npm run check
```

## Deployment runbook

Do these steps in order.

### 1. GitHub

1. Create an empty **private** repository `soictrading/soic-survey` (no README, no licence, no .gitignore).
2. In this folder:
   ```sh
   git remote add origin https://github.com/soictrading/soic-survey.git
   git push -u origin main
   ```

### 2. Install and log in to Cloudflare

```sh
npm ci
unset CLOUDFLARE_API_TOKEN
npx wrangler login
```

### 3. Create the database

```sh
npx wrangler d1 create soic-survey-production
```

Copy the `database_id` it prints into `wrangler.jsonc` → `env.production.d1_databases[0].database_id`.

### 4. Create the Access application (before the first deploy)

In the Cloudflare dashboard → **Zero Trust** → **Access → Applications → Add an application → Self-hosted**:

- Application domain: `survey.soictrading.online`
- Identity providers: One-time PIN
- Policy: action **Allow**, include **Emails ending in** `@soictrading.com` (the same policy as the CRM)

Save, then open the application and copy its **Application Audience (AUD) Tag** into `wrangler.jsonc` →
`env.production.vars.ACCESS_AUD`. The team domain is already filled in (the same one the CRM uses). These values are
identifiers, not secrets. Commit the updated `wrangler.jsonc`.

### 5. Apply the schema

```sh
npx wrangler d1 migrations apply DB --env production --remote
```

### 6. Store the Anthropic API key as a secret

```sh
npx wrangler secret put ANTHROPIC_API_KEY --env production
```

Paste the key when asked. It is stored encrypted in Cloudflare and never appears in this repository, the browser or
the logs. Never paste it anywhere else.

### 7. Deploy

```sh
npm run deploy:production
```

This runs every check first. On the first deploy Cloudflare creates the `survey.soictrading.online` DNS record.

### 8. Test before sharing the link

1. Open `https://survey.soictrading.online`. You should get the Cloudflare Access login.
2. Sign in with `mike.chartrand@soictrading.com`. You should see **Sales flow interviews** with no one listed.
3. Press **Take the interview yourself**, choose a language and press **Start**. The interviewer's first question
   should appear within a few seconds. Answer a few questions, then use **I've covered everything for this part**.
4. Check the write-up appears, edit a step, reload the page (the edit should still be there) and confirm.
5. Go back to **All interviews**: you should see yourself with Part 1 confirmed, and the transcript under your name.
6. Sign in from another browser with a different `@soictrading.com` address: that person must see only the language
   choice (not your interview), and must not be able to open the overview.

Your own test interview stays in the overview. To remove it before the team starts:

```sh
npx wrangler d1 execute DB --env production --remote --command "DELETE FROM interview_messages WHERE email = 'mike.chartrand@soictrading.com'; DELETE FROM interview_parts WHERE email = 'mike.chartrand@soictrading.com'; DELETE FROM interviews WHERE email = 'mike.chartrand@soictrading.com';"
```

### Updating later

When a release adds a file to `migrations/`, apply it **before** deploying the code that needs it:

```sh
unset CLOUDFLARE_API_TOKEN            # in every new Terminal window
npx wrangler d1 migrations list DB --env production --remote    # shows what will be applied
npx wrangler d1 migrations apply DB --env production --remote
npm run deploy:production
```
