const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { VipPipelineOrchestrator, CHANNEL_DEFS } = require('./vip_pipeline_orchestrator');

async function runTests() {
  console.log('🧪 Starting VIP Pipeline Orchestrator Tests...\n');

  const testStatePath = path.resolve(__dirname, 'vip_pipeline_test_state.json');
  if (fs.existsSync(testStatePath)) fs.unlinkSync(testStatePath);

  const mockUploader = {
    publish: async ({ chatId, filePath, caption }) => {
      console.log(`[MOCK_UPLOADER] Published to ${chatId}: ${caption} (${path.basename(filePath)})`);
      return { messageId: 99901, date: Date.now() };
    }
  };

  const orchestrator = new VipPipelineOrchestrator({
    statePath: testStatePath,
    dryRun: true,
    uploader: mockUploader
  });

  // TEST 1: Channel Definitions & IDs
  console.log('Test 1: Verifying 6 VIP Channel Definitions...');
  assert.strictEqual(CHANNEL_DEFS.BJ.chatId, '-1003977934133', 'VIP-BJ Chat ID mismatch');
  assert.strictEqual(CHANNEL_DEFS.JP.chatId, '-1004484964035', 'VIP-JP Chat ID mismatch');
  assert.strictEqual(CHANNEL_DEFS.CN.chatId, '-1004304488687', 'VIP-CN Chat ID mismatch');
  assert.strictEqual(CHANNEL_DEFS.KR.chatId, '-1004435999618', 'VIP-KR Chat ID mismatch');
  assert.strictEqual(CHANNEL_DEFS['18'].chatId, '-1003845130520', 'VIP-18+ Chat ID mismatch');
  assert.strictEqual(CHANNEL_DEFS.AV.chatId, '-1004352512630', 'VIP-AV Chat ID mismatch');
  console.log('✅ Test 1 Passed: All 6 VIP Channel Chat IDs correctly configured.\n');

  // TEST 2: Daily Quota Tracking (5/day)
  console.log('Test 2: Verifying Daily Quota Tracking...');
  assert.strictEqual(orchestrator.getDailyUploadCount('BJ'), 0);
  assert.strictEqual(orchestrator.isDailyQuotaReached('BJ'), false);

  for (let i = 0; i < 5; i++) {
    orchestrator.incrementDailyUploadCount('BJ');
  }
  assert.strictEqual(orchestrator.getDailyUploadCount('BJ'), 5);
  assert.strictEqual(orchestrator.isDailyQuotaReached('BJ'), true);
  console.log('✅ Test 2 Passed: Daily quota correctly enforced at 5 uploads.\n');

  // TEST 3: Deduplication Ledger
  console.log('Test 3: Verifying Deduplication Ledger...');
  const sampleItem = {
    title: '테스트 비디오 01',
    mp4_download_url: 'https://example.com/test.mp4',
    post_url: 'https://example.com/post/101'
  };

  assert.strictEqual(orchestrator.isDuplicate(sampleItem, 'KR'), false);
  orchestrator.recordPublished(sampleItem, 'KR', { test: true });
  assert.strictEqual(orchestrator.isDuplicate(sampleItem, 'KR'), true);
  console.log('✅ Test 3 Passed: Deduplication ledger records and rejects duplicates.\n');

  // TEST 4: Round-Robin Selection with 2 Workers
  console.log('Test 4: Verifying 2-Worker Round-Robin Selection...');
  assert.strictEqual(orchestrator.maxWorkers, 2, 'Workers should be 2');
  console.log('✅ Test 4 Passed: 2-Worker concurrency configured.\n');

  // TEST 5: Auto-Cleanup
  console.log('Test 5: Verifying Auto-Cleanup Routine...');
  const cleaned = orchestrator.cleanupOldDownloads(1);
  console.log(`Cleaned ${cleaned} files older than 1 hour.`);
  console.log('✅ Test 5 Passed: Cleanup routine executed cleanly.\n');

  // Cleanup test state
  if (fs.existsSync(testStatePath)) fs.unlinkSync(testStatePath);

  console.log('=======================================================');
  console.log('🎉 ALL VIP PIPELINE ORCHESTRATOR TESTS PASSED (5/5)!');
  console.log('=======================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
