# AccessibilityOS

AccessibilityOS is a local, evidence-first accessibility scanner and journey debugger. It uses Playwright and axe-core on public HTTPS sites and a controlled fixture, stores results in PostgreSQL, and displays findings, screenshots, focus transitions, journey step results, historical scan trends, and downloadable JSON/HTML reports in a Next.js dashboard. Automated checks do not prove WCAG compliance.

## Requirements

Docker Desktop. For development without the app containers, install Node.js 20.9+, Corepack/pnpm 10, and Playwright Chromium.

## Run the app with Docker

```powershell
docker desktop start
docker compose up -d --build
```

Open **http://localhost:3000**. Compose starts the web app, API, browser worker, PostgreSQL, and Redis; it applies migrations and seeds a controlled test project automatically. The first build downloads Chromium and can take several minutes. To scan another site, enter a project name and its public `https://` URL, create the project, choose the page and link-depth limits, then select **Start scan**. The scan follows same-origin links and sitemap entries (8 pages and depth 2 by default, configurable up to 100 pages and depth 6) and loads bounded public HTTPS assets for styling. Run `docker compose ps` to check services and `docker compose logs -f worker` to inspect scans. Stop the app with `docker compose down`; database and screenshot volumes persist.

To scan pages behind a login, set `AOS_JOURNEY_USERNAME` and `AOS_JOURNEY_PASSWORD` in a local `.env` file and restart the worker with `docker compose up -d --force-recreate worker`. In Journey Studio, create a journey that navigates to the login page, uses `fillSecret` for the Username and Password textboxes, clicks the sign-in button, verifies a signed-in element with `assertVisible`, then runs `saveSession`. You can add `audit` steps after interactions to check the page state at that point. A successful run stores encrypted browser cookies and origin storage for that project; later journeys and scans reuse them. Clear the saved session in Journey Studio when it expires or is no longer needed. Use a test account. The app currently has no user authentication, so keep it local.

The project list supports search and five-project pages. **Delete** removes a project and its saved scans, journeys, and screenshots after confirmation; active scans or journeys must finish first.

## Run locally for development

```powershell
corepack pnpm install
Copy-Item .env.example .env
docker compose up -d postgres redis
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm browser:install
corepack pnpm dev
```

Open http://127.0.0.1:3000. The seeded project scans the controlled fixture at http://127.0.0.1:3000/fixture.html. The API runs on port 4000 and serves OpenAPI UI at http://127.0.0.1:4000/documentation.

The development commands start the web, API, and worker on the host. Stop infrastructure with `docker compose down`. PostgreSQL data persists in Docker volumes. `docker compose down -v` removes those volumes.

## Verify

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
docker compose ps
```

For CI scans and baseline comparison, run `corepack pnpm scan:ci --help`.

## Current limits

The scanner and journey engine accept public HTTPS sites and the configured fixture origin. Discovery is capped at 100 pages and cannot enumerate every route or interaction. Journey steps are limited to 20 per run and currently support navigation, clicks, form controls, keyboard focus, visibility checks, and axe audits. Session reuse captures cookies, local storage, and IndexedDB; sign-in systems that depend on session storage, cross-origin identity providers, or multifactor prompts need another approach. Focus transitions and axe findings are evidence, not a complete WCAG assessment; manual review remains necessary. Tenant isolation, retention, and production network isolation are future work. Keep the unauthenticated API local.
