import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exactIssueNumber, inventoryChanges, openUpdatePullRequest, reportFailure, updatePullRequestArguments, writeInventoryReview } from '../scripts/upstream-review.mjs';
import { getRegionProfile } from '../scripts/regions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const inventory = () => ({
  sourceApplication: { region: 'CN', version: '1.0.1', entryModule: 'old.js' },
  runtimeConstants: { clickCacheEnvironment: 'cn-cn-prod' },
  commands: [{ name: 'load_key_press_count', response: { type: 'number' }, callSites: [{ file: 'old.js', charRange: [1, 2] }] }],
  events: [{ name: 'key-press', payload: { type: 'string' }, callSites: [{ file: 'old.js' }] }],
});

test('candidate summaries separate source churn from named command, payload and event changes', () => {
  const accepted = inventory(), observed = inventory();
  observed.sourceApplication.version = '1.0.2';
  observed.sourceApplication.entryModule = 'new.js';
  observed.commands[0].callSites[0] = { file: 'new.js', charRange: [100, 200] };
  observed.events[0].payload = { type: 'number' };
  observed.events.push({ name: 'gamepad-button-press', payload: { type: 'string' }, callSites: [] });
  const changes = inventoryChanges(accepted, observed);
  assert.equal(changes.acceptedVersion, '1.0.1');
  assert.equal(changes.observedVersion, '1.0.2');
  assert.deepEqual(changes.commands, { added: [], removed: [], changed: [] });
  assert.deepEqual(changes.events, { added: ['gamepad-button-press'], removed: [], changed: ['key-press'] });
  assert.equal(changes.runtimeConstants.changed, false);
  observed.commands = [];
  assert.deepEqual(inventoryChanges(accepted, observed).commands.removed, ['load_key_press_count']);
});

test('candidate inventory is review evidence and never overwrites the accepted fixtures or resource lock', async () => {
  const profile = getRegionProfile();
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-upstream-review-'));
  try {
    await mkdir(path.join(directory, 'tests'));
    await mkdir(path.join(directory, profile.frontendDir));
    await symlink(path.join(root, profile.frontendDir, 'assets'), path.join(directory, profile.frontendDir, 'assets'));
    const filename = profile.id === 'cn' ? 'contracts.json' : 'contracts-global.json';
    const accepted = await readFile(path.join(root, 'tests', filename), 'utf8');
    const lock = JSON.stringify({ version: '9.9.9' });
    await writeFile(path.join(directory, 'tests', filename), accepted);
    await writeFile(path.join(directory, profile.upstreamLock), lock);
    await writeInventoryReview(directory, profile);
    const observed = JSON.parse(await readFile(path.join(directory, '.work/upstream-review/observed-inventory.json'), 'utf8'));
    const changes = JSON.parse(await readFile(path.join(directory, '.work/upstream-review/contract-changes.json'), 'utf8'));
    assert.equal(observed.sourceApplication.version, '9.9.9');
    assert.equal(observed.sourceApplication.region, profile.region);
    assert.equal(changes.observedVersion, '9.9.9');
    assert.equal(await readFile(path.join(directory, 'tests', filename), 'utf8'), accepted);
    assert.equal(await readFile(path.join(directory, profile.upstreamLock), 'utf8'), lock);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an update is ready only when every required compatibility and packaging stage succeeded', () => {
  for (const region of ['cn', 'global']) {
    const profile = getRegionProfile(region);
    const outcomes = Object.fromEntries(['inventory', 'frontend', 'native', 'build', 'package'].map(stage => [stage, 'success']));
    const args = updatePullRequestArguments({ profile, version: '1.0.2', branch: 'codex/candidate', runUrl: 'https://github.com/owner/repo/actions/runs/1', outcomes });
    assert.ok(!args.includes('--draft'));
    assert.ok(args.includes(`同步${profile.label}官方资源 1.0.2`));
    assert.ok(args[args.indexOf('--body') + 1].includes(`official-${region}-review`));
    const mirrorFailed = updatePullRequestArguments({ profile, version: '1.0.2', branch: 'codex/candidate', runUrl: 'run', outcomes: { ...outcomes, mirror: 'failure' } });
    assert.ok(mirrorFailed[mirrorFailed.indexOf('--body') + 1].includes('mirror: failure'));
    for (const stage of Object.keys(outcomes)) for (const result of ['failure', 'skipped', 'cancelled', undefined]) {
      const draft = updatePullRequestArguments({ profile, version: '1.0.2', branch: 'codex/candidate', runUrl: 'run', outcomes: { ...outcomes, [stage]: result } });
      assert.ok(draft.includes('--draft'), `${region} ${stage} ${result}`);
      const body = draft[draft.indexOf('--body') + 1];
      assert.ok(body.includes(`${stage}: ${result || 'skipped'}`));
      assert.ok(body.includes('尚未通过兼容性验证'));
    }
  }
});

test('failure reports select only the exact regional issue title', () => {
  const issues = [{ number: 1, title: '国际服官方同步需要处理' }, { number: 2, title: '国服官方同步需要处理：旧问题' }, { number: 3, title: '国服官方同步需要处理' }];
  assert.equal(exactIssueNumber(issues, '国际服官方同步需要处理'), 1);
  assert.equal(exactIssueNumber(issues, '国服官方同步需要处理'), 3);
  assert.equal(exactIssueNumber(issues.slice(0, 2), '国服官方同步需要处理'), null);
});

test('update PR execution commits only its regional lock, selects draft after failure, and does nothing without a diff', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-upstream-pr-'));
  const environment = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123', ...Object.fromEntries(['inventory', 'frontend', 'native', 'build', 'package'].map(stage => [`${stage.toUpperCase()}_OUTCOME`, 'success'])) };
  try {
    await mkdir(path.join(directory, '.work'));
    await writeFile(path.join(directory, '.work/upstream-check.json'), '{"latestVersion":"1.0.2"}');
    for (const region of ['cn', 'global']) for (const changed of [false, true]) for (const frontend of ['success', 'failure']) {
      const calls = [];
      const execute = (command, args, options) => {
        assert.equal(options.cwd, directory);
        calls.push([command, args]);
        return command === 'git' && args[0] === 'diff' ? (changed ? 'resource diff' : '') : '';
      };
      await openUpdatePullRequest({ projectRoot: directory, profile: getRegionProfile(region), environment: { ...environment, FRONTEND_OUTCOME: frontend }, execute });
      if (!changed) {
        assert.deepEqual(calls, [['git', ['diff', '--', `upstream-${region}.json`]]]);
        continue;
      }
      assert.deepEqual(calls.find(([command, args]) => command === 'git' && args[0] === 'add'), ['git', ['add', '--', `upstream-${region}.json`]]);
      assert.deepEqual(calls.find(([command, args]) => command === 'git' && args[0] === 'push'), ['git', ['push', 'origin', `codex/official-${region}-1.0.2-123`]]);
      assert.equal(calls.at(-1)[0], 'gh');
      assert.equal(calls.at(-1)[1].includes('--draft'), frontend === 'failure');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failure report execution creates CN issue instead of commenting on a fuzzy Global match', () => {
  for (const matching of [false, true]) {
    const calls = [];
    reportFailure({ profile: getRegionProfile('cn'), environment: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123' }, execute: (command, args) => {
      calls.push([command, args]);
      return JSON.stringify([{ number: 1, title: '国际服官方同步需要处理' }, ...(matching ? [{ number: 2, title: '国服官方同步需要处理' }] : [])]);
    } });
    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1)[1][1], matching ? 'comment' : 'create');
    assert.ok(calls.at(-1)[1].includes(matching ? '2' : '国服官方同步需要处理'));
  }
});

test('sync workflow retains failed validation and creates reviewable drafts only after successful extraction', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/sync-upstream.yml'), 'utf8');
  assert.ok(!workflow.includes('continue-on-error'));
  assert.match(workflow, /Open validated update or draft requiring adaptation\n\s+if: always\(\) && !cancelled\(\) && steps\.extract\.outcome == 'success'/);
  assert.match(workflow, /Keep upstream review evidence\n\s+if: always\(\) && steps\.upstream\.outputs\.changed == 'true'/);
  assert.match(workflow, /Report incompatible or unavailable upstream\n\s+if: failure\(\)/);
  assert.ok(workflow.includes('node scripts/upstream-review.mjs inventory'));
  assert.ok(workflow.includes('.work/upstream-review/*.json'));
  assert.match(workflow, /retention-days: 30\n\s+include-hidden-files: true/);
  assert.ok(!workflow.includes('npm run inventory'));
});
