/**
 * Amalyzer CLI.
 *
 *   node --env-file-if-exists=.env src/cli.ts token
 *   node --env-file-if-exists=.env src/cli.ts meta <report-url-or-code>
 *   node --env-file-if-exists=.env src/cli.ts damage <report-url-or-code> [flags]
 *   node --env-file-if-exists=.env src/cli.ts rankings <name> <serverSlug> <region> [flags]
 */

import { analyzeReport } from './analysis/analyze.ts';
import { WCLClient } from './wcl/client.ts';
import { fetchEncounterRankings, rankToFightRefs } from './wcl/rankings.ts';
import { fetchReportMeta, parseReportInput, selectFights } from './wcl/report.ts';

type Flags = Record<string, string | boolean>;

function parseArgv(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[key!] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      flags[key!] = argv[i + 1]!;
      i += 1;
    } else {
      flags[key!] = true;
    }
  }

  return { positional, flags };
}

function numFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function strFlag(flags: Flags, name: string): string | undefined {
  const raw = flags[name];
  return typeof raw === 'string' ? raw : undefined;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** `m:ss` — report times are all relative to the pull. */
function clock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function makeClient(): WCLClient {
  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      'Missing WCL_CLIENT_ID / WCL_CLIENT_SECRET.\n' +
        'Create a client at https://www.warcraftlogs.com/api/clients/ then copy .env.example to .env.',
    );
    process.exit(1);
  }

  return new WCLClient({
    credentials: { clientId, clientSecret },
    minRequestIntervalMs: 120,
  });
}

async function commandToken(client: WCLClient) {
  const token = await client.getToken(true);
  console.log(`✓ credentials valid (token ${token.slice(0, 8)}…, ${token.length} chars)`);
}

async function commandMeta(client: WCLClient, input: string, flags: Flags) {
  const { code } = parseReportInput(input);
  const meta = await fetchReportMeta(client, code);
  const encounterFilter = flags.encounter ? numFlag(flags, 'encounter', 0) : undefined;

  console.log(`${meta.title}  [${meta.code}]  ${meta.region.slug}  zone: ${meta.zone?.name ?? '?'}`);
  console.log(`${meta.fights.length} fights, ${meta.players.length} players\n`);

  for (const fight of selectFights(meta, encounterFilter)) {
    const duration = clock(fight.endTime - fight.startTime);
    const tag = fight.kill ? 'KILL' : `${Math.round(fight.fightPercentage ?? 0)}%`;
    console.log(
      `  #${String(fight.id).padStart(3)}  ${tag.padEnd(5)}  ${duration.padStart(6)}  ` +
        `enc ${fight.encounterID} diff ${fight.difficulty}  ${fight.name}`,
    );
  }
}

async function commandDamage(client: WCLClient, input: string, flags: Flags) {
  const requestedMode = strFlag(flags, 'window-mode');
  const windowMode =
    requestedMode === 'fixed'
      ? 'fixed'
      : requestedMode === 'prescience-buff' || requestedMode === 'prescience'
        ? 'prescience-buff'
        : flags.window || flags.offset
          ? 'fixed'
          : 'prescience-buff';

  const result = await analyzeReport(client, input, {
    ...(flags.fight && flags.fight !== true ? { fight: String(flags.fight) } : {}),
    ...(flags.encounter ? { encounterID: numFlag(flags, 'encounter', 0) } : {}),
    windowMode,
    prescienceDurationMs: numFlag(flags, 'prescience-duration', 18_000),
    windowMs: numFlag(flags, 'window', 27_000),
    offsetMs: numFlag(flags, 'offset', 4000),
    slots: numFlag(flags, 'slots', 4),
    ...(flags['max-windows'] ? { maxWindows: numFlag(flags, 'max-windows', 0) } : {}),
    ...(flags['exclude-augmentation'] ? { excludeAugmentation: true } : {}),
    ...(flags.filter === 'none'
      ? { filterExpression: '' }
      : flags.filter && flags.filter !== true
        ? { filterExpression: String(flags.filter) }
        : {}),
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { report, fights, windows } = result;

  console.log(
    `${report.title}  [${report.code}]  —  ${fights.length} fight(s), ` +
      `${windows.length} windows\n`,
  );

  for (const window of windows) {
    const label = `${clock(window.startTime)}–${clock(window.endTime + 1)}`;
    const top = window.assignments
      .map((slot) => {
        const mark = slot.priority
          ? '*'
          : window.castTarget?.key === slot.key
            ? '^'
            : '';
        return `${slot.name}${mark} ${fmt(slot.dps)}`;
      })
      .join('   ');

    console.log(`  ${label.padEnd(14)} ${top}`);
  }

  if (result.windowMode !== 'fixed') {
    console.log('\n  ^ = Prescience cast target');
  }

  const { limit, points } = result.rateLimit;
  if (limit && points != null) console.log(`\n  rate limit: ${points}/${limit} points left`);
}

async function commandRankings(client: WCLClient, positional: string[], flags: Flags) {
  const [name, serverSlug, region] = positional;
  if (!name || !serverSlug || !region) {
    throw new Error('Usage: rankings <name> <serverSlug> <region> --encounter <id> --difficulty <id>');
  }

  const encounterID = numFlag(flags, 'encounter', 0);
  const difficulty = numFlag(flags, 'difficulty', 0);
  if (!encounterID || !difficulty) throw new Error('--encounter and --difficulty are required');

  const { rankings } = await fetchEncounterRankings(
    client,
    { name, serverSlug, serverRegion: region },
    {
      encounterID,
      difficulty,
      ...(strFlag(flags, 'spec') ? { specName: strFlag(flags, 'spec')! } : {}),
      ...(flags.partition ? { partition: numFlag(flags, 'partition', 0) } : {}),
    },
  );

  console.log(`partition ${rankings.partition}, ${rankings.totalKills} kills, metric ${rankings.metric}\n`);

  for (const ref of rankToFightRefs(rankings).slice(0, 10)) {
    console.log(
      `  ${fmt(ref.amount).padStart(7)}  ${clock(ref.duration).padStart(7)}  ` +
        `${ref.reportCode}#${ref.fightId}  ${ref.spec}`,
    );
  }
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  token',
      '  meta <report-url|code> [--encounter <id>]',
      '  damage <report-url|code> [--fight <id|last|all>] [--encounter <id>]',
      '         [--window-mode prescience-buff|fixed] [--prescience-duration 18000]',
      '         [--window 27000] [--offset 4000] [--slots 4]',
      '         [--filter <expr|none>] [--max-windows <n>] [--exclude-augmentation] [--json]',
      '  rankings <name> <serverSlug> <region> --encounter <id> --difficulty <id>',
      '         [--spec <specName>] [--partition <n>]',
    ].join('\n'),
  );
}

async function main() {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command) {
    printUsage();
    return;
  }

  const client = makeClient();

  switch (command) {
    case 'token':
      return commandToken(client);
    case 'meta':
      return commandMeta(client, rest[0]!, flags);
    case 'damage':
      return commandDamage(client, rest[0]!, flags);
    case 'rankings':
      return commandRankings(client, rest, flags);
    default:
      printUsage();
  }
}

main().catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
