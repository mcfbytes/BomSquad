/**
 * The summary a monthly MAME bump PR is built around (TASKS T2.6).
 *
 * T2.6's whole acceptance bar is "a manually-dispatched dry run opens a correctly
 * summarised PR", and a PR cannot be dispatched inside a test. What can be tested — and
 * what actually matters, since a curator reads the PR body and never this file — is the
 * summary itself: given the *old* extract (what is committed today) and the *new* one
 * (what a fresh `pipeline mame:extract` against the bumped pin just produced), compute
 * what changed. `buildRefreshSummary` is that pure function; `formatRefreshSummaryMarkdown`
 * turns its result into the PR body. Neither touches the filesystem or the network —
 * the thin I/O around both (reading `extract/*.raw.json`, calling `gh pr create`) lives in
 * `cli.ts` and `.github/workflows/mame-refresh.yml`, exactly as `runExtraction` composes
 * this file's siblings without containing logic of its own.
 *
 * **What "new unmapped device" means here, and why.** This module never reads
 * `data/mame_device/*.json` — the curated map is a moving target maintained by a separate
 * task and separate agents, and making the refresh workflow's correctness depend on its
 * current contents would be exactly the coupling TASKS T3.2 was written to avoid. What the
 * two extracts alone can prove, with no map at all, is which device short names are new to
 * this MAME release: a name absent from the old worklist cannot have a `mame_device` row
 * yet, mapped or ignored, because nobody could have curated a row for a device that did
 * not exist. That is therefore exactly "new unmapped devices" — every one of them is
 * unmapped, provably, without loading the map — and it is ranked by the same impact order
 * `mame/worklist.ts` already defines, because that is what the worklist ranks new entrants
 * into.
 */
import type { RawMachine } from './parse.js';
import type { WorklistEntry } from './worklist.js';
import { compareBytes } from '../db/rowfiles.js';

export interface RefreshSummaryInput {
  readonly oldVersion: string;
  readonly newVersion: string;
  /** `extract/machines.raw.json`'s `machines`, before and after the bump. */
  readonly oldMachines: readonly RawMachine[];
  readonly newMachines: readonly RawMachine[];
  /** `extract/mame-devices.raw.json`'s `devices`, before and after the bump. */
  readonly oldDevices: readonly WorklistEntry[];
  readonly newDevices: readonly WorklistEntry[];
}

export interface MachineDelta {
  readonly machineId: string;
  readonly name: string;
}

export interface NewUnmappedDevice {
  readonly mameDevice: string;
  readonly instanceCount: number;
  readonly machineCount: number;
}

export interface RefreshSummary {
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly machineCountBefore: number;
  readonly machineCountAfter: number;
  /** Bytewise ascending by `machineId` (standing rule 2). */
  readonly machinesAdded: readonly MachineDelta[];
  /** Bytewise ascending by `machineId`. */
  readonly machinesRemoved: readonly MachineDelta[];
  /** Descending instance count, then bytewise ascending by device name — worklist.ts's order. */
  readonly newUnmappedDevices: readonly NewUnmappedDevice[];
}

/**
 * Diffs two extraction snapshots. Pure and total over any two well-formed snapshots —
 * including two identical ones, which yields a summary with every list empty rather than
 * a special case, so a workflow run against an unchanged pin still produces a coherent
 * (if uneventful) summary instead of needing its own branch.
 */
export function buildRefreshSummary(input: RefreshSummaryInput): RefreshSummary {
  const oldById = new Map(input.oldMachines.map((machine) => [machine.machine_id, machine]));
  const newById = new Map(input.newMachines.map((machine) => [machine.machine_id, machine]));

  const machinesAdded: MachineDelta[] = [];
  for (const [machineId, machine] of newById) {
    if (!oldById.has(machineId)) machinesAdded.push({ machineId, name: machine.name });
  }
  const machinesRemoved: MachineDelta[] = [];
  for (const [machineId, machine] of oldById) {
    if (!newById.has(machineId)) machinesRemoved.push({ machineId, name: machine.name });
  }

  const oldDeviceNames = new Set(input.oldDevices.map((entry) => entry.mame_device));
  const newUnmappedDevices: NewUnmappedDevice[] = input.newDevices
    .filter((entry) => !oldDeviceNames.has(entry.mame_device))
    .map((entry) => ({
      mameDevice: entry.mame_device,
      instanceCount: entry.instance_count,
      machineCount: entry.machine_count,
    }));

  return {
    oldVersion: input.oldVersion,
    newVersion: input.newVersion,
    machineCountBefore: input.oldMachines.length,
    machineCountAfter: input.newMachines.length,
    machinesAdded: machinesAdded.sort((a, b) => compareBytes(a.machineId, b.machineId)),
    machinesRemoved: machinesRemoved.sort((a, b) => compareBytes(a.machineId, b.machineId)),
    newUnmappedDevices: newUnmappedDevices.sort(
      (a, b) => b.instanceCount - a.instanceCount || compareBytes(a.mameDevice, b.mameDevice),
    ),
  };
}

export interface FormatOptions {
  /** Machine names listed per added/removed section before collapsing to "N more". */
  readonly maxMachinesShown?: number;
  /** Device rows listed in the impact table before collapsing to "N more". */
  readonly maxDevicesShown?: number;
}

const DEFAULT_MAX_MACHINES_SHOWN = 20;
const DEFAULT_MAX_DEVICES_SHOWN = 25;

function machineList(machines: readonly MachineDelta[], limit: number): string {
  if (machines.length === 0) return '_None._\n';
  const lines = machines
    .slice(0, limit)
    .map((machine) => `- \`${machine.machineId}\` — ${machine.name}`);
  if (machines.length > limit) lines.push(`- _...and ${machines.length - limit} more._`);
  return `${lines.join('\n')}\n`;
}

function deviceTable(devices: readonly NewUnmappedDevice[], limit: number): string {
  if (devices.length === 0) return '_None._\n';
  const header = '| device | instances | machines |\n| --- | ---: | ---: |\n';
  const rows = devices
    .slice(0, limit)
    .map(
      (device) => `| \`${device.mameDevice}\` | ${device.instanceCount} | ${device.machineCount} |`,
    )
    .join('\n');
  const rest =
    devices.length > limit ? `\n\n_...and ${devices.length - limit} more, by impact._` : '';
  return `${header}${rows}${rest}\n`;
}

/**
 * Renders the PR body. Deterministic — no timestamp, no locale-dependent number
 * formatting (`toLocaleString` would make the same summary render differently by host
 * locale, which is exactly what standing rule 2 forbids) — so the same summary always
 * produces the same bytes, which is what `test/mame-refresh-summary.test.ts` pins.
 */
export function formatRefreshSummaryMarkdown(
  summary: RefreshSummary,
  options: FormatOptions = {},
): string {
  const maxMachinesShown = options.maxMachinesShown ?? DEFAULT_MAX_MACHINES_SHOWN;
  const maxDevicesShown = options.maxDevicesShown ?? DEFAULT_MAX_DEVICES_SHOWN;

  const lines: string[] = [];
  lines.push(`## MAME refresh: ${summary.oldVersion} → ${summary.newVersion}`, '');
  lines.push(
    `**Machines:** ${summary.machineCountBefore} → ${summary.machineCountAfter} ` +
      `(+${summary.machinesAdded.length} / -${summary.machinesRemoved.length})`,
    '',
  );
  lines.push(`### Machines added (${summary.machinesAdded.length})`, '');
  lines.push(machineList(summary.machinesAdded, maxMachinesShown));
  lines.push(`### Machines removed (${summary.machinesRemoved.length})`, '');
  lines.push(machineList(summary.machinesRemoved, maxMachinesShown));
  lines.push(
    `### New unmapped devices, ranked by impact (${summary.newUnmappedDevices.length})`,
    '',
  );
  lines.push(
    'Device short names that did not exist in the previous release and so cannot yet ' +
      'have a `mame_device` row — this is exactly how much the curation queue ' +
      '(`v_mame_device_worklist`) grew by this bump.',
    '',
  );
  // machineList/deviceTable each already end with their own '\n' (they are multi-line
  // blocks pushed as one entry), so joining the rest with '\n' and appending nothing more
  // leaves exactly one trailing newline overall rather than a spurious blank final line.
  lines.push(deviceTable(summary.newUnmappedDevices, maxDevicesShown));
  return lines.join('\n');
}
