# Amalyzer

**Live:** <https://amalyzer.netlify.app> · **Repo:** <https://github.com/Wrexial/amalyzer>

A small, dependency-free TypeScript core for reading **Warcraft Logs** reports and
answering "who was doing damage in this N-second window, per fight, averaged over
a set of pulls".

It is a clean re-implementation of the log pipeline behind
[Augmentator3000/3001](https://github.com/Liroo/augmentator3000) (Prescience
planner for Augmentation Evokers), extracted so it can be reused as the base of
a different tool.

The original source was read with the author's permission, and is kept at
`.reference/augmentator3001/` for side-by-side comparison (gitignored). This
codebase is not a fork of it: no React, no Redux, no Ant Design, no Sentry, and
the WCL interaction is rewritten with variables, batching, retries and rate-limit
awareness.

## Quick start

```bash
npm install
cp .env.example .env        # fill in WCL_CLIENT_ID / WCL_CLIENT_SECRET

npm test                    # 19 unit tests, no network
npm run typecheck

npm run cli -- token
npm run cli -- meta https://www.warcraftlogs.com/reports/AbCdEfGh1234
npm run cli -- damage https://www.warcraftlogs.com/reports/AbCdEfGh1234 --fight last --slots 4
npm run cli -- damage <report> --encounter 2902 --fight all --json
npm run cli -- rankings Myalt tarren-mill EU --encounter 2902 --difficulty 5

npm run serve               # local web UI on http://127.0.0.1:3000
npm run dev                 # same, via `netlify dev` (function emulation)
```

Requires Node >= 22.6: the sources run directly via Node's type stripping, so
there is no build step and no runtime dependency.

Get credentials at <https://www.warcraftlogs.com/api/clients/> — create a client,
any redirect URL, then copy the ID/secret. The client-credentials grant only sees
public reports.

## Web UI and deployment

The browser app lives in `public/index.html`; the API is one framework-free
handler in `src/api.ts`, mounted two ways:

- **Local**: `npm run serve` — plain `node:http` server on `127.0.0.1:3000`.
- **Netlify**: `netlify/functions/api.ts` wraps the same handler; `netlify.toml`
  redirects `/api/*` to it and publishes `public/`.

Both are stateless: the client id/secret travel in `x-wcl-client-id` /
`x-wcl-client-secret` headers on every request, and the browser keeps them in
`sessionStorage` (tab-scoped, cleared on close). That is the only model that
works on serverless functions, where process memory disappears between
invocations. No secret is ever stored server-side.

| endpoint | body | notes |
|---|---|---|
| `POST /api/login` | `{clientId, clientSecret}` | validates the pair against WCL |
| `POST /api/meta` | `{report}` | fights + durations; requires credential headers |
| `POST /api/damage` | `{report, fight, windowMs, offsetMs, slots, ...}` | `AnalyzeResult`; requires credential headers |

```bash
npx netlify dev                 # http://localhost:8888, functions included
npx netlify deploy --build --prod
```

Netlify build runs `npm run build` (a typecheck) and bundles the function with
esbuild, so the `.ts` sources are compiled at deploy time.

The site (`amalyzer`, id `9357faa4-c93b-4862-98a7-c142afb0655b`) was created and
deployed from the CLI. To get push-to-deploy, connect the repo once in the
Netlify UI: **Project configuration → Build & deploy → Link repository** and pick
`Wrexial/amalyzer` (build `npm run build`, publish `public`). After that, every
push to `main` deploys.

## Pipeline

```
report URL/code
   │  parseReportInput()                      src/wcl/report.ts
   ▼
report + fights + actor table                 fetchReportMeta()
   │  (one GraphQL request)
   ▼
window grid for the fight                     buildWindows()        src/analysis/windows.ts
   │  [4000,26999] [27000,53999] [54000,80999] …
   ▼
damage per window, batched aliases            fetchDamageWindows()  src/wcl/queries.ts
   │  20 `table(...)` fields per request
   ▼
sum/average per actor per window index        aggregateDamage()     src/analysis/aggregate.ts
   │
   ▼
ordered target list per window                buildAssignments()    src/analysis/rank.ts
```

`node src/cli.ts damage …` is the end-to-end path; `--json` emits the whole
intermediate structure if you want to feed a UI.

## How the logs are fetched

### Auth

`POST https://www.warcraftlogs.com/oauth/token` with HTTP Basic
(`base64(clientId:clientSecret)`) and `{"grant_type":"client_credentials"}`.
The bearer token is good for ~1h; `WCLClient` caches it, refreshes 60s early, and
retries once on 401.

Everything else is a single GraphQL endpoint:
`https://www.warcraftlogs.com/api/v2/client`.

### Report metadata

One query gets the report, all fights and the actor table:

- `report.fights` — `startTime`/`endTime` are **relative to report start**, and
  `encounterID === 0` marks trash. `friendlyPlayers` is a list of **actor ids**,
  not names.
- `report.masterData.actors` — id → name/type/server for players, pets and NPCs.
  This is the reliable name source for damage table entries.
- `report.playerDetails(startTime: 0, endTime: 2147483647)` — JSON scalar, so
  it is selected with **no** sub-selection (a `{ data }` block is a GraphQL
  error). Its value is `{ data: { playerDetails: { tanks, healers, dps } } }`,
  used for "is this a player and what realm". The max-int end time is required;
  WCL rejects open-ended ranges here.

`playerDetails` ids and `table.entries[].id` are the same actor ids. WCL may
serialise one side as a string, so the code normalises with `Number(...)` before
joining — the original compared them with `===` and got away with it.

### Damage per time slice

Two ways to get damage; this project uses tables:

| | `table(...)` | `events(...)` |
|---|---|---|
| shape | per-actor aggregate | raw per-event rows |
| cost | one internal query per table | one query, but 10k-event page cap |
| fits our use | yes: N small windows | needs pagination + client-side bucketing |

A window query looks like this (aliases are generated, timestamps are inlined —
GraphQL cannot alias from a variable):

```graphql
query DamageWindows($code: String!, $fightId: Int!, $filter: String) {
  reportData {
    report(code: $code) {
      fights(fightIDs: [$fightId]) { id startTime endTime }
      w0: table(fightIDs: [$fightId], startTime: 504000, endTime: 530999,
                dataType: DamageDone, filterExpression: $filter)
      # w1: … w19: …
    }
  }
}
```

Notes that matter:

- `table` is a **JSON scalar** too, so the alias has no sub-selection. Each value
  comes back as `{ data: { total, entries: [{ id, total }] } }`.
- `startTime`/`endTime` are **absolute report time**, i.e. `fight.startTime + offset`.
- `endTime` is inclusive, hence `-1` on the window end.
- `filterExpression` is applied server-side. `src/wcl/filters.ts` carries over the
  "does not scale with our buffs" ability lists, so trinkets and flat-damage
  procs don't win the ranking. Use `--filter none` to disable.
- Batching 20 windows per request keeps each request cheap; a 10-minute fight is
  ~23 windows at the 27s default → 2 requests instead of 100.
- Rate limiting is point-based per hour (`x-ratelimit-*` headers). `WCLClient`
  exposes `lastRateLimit`, retries 429 using `Retry-After`, and optionally
  throttles to a minimum gap between requests.

## The window algorithm

Defaults: 27 000 ms windows, 4000 ms offset.

```
[0, 4000)      ignored (pull, first casts)
[4000, 26999]  window 0  ← clipped to 23s
[27000, 53999] window 1
[54000, 80999] window 2
…
```

Why 27s: wide enough to smooth out cooldown/proc noise, short enough to still
move between boss phases. Pass `--window 6000` for the original tool's Ebon
Might tick cadence. Why the 4s offset: the first useful buff lands a few seconds
into the pull.

The grid stays anchored to fight start — window *n* always begins at
`n * 27000` — so the same index means the same moment of the fight across pulls.
Only window 0 is clipped. `buildWindows()` reproduces the original
`generateTimeRanges()` exactly at `sizeMs: 6000` (unit-tested), and
`toReportTime()` shifts the grid into absolute time for the query.

## Aggregation semantics

`aggregateDamage()` is where the original's behaviour is encoded, and it is
subtle enough to state explicitly:

- A window where an actor did **zero** damage is dropped, not averaged in — dead
  players and intermissions would otherwise poison the ranking.
- `average = total / contributingWindows`, not `total / fightCount`.
- Results are keyed by window **index**, so fights of different lengths line up.
- Unknown actor ids (unassigned pets, NPCs missing from `masterData`) are dropped.

`buildAssignments()` then applies exclusion, then forced picks in the given
order, then damage order, and returns `slots` targets per window.

## The "best logs" path

Instead of asking the user for report URLs, you can find good kills yourself:

1. `characterData.character.encounterRankings(encounterID, difficulty, specName,
   partition)` — again a JSON scalar, no sub-selection. Returns `ranks[]`, each
   with `report.code`, `report.fightID`, `startTime` (absolute) and `duration`.
2. Fetch that report's fights and use `rank.startTime - report.startTime` to get
   the fight offset.

`src/wcl/rankings.ts` implements this; `rankings` in the CLI prints the top 10
(report, fight) pairs.

Note that ranking data is per-spec and per-partition, and `specName` matters for
classes with multiple roles (e.g. Feral/Guardian).

## Differences from the original implementation

- Queries use GraphQL **variables** for report code, fight id and filter instead
  of interpolating strings.
- Windows are **batched**; the original issued one giant query with every table
  alias at once.
- Token caching, 401 refresh, 429/5xx backoff and optional request throttling.
- Actor ids normalised before joining; `masterData.actors` used as the primary
  name source.
- No UI, no state management, no analytics/Sentry. Plain functions you can call
  from a server route, a worker or a UI.

## Extending it

- **Other buffs**: replace `buildWindows` cadence and the assignment rule. The
  WCL side is buff-agnostic.
- **Buff uptime / casts**: switch `dataType` to `Casts` or query
  `events(dataType: Buffs, abilityID: …)`; same window slicing applies.
- **Server-side keys**: move `WCLClient` behind your own route and hand it a
  token, rather than shipping a client secret to the browser. The original asks
  each user for their own key instead, which is the alternative.
- **Caching**: window tables are immutable per (report, fight, window), so a
  simple key-value cache makes repeat views nearly free.
