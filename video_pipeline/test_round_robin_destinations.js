/**
 * ============================================================
 * 🧪 TEST: ROUND-ROBIN DESTINATION PUBLISHING
 * ============================================================
 *  1. Items go to destinations in configured order and wrap around
 *  2. Position persists across publisher instances (restart)
 *  3. Chats denied by the access check are skipped
 *  4. No accessible chat -> FAILED, nothing sent
 *  5. Media already published to one chat is skipped, not re-posted elsewhere
 *  6. PublishLedger.getMediaAttemptState aggregates across chats
 *  7. BatchCycleManager attempt lookup uses the aggregate in round-robin mode
 *  8. postingDeniedReason rules (member/admin/banned/broadcast)
 *  9. Runtime parses VIDEO_PIPELINE_DESTINATION_CHAT_IDS and rejects protected ids
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');
const { postingDeniedReason } = require('./mtproto_video_uploader');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_round_robin_destinations_workspace');
const IDS = ['-1001', '-1002', '-1003'];

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function makeMedia(dir, n) {
  const filePath = path.join(dir, `m${n}.mp4`);
  fs.writeFileSync(filePath, `media-${n}-${Math.random()}`);
  return {
    mediaId: `media_${n}`,
    title: `T${n}`,
    filePath,
    size: fs.statSync(filePath).size,
    contentSha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    sourceMode: 'authorized',
    isFixtureMedia: false,
    sourcePageUrl: 'https://source.test/post/1',
    sourceVideoUrl: 'https://cdn.test/v.mp4'
  };
}

function makePublisher(dir, { sent, ledger, accessCheck }) {
  return new VideoBatchPublisher({
    stagingChatId: 'me',
    telegramClient: { publish: async ({ destinationId }) => { sent.push(destinationId); return { messageId: sent.length }; } },
    batchState: new BatchState({ statePath: path.join(dir, 'batch_state.json') }),
    publishLedger: ledger || new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') }),
    rateLimitDelayMs: 0,
    authorizedSourceUrl: 'https://source.test/list',
    destinationChatIds: IDS,
    roundRobinStatePath: path.join(dir, 'rr.json'),
    destinationAccessCheck: accessCheck,
    mediaValidator: async () => ({ valid: true })
  });
}

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  section('1-2. Order, wrap-around, persistence');
  {
    const dir = path.join(TEST_DIR, 'order'); fs.mkdirSync(dir);
    const sent = [];
    const ledger = new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') });
    const pub = makePublisher(dir, { sent, ledger });
    for (let i = 1; i <= 4; i++) {
      const res = await pub.publishSingleItem('b', makeMedia(dir, i));
      check(`item ${i} published`, res.status === 'PUBLISHED', JSON.stringify(res));
    }
    check('order 1,2,3 then wraps to 1', JSON.stringify(sent) === JSON.stringify(['-1001', '-1002', '-1003', '-1001']), JSON.stringify(sent));

    const restarted = makePublisher(dir, { sent, ledger });
    await restarted.publishSingleItem('b', makeMedia(dir, 5));
    check('restart continues with next chat', sent[4] === '-1002', JSON.stringify(sent));

    section('5-7. Already published / ledger aggregate');
    const first = makeMedia(dir, 1);
    first.mediaId = 'media_1';
    const again = await restarted.publishSingleItem('b', first);
    check('already-published item skipped', again.status === 'SKIPPED_ALREADY_PUBLISHED' && again.destinationId === '-1001', JSON.stringify(again));
    check('nothing re-sent', sent.length === 5);
    const state = ledger.getMediaAttemptState('media_1');
    check('aggregate: published with chat id', state.published && state.publishedDestinationId === '-1001', JSON.stringify(state));
    check('aggregate: unknown media not published', !ledger.getMediaAttemptState('nope').exists);

    const { BatchCycleManager } = require('./batch_cycle_manager');
    const bcm = Object.create(BatchCycleManager.prototype);
    bcm.videoBatchPublisher = restarted;
    bcm.publishOptions = {};
    const viaManager = bcm._getPublishAttemptState('media_1');
    check('BatchCycleManager uses aggregate in round-robin mode', viaManager && viaManager.published === true, JSON.stringify(viaManager));
  }

  section('3-4. Access check');
  {
    const dir = path.join(TEST_DIR, 'access'); fs.mkdirSync(dir);
    const sent = [];
    const pub = makePublisher(dir, { sent, accessCheck: async () => ({ ok: ['-1001', '-1003'], denied: [{ id: '-1002', reason: 'test' }] }) });
    for (let i = 1; i <= 3; i++) await pub.publishSingleItem('b', makeMedia(dir, i));
    check('denied chat skipped', JSON.stringify(sent) === JSON.stringify(['-1001', '-1003', '-1001']), JSON.stringify(sent));

    const dir2 = path.join(TEST_DIR, 'none'); fs.mkdirSync(dir2);
    const sent2 = [];
    const none = makePublisher(dir2, { sent: sent2, accessCheck: async () => ({ ok: [], denied: IDS.map(id => ({ id, reason: 'x' })) }) });
    const res = await none.publishSingleItem('b', makeMedia(dir2, 1));
    check('no accessible chat -> FAILED', res.status === 'FAILED' && sent2.length === 0, JSON.stringify(res));
  }

  section('8. postingDeniedReason');
  check('user (me) allowed', postingDeniedReason({ className: 'User' }) === null);
  check('left channel denied', /not a member/.test(postingDeniedReason({ className: 'Channel', left: true })));
  check('forbidden denied', /removed or banned/.test(postingDeniedReason({ className: 'ChannelForbidden' })));
  check('broadcast without admin denied', /admin/.test(postingDeniedReason({ className: 'Channel', broadcast: true })));
  check('broadcast admin with post right allowed', postingDeniedReason({ className: 'Channel', broadcast: true, adminRights: { postMessages: true } }) === null);
  check('broadcast creator allowed', postingDeniedReason({ className: 'Channel', broadcast: true, creator: true }) === null);
  check('megagroup member allowed', postingDeniedReason({ className: 'Channel', megagroup: true }) === null);
  check('megagroup with media banned denied', /restricts/.test(postingDeniedReason({ className: 'Channel', megagroup: true, defaultBannedRights: { sendMedia: true } })));
  check('megagroup admin allowed despite default ban', postingDeniedReason({ className: 'Channel', megagroup: true, adminRights: {}, defaultBannedRights: { sendMedia: true } }) === null);

  section('9. Runtime config');
  {
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_SESSION_STRING: 'x', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'y' });
    try {
      const { VideoPipelineRuntime } = require('./video_pipeline_runtime');
      const base = {
        enabled: true, sourceMode: 'authorized', authorizedSourceUrl: 'https://source.test/list', uploadMode: 'mtproto',
        stateDir: path.join(TEST_DIR, 'rt_state'), outputDir: path.join(TEST_DIR, 'rt_out'), downloadsDir: path.join(TEST_DIR, 'rt_dl'),
        uploadPartsDir: path.join(TEST_DIR, 'rt_parts')
      };
      const rt = new VideoPipelineRuntime({ ...base, destinationChatIds: ' -1001, -1002 ,-1003 ' });
      check('ids parsed in order', JSON.stringify(rt.destinationChatIds) === JSON.stringify(IDS), JSON.stringify(rt.destinationChatIds));
      check('valid without staging chat', rt._configValid, rt._lastConfigError);
      rt._ensureManagerInitialized();
      const pub = rt.batchCycleManager.videoBatchPublisher;
      check('publisher in round-robin mode with access check', pub.usesRoundRobin() && typeof pub.destinationAccessCheck === 'function');
      const fromConfig = new VideoPipelineRuntime(base);
      const { VideoDestinationRouter } = require('./video_destination_router');
      const configIds = new VideoDestinationRouter().getDestinationChatIds();
      check('without env ids, routing config chatIds are used in priority order',
        configIds.length === 10 && JSON.stringify(fromConfig.destinationChatIds) === JSON.stringify(configIds)
          && configIds[0] === '-1003780478806' && configIds[9] === '-1003786693669', JSON.stringify(fromConfig.destinationChatIds));
      const bad = new VideoPipelineRuntime({ ...base, destinationChatIds: '-1001,ccsfvk' });
      check('protected destination rejected', !bad._configValid && /protected/.test(bad._lastConfigError), bad._lastConfigError);
    } finally {
      process.env = saved;
    }
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
