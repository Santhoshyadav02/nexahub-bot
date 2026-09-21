/**
 * ============================================================
 * 🧪 BOT 2 PIPELINE TEST SUITE (Local Verification)
 * ============================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { Bot2QuotaTracker } = require('./bot2_quota_tracker');
const { Bot2PipelineOrchestrator } = require('./bot2_pipeline_orchestrator');

const TEST_DIR = path.join(__dirname, '..', 'scratch', 'test_bot2_pipeline_state');
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${desc}: ${err.message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n============================================================');
  console.log('🔍 Test 1: Bot 2 (Scraping-1) Channel Configuration & Scraper Scripts');
  console.log('============================================================');

  const configPath = path.join(__dirname, 'bot2_channel_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const channels = Object.keys(config.channels);

  it('Exactly 6 channels configured for Bot 2', () => {
    assert.strictEqual(channels.length, 6);
  });

  const expectedKeys = ['av', 'bj', 'jp', 'kr', 'krx', 'xchina'];
  for (const key of expectedKeys) {
    it(`Channel "${key}" is configured with valid scraper script`, () => {
      const conf = config.channels[key];
      assert(conf, `Config for ${key} exists`);
      const scriptPath = path.join(__dirname, '..', conf.scraperScript);
      assert(fs.existsSync(scriptPath), `Scraper script exists: ${conf.scraperScript}`);
    });
  }

  console.log('\n============================================================');
  console.log('🔍 Test 2: Bot 2 Quota Tracker & Ceiling Enforcement');
  console.log('============================================================');

  const testStatePath = path.join(TEST_DIR, 'bot2_test_quota.json');
  if (fs.existsSync(testStatePath)) fs.unlinkSync(testStatePath);

  const tracker = new Bot2QuotaTracker({
    stateFilePath: testStatePath,
    defaultDailyQuota: 5
  });

  it('Initial canPublish(av) is true with 5 remaining', () => {
    assert.strictEqual(tracker.canPublish('av'), true);
    assert.strictEqual(tracker.getRemainingQuota('av'), 5);
  });

  it('Enforces daily limit of 5 publishes', () => {
    for (let i = 1; i <= 5; i++) {
      tracker.recordPublish('av', { title: `Test Video ${i}` });
    }
    assert.strictEqual(tracker.getPublishedCountToday('av'), 5);
    assert.strictEqual(tracker.getRemainingQuota('av'), 0);
    assert.strictEqual(tracker.canPublish('av'), false);
    assert.strictEqual(tracker.canPublish('bj'), true); // Other channel unaffected
  });

  console.log('\n============================================================');
  console.log('🔍 Test 3: Bot 2 Deduplication Engine');
  console.log('============================================================');

  it('Detects duplicate titles regardless of case or bracket variations', () => {
    assert.strictEqual(tracker.isDuplicateTitle('Test Video 1'), true);
    assert.strictEqual(tracker.isDuplicateTitle('[HD] test_video 1'), true);
    assert.strictEqual(tracker.isDuplicateTitle('Unique Video XYZ'), false);
  });

  console.log('\n============================================================');
  console.log('🔍 Test 4: Bot 2 Pipeline Orchestrator Initialization');
  console.log('============================================================');

  const orchestrator = new Bot2PipelineOrchestrator({
    configPath,
    quotaTracker: tracker,
    workers: 2,
    enableCleanup: false
  });

  it('Clamps workers to 2', () => {
    assert.strictEqual(orchestrator.workers, 2);
  });

  it('Generates unique mediaId hash', () => {
    const id1 = orchestrator.generateMediaId('Title A', 'http://post.com/1');
    const id2 = orchestrator.generateMediaId('Title A', 'http://post.com/1');
    const id3 = orchestrator.generateMediaId('Title B', 'http://post.com/2');
    assert.strictEqual(id1, id2);
    assert.notStrictEqual(id1, id3);
  });

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
