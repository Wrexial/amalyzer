# Amalyzer

**Live:** <https://amalyzer.netlify.app> · **Repo:** <https://github.com/Wrexial/amalyzer>

A small, dependency-free TypeScript core for reading **Warcraft Logs** reports and
answering "who was doing damage during each Prescience window, per fight,
averaged over a set of pulls".

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

npm test                    # unit tests, no network
npm run typecheck

npm run cli -- token
npm run cli -- meta https://www.warcraftlogs.com/reports/AbCdEfGh1234
npm run cli -- damage https://www.warcraftlogs.com/reports/AbCdEfGh1234 --fight last --slots 4
npm run cli -- damage <report> --window-mode fixed --window 27000 --offset 4000
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
| `POST /api/damage` | `{report, fight, windowMode, prescienceDurationMs, slots, excludeAugmentation, ...}` | `AnalyzeResult`; requires credential headers |

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
window grid for the fight                     buildPrescienceWindows()  src/analysis/windows.ts
   │  one measured buff window per Prescience cast
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
- Batching 20 windows per request keeps each request cheap; Prescience is cast
  roughly every 6s, so a 10-minute fight is ~100 windows → 5 requests.
- Rate limiting is point-based per hour (`x-ratelimit-*` headers). `WCLClient`
  exposes `lastRateLimit`, retries 429 using `Retry-After`, and optionally
  throttles to a minimum gap between requests.

## Damage windows

By default each **Prescience cast** opens a window that lasts as long as the aura
actually lasted in the log: `applybuff` starts it, `removebuff` ends it (death,
dispel, or normal expiry). A `refreshbuff` starts a new window but shares the
aura's end, since the target never stopped being buffed. The fallback duration is
only used when the removal is missing from the log.

```
Prescience cast @ 0:04, aura removed @ 0:22  -> [0:04, 0:22)
Prescience cast @ 0:10, refreshed @ 0:16, removed @ 0:28 -> [0:10, 0:28)
```

Windows overlap when casts are closer together than the aura lasts (the usual
case: ~6s cadence, 18s+ buff). Each row is an independent "what did the raid do
while this cast's buff was up" measurement, clipped to the fight end.

How it is built:

1. `fetchPrescienceCasts()` asks WCL for `events(dataType: Casts,
   abilityID: 409311)`; `fetchPrescienceBuffEvents()` fetches the aura events
   (`applybuff`, `refreshbuff`, `removebuff`) for 410089.
   `buildPrescienceApplications()` turns those into intervals with real end
   times. WCL copies/applies Prescience to pets as well (Akaari's Soul, ghouls,
   …), so only applications on **player** actors are kept — pet buffs have
   short, noisy lifetimes.
   `matchPrescienceRecipients()` then pairs each cast with the nearest player
   application from the same caster. This also resolves enemy-targeted casts:
   the cast event often records the boss the Evoker had selected, while the aura
   event is the actual recipient. Ally-targeted casts keep their logged target.
2. `buildPrescienceWindows()` uses each cast's measured aura end (falling back
   to `prescienceDurationMs` when there is no removal), clips to the fight, and
   uses the **cast ordinal** as the window index. Window N is the Nth Prescience
   of every pull.
3. There is no start offset: the first window begins at the first cast.

The first column renders that as `#N - start - end - duration`, e.g.
`#2 - 0:09 - 0:28 - 18.4s`.

`prescienceDurationMs` (default 18 000 ms, UI "Fallback buff (ms)",
`--prescience-duration`) is only a fallback for missing removal events.

The old clock grid is still available as `windowMode: 'fixed'`: 27 000 ms
windows, 4000 ms offset, anchored to fight start (`buildWindows()` reproduces
the original `generateTimeRanges()` at `sizeMs: 6000`). Pass
`--window-mode fixed` (or just `--window`/`--offset`).

If no casts are found in any selected fight (no Augmentation Evoker was logged),
the analysis falls back to the fixed grid and reports `windowModeFallback`.

Windows for different fights no longer share timestamps, so each fight gets its
own list; `aggregateDamage()` still merges by index. `toReportTime()` shifts the
per-fight list into absolute time for the `table` query.

## Aggregation semantics

`aggregateDamage()` is where the original's behaviour is encoded, and it is
subtle enough to state explicitly:

- A window where an actor did **zero** damage is dropped, not averaged in — dead
  players and intermissions would otherwise poison the ranking.
- `average = total / contributingWindows`, not `total / fightCount`.
- Results are keyed by window **index** — the cast ordinal in Prescience mode —
  so the same row means the same Prescience across pulls (and the same grid slot
  in fixed mode).
- Unknown actor ids (unassigned pets, NPCs missing from `masterData`) are dropped.

`buildAssignments()` then applies exclusion, then forced picks in the given
order, then damage order, and returns `slots` targets per window.

### Display

The UI groups window rows by fight phase. WCL documents
`phaseTransitions[].startTime` as **report-relative**, so `fightPhases()`
subtracts the fight start and feeds the fight-relative grid; the longest selected
fight supplies the boundaries, since it is also the fight the window grid is cut
from. When WCL omits the transition into phase 1, a boundary at 0 is synthesised.

Player names are coloured with the WoW class colour and prefixed with the class
icon from Wowhead's icon CDN (`classicon_<class>.jpg`). Icons fail soft: the
image removes itself on error and the coloured name remains.

The **DPS / Damage** segmented control switches the table between `dps`
(normalised by window length) and `average` (raw expected damage inside the
window). Both are already in `AnalyzeResult`, so toggling never re-queries WCL.

The **Hide Augmentation Evokers** checkbox is applied after analysis too: the
client-side filter drops those entries from the rendered result and refills
each window's slots from the remaining entries. Scripts can instead exclude them
during analysis with `excludeAugmentation` / `--exclude-augmentation`, which
removes them *before* `buildAssignments()` runs.

Each window also knows the actor its Prescience was cast on (`castTarget`,
resolved from the aura recipient). The UI outlines that player's card wherever
they rank by damage; they are **not** forced into a slot any more, so the top N
picks stay purely damage-ordered and the buffed target is easy to spot when
they fall outside them. Aggregated rows use the longest selected fight's target
for that cast ordinal. The CLI marks these players with `^`.

When the raw cast target was an enemy/NPC (`castEnemyTarget`), the window cell
shows an **enemy target** badge and the row is tinted; the buff is still
attributed to the aura recipient, never the enemy. Casts without a matching
buff event fall back to the raw target only when that target is a player.

Each row is horizontally scrollable and lists **every player**: pet/summon
damage is credited to its owner via `masterData.actors[].petOwner`, and pet
buff events are ignored. The selected targets come first, then faded non-picks. A `buffed targets` select filters
the row to players who already had Prescience when the cast happened (`buffed`,
back-checked from the aura intervals), or hides them. **Hide previously buffed**
keeps the current cast target visible: it is the buff being evaluated, not a
leftover from an earlier cast. Back-checking uses the resolved recipients, so
enemy-targeted casts are handled too.

Below the cards each Prescience row shows `Buffed <target>: X · Best unbuffed
<name>: Y` (plus the delta) so the value of the current buff can be compared
directly with the best alternative that was not buffed at that moment.

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
- Windows default to the log's real **Prescience casts** instead of a fixed 6s
  grid; the fixed grid is still selectable.
- A dependency-free UI (`public/index.html`) with phase grouping, class colours
  and icons; the core stays plain functions you can call from a server route, a
  worker or another UI. No state management, no analytics/Sentry.

## Extending it

- **Other buffs**: change `PRESCIENCE_CAST_ID` / `prescienceDurationMs` and the
  assignment rule; window building is otherwise buff-agnostic.
- **Actual aura uptime**: switch the events query to `dataType: Buffs` with
  `PRESCIENCE_BUFF_ID` (410089) to slice by apply/refresh events instead of casts.
- **Server-side keys**: move `WCLClient` behind your own route and hand it a
  token, rather than shipping a client secret to the browser. The original asks
  each user for their own key instead, which is the alternative.
- **Caching**: window tables are immutable per (report, fight, window), so a
  simple key-value cache makes repeat views nearly free.
