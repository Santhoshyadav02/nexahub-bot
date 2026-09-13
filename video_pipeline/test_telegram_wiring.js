/**
 * ============================================================
 * 🧪 TELEGRAM RUNTIME WIRING - FOCUSED TEST
 * ============================================================
 * Verifies the exact integration index.js performs:
 *   getVideoPipelineRuntime({ telegramClient: bot })
 * using a mock object shaped exactly like the real
 * node-telegram-bot-api instance (sendVideo(chatId, video, options) ->
 * Promise<{ message_id }>), never a real bot/token/network call.
 */
const fs = require('fs');
const path = require('path');
const { VideoPipelineRuntime, _resetRuntimeInstanceForTesting, getVideoPipelineRuntime } = require('./video_pipeline_runtime');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

const WORKSPACE = path.join(__dirname, '..', 'scratch', 'telegram_wiring_test_workspace');

function makeMockBot(behavior = 'success') {
  const calls = [];
  return {
    calls,
    async sendVideo(chatId, video, options) {
      calls.push({ chatId, video, options });
      if (behavior === 'fail') throw new Error('Simulated Telegram API failure');
      return { message_id: 987654, chat: { id: chatId } };
    }
  };
}

async function testMissingClientFailsClosed() {
  console.log('\n--- Test: autoPublish enabled but no telegramClient/publisher -> CONFIG_ERROR (fail closed) ---');
  _resetRuntimeInstanceForTesting();
  const dir = path.join(WORKSPACE, 'missing_client');
  fs.mkdirSync(dir, { recursive: true });
  const rt = new VideoPipelineRuntime({
    enabled: true,
    sourceMode: 'fixture', // explicit: the runtime no longer defaults to any source
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    stagingChatId: '@my_private_staging_test_channel',
    autoPublish: true,
    outputDir: path.join(dir, 'output'),
    downloadsDir: path.join(dir, 'downloads'),
    stateDir: dir
    // telegramClient intentionally omitted
  });
  const result = rt.start();
  check('start() refuses with CONFIG_ERROR when no Telegram client is available', result.status === 'CONFIG_ERROR', JSON.stringify(result));
  check('Runtime never actually started', !rt.isStarted());
  check('Config error message names the real problem', /Telegram client/i.test(rt.getStatus().lastConfigError || ''));
}

async function testInjectedClientAllowsStart() {
  console.log('\n--- Test: exact index.js pattern - getVideoPipelineRuntime({ telegramClient: bot }) ---');
  _resetRuntimeInstanceForTesting();
  const dir = path.join(WORKSPACE, 'injected_client');
  fs.mkdirSync(dir, { recursive: true });
  const mockBot = makeMockBot('success');

  // This mirrors index.js's SINGLE-PROCESS INIT call exactly.
  const rt = getVideoPipelineRuntime({
    enabled: true,
    sourceMode: 'fixture', // explicit: the runtime no longer defaults to any source
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    stagingChatId: '@my_private_staging_test_channel',
    autoPublish: false, // just verifying config validity here, not running acquisition
    outputDir: path.join(dir, 'output'),
    downloadsDir: path.join(dir, 'downloads'),
    stateDir: dir,
    telegramClient: mockBot
  });

  check('getVideoPipelineRuntime() accepts an injected telegramClient without error', rt instanceof VideoPipelineRuntime);
  check('Runtime stored the injected client internally', rt.telegramClient === mockBot);
}

async function testEndToEndStagingPublishViaWiredClient() {
  console.log('\n--- Test: end-to-end - wired mock client actually receives the publish call ---');
  _resetRuntimeInstanceForTesting();
  const dir = path.join(WORKSPACE, 'e2e_publish');
  fs.mkdirSync(dir, { recursive: true });
  const mockBot = makeMockBot('success');

  const rt = new VideoPipelineRuntime({
    enabled: true,
    sourceMode: 'fixture', // explicit: the runtime no longer defaults to any source
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    stagingChatId: '@my_private_staging_test_channel',
    autoPublish: true,
    outputDir: path.join(dir, 'output'),
    downloadsDir: path.join(dir, 'downloads'),
    stateDir: dir,
    telegramClient: mockBot
  });

  const startResult = rt.start();
  check('Runtime starts cleanly with a valid injected client', startResult.status === 'STARTED', JSON.stringify(startResult));
  await rt.stop();

  // Directly exercise the publisher the runtime built, with one fabricated
  // BATCH_READY cycle (authorized local fixture path, no real acquisition
  // needed to prove the wiring itself).
  const fixturePath = path.join(dir, 'downloads', 'video_wiring_test.mp4');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scratch', 'real_video_test.mp4'), fixturePath);

  const bcm = rt.batchCycleManager;
  bcm.batchState.startCycle('cycle_wiring_test', { startedAt: new Date().toISOString() });
  bcm.batchState.updateCycle('cycle_wiring_test', {
    status: 'BATCH_READY',
    media: [{ mediaId: 'media_wiring_test', title: 'Wiring Test Video', filePath: fixturePath, contentSha256: 'x', sourceKeyHash: 'y' }]
  });

  const pubResult = await bcm.publishCycle('cycle_wiring_test');
  check('publishBatch completed', pubResult.status === 'COMPLETED', JSON.stringify(pubResult));
  check('The mock bot (the exact object wired via index.js\'s pattern) actually received the sendVideo call', mockBot.calls.length === 1);
  check('sendVideo was called with the configured staging chat ID, not a production channel', mockBot.calls[0].chatId === '@my_private_staging_test_channel');
  check('sendVideo received the real fixture file path', mockBot.calls[0].video === fixturePath);
  check('Caption matches the frozen title', mockBot.calls[0].options.caption === 'Wiring Test Video');
}

async function testForbiddenDestinationStillBlocked() {
  console.log('\n--- Test: production-channel blocklist still enforced even with a real client wired ---');
  _resetRuntimeInstanceForTesting();
  const dir = path.join(WORKSPACE, 'forbidden');
  fs.mkdirSync(dir, { recursive: true });
  const mockBot = makeMockBot('success');

  const rt = new VideoPipelineRuntime({
    enabled: true,
    sourceMode: 'fixture', // explicit: the runtime no longer defaults to any source
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    stagingChatId: '@ccsfvk', // a real production channel username
    autoPublish: true,
    outputDir: path.join(dir, 'output'),
    downloadsDir: path.join(dir, 'downloads'),
    stateDir: dir,
    telegramClient: mockBot
  });
  const result = rt.start();
  check('Runtime refuses to start when staging target is a real production channel', result.status === 'CONFIG_ERROR');
  check('No sendVideo call was ever made', mockBot.calls.length === 0);
}

async function main() {
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  await testMissingClientFailsClosed();
  await testInjectedClientAllowsStart();
  await testEndToEndStagingPublishViaWiredClient();
  await testForbiddenDestinationStillBlocked();

  _resetRuntimeInstanceForTesting();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log(`\n============================================================`);
  console.log(`TELEGRAM WIRING RESULT: ${passed} passed, ${failed} failed`);
  console.log(`============================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('CRASHED:', e); process.exit(1); });
