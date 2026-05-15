# BoardBI

A self-hosted, Power BI–style dashboard app for JIRA. Connect a JIRA Cloud site, define reports as JQL queries, drop gadgets onto a canvas, configure aggregations, and slice the data with date / multi-select / single-select / text filters.

Local-first SQLite via Prisma; designed to swap to Postgres without code changes.

For architecture, conventions, and gotchas, see [`CLAUDE.md`](./CLAUDE.md).

---

## First-time setup

These steps assume a clean Windows machine with nothing installed.

### 1. Install prerequisites

- **Node.js 20.x LTS or newer** — https://nodejs.org/en/download. Verify in a new PowerShell window:
  ```
  node --version
  npm --version
  ```
- **Git** — https://git-scm.com/download/win. Verify with `git --version`.

### 2. Clone the repo

```
git clone https://github.com/onkulkarni/BoardBI.git
cd BoardBI
```

### 3. Install dependencies (root + server)

The repo has two separate `package.json` files (frontend at the root, backend in `server/`). Each needs its own install:

```
npm install
npm --prefix server install
```

### 4. Create the server `.env` file

```
copy server\.env.example server\.env
```

Open `server\.env` and fill in **`APP_ENCRYPTION_KEY`** — the server will not boot without it. Generate one with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output as the value (e.g. `APP_ENCRYPTION_KEY=abc123...=`).

Optional in the same file:

- `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — only needed for the AI dashboard generator. Leave blank otherwise; the server still boots.
- `PORT`, `DATABASE_URL`, `JIRA_USER_AGENT`, model names — defaults are fine.

> **Heads up:** rotating `APP_ENCRYPTION_KEY` later will make any JIRA connection tokens already stored in the DB unreadable. Generate it once and keep it.

### 5. Create the SQLite database + Prisma client

```
npm run db:migrate
```

This applies `server/prisma/schema.prisma`, creates `server/prisma/dev.db`, and generates the Prisma client.

### 6. Run the app

```
npm run dev
```

This launches both processes concurrently:

- **Web** (Vite) → http://localhost:5173 ← open this in your browser
- **API** (Express) → http://localhost:3001 (Vite proxies `/api/*` to it)

### 7. First-run inside the app

1. Open http://localhost:5173 → **Connections** page.
2. Add a JIRA connection: site URL (e.g. `https://your-site.atlassian.net`), email, and an API token from https://id.atlassian.com/manage-profile/security/api-tokens. Click **Test** before saving.
3. Go to **Reports** → **New report**, pick the connection, write or build a JQL, save. Open the report, add gadgets and slicers, and refresh data.

---

## Handy commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Web (Vite :5173) + API (Express :3001) with hot reload |
| `npm run db:migrate` | Re-apply Prisma migrations |
| `npm run db:studio` | Prisma Studio GUI on http://localhost:5555 |
| `npx vite build` | Type-check + bundle the frontend |
| `npm --prefix server run build` | Type-check the server |
