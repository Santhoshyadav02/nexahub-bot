/**
 * ============================================================
 * 🧪 STATE ISOLATION - FOCUSED REGRESSION TEST
 * ============================================================
 * Verifies that MediaLedger, BatchState, and PublishLedger, when given an
 * explicit isolated path, NEVER touch the shared default location
 * (video_pipeline/media_state.json, batch_state.json, publish_state.json) -
 * and that the default location genuinely exists and is separate when no
 * override is given (proving the isolation mechanism itself, not just its
 * absence of use).
 */
const fs = require('fs');
const path = require('path');
const { MediaLedger } = require('./media_ledger');
const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

const SHARED_MEDIA_STATE = path.join(__dirname, 'media_state.json');
const SHARED_BATCH_STATE = path.join(__dirname, 'batch_state.json');
const SHARED_PUBLISH_STATE = path.join(__dirname, 'publish_state.json');

const WORKSPACE = path.join(__dirname, '..', 'scratch', 'state_isolation_test_workspace');

function snapshotSharedFiles() {
  return {
    media: fs.existsSync(SHARED_MEDIA_STATE),
    batch: fs.existsSync(SHARED_BATCH_STATE),
    publish: fs.existsSync(SHARED_PUBLISH_STATE)
  };
}

async function main() {
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const before = snapshotSharedFiles();
  check('Precondition: no shared default state files exist before this test', !before.media && !before.batch && !before.publish,
    JSON.stringify(before));

  console.log('\n--- Isolated construction never touches the shared default path ---');
  const isolatedMediaPath = path.join(WORKSPACE, 'media_state.json');
  const isolatedBatchPath = path.join(WORKSPACE, 'batch_state.json');
  const isolatedPublishPath = path.join(WORKSPACE, 'publish_state.json');

  const ledger = new MediaLedger({ ledgerPath: isolatedMediaPath });
  await ledger.upsert('probe_id', { status: 'READY', filePath: 'x', size: 1 });

  const batch = new BatchState({ statePath: isolatedBatchPath });
  batch.startCycle('probe_cycle');

  const publish = new PublishLedger({ ledgerPath: isolatedPublishPath });
  await publish.recordAttempt({ batchId: 'probe_cycle', media: { mediaId: 'probe_id' }, destinationId: '@probe_dest' });

  check('MediaLedger wrote to its isolated path', fs.existsSync(isolatedMediaPath));
  check('BatchState wrote to its isolated path', fs.existsSync(isolatedBatchPath));
  check('PublishLedger wrote to its isolated path', fs.existsSync(isolatedPublishPath));

  const afterIsolated = snapshotSharedFiles();
  check('Shared media_state.json was NOT created by isolated MediaLedger use', !afterIsolated.media);
  check('Shared batch_state.json was NOT created by isolated BatchState use', !afterIsolated.batch);
  check('Shared publish_state.json was NOT created by isolated PublishLedger use', !afterIsolated.publish);

  console.log('\n--- Default (no override) construction resolves to video_pipeline/*_state.json, as documented ---');
  // Prove the OTHER half of the contract: the default path is exactly what
  // the whole codebase (and .gitignore's video_pipeline/*_state.json rule)
  // expects, so callers who WANT the real persistent path get it correctly.
  const defaultLedger = new MediaLedger({});
  check('Default MediaLedger path matches the documented shared location', defaultLedger.ledgerPath === SHARED_MEDIA_STATE);
  const defaultBatch = new BatchState({});
  check('Default BatchState path matches the documented shared location', defaultBatch.statePath === SHARED_BATCH_STATE);
  const defaultPublish = new PublishLedger({});
  check('Default PublishLedger path matches the documented shared location', defaultPublish.ledgerPath === SHARED_PUBLISH_STATE);

  // These default instances only created their directory (mkdirSync in the
  // constructor), not the files themselves (no write happened) - confirm
  // that distinction explicitly, then clean up regardless.
  const afterDefaults = snapshotSharedFiles();
  check('Merely constructing default-path instances (no write) still leaves no shared state file behind',
    !afterDefaults.media && !afterDefaults.batch && !afterDefaults.publish, JSON.stringify(afterDefaults));

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  for (const p of [SHARED_MEDIA_STATE, SHARED_BATCH_STATE, SHARED_PUBLISH_STATE]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log(`\n============================================================`);
  console.log(`STATE ISOLATION RESULT: ${passed} passed, ${failed} failed`);
  console.log(`============================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('CRASHED:', e); process.exit(1); });
