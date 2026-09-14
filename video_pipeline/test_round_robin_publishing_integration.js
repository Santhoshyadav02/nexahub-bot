/* Local-only integration: mock Telegram client, no network or real chat IDs. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { BatchState } = require('./batch_state');
const { BatchCycleManager } = require('./batch_cycle_manager');

const EXPECTED = [
  '-1003780478806', '-1004464504918', '-1004384169456', '-1004419758275', '-1003725861834',
  '-1004416217845', '-1004486764871', '-1004481385613', '-1004483241550', '-1003786693669',
  '-1003780478806', '-1004464504918'
];

async function run() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexahub-video-routing-'));
  const ledgerPath = path.join(work, 'publish.json');
  const sent = [];
  let failNext = true;
  const client = {
    async sendVideo(chatId) {
      assert.notStrictEqual(chatId, 'me', 'Saved Messages must never be a target');
      if (failNext) { failNext = false; throw new Error('mock transport failure'); }
      sent.push(chatId);
      return { message_id: sent.length + 1000 };
    }
  };
  const makePublisher = () => {
    const ledger = new PublishLedger({ ledgerPath });
    return new VideoBatchPublisher({
      telegramClient: client,
      publishLedger: ledger,
      mediaCleaner: new MediaCleaner({ publishLedger: ledger, allowedDirectory: work }),
      mediaValidator: async () => ({ valid: true }),
      enableCleanup: true,
      maxRetries: 0,
      rateLimitDelayMs: 0
    });
  };
  const media = (id) => {
    const filePath = path.join(work, `${id}.mp4`);
    fs.writeFileSync(filePath, `local fixture ${id}`);
    return { mediaId: id, title: `Korean Web Series Episode ${id}`, filePath, sourceMode: 'fixture' };
  };

  // A failure locks DESTINATION_1 but does not move the persisted pointer.
  let publisher = makePublisher();
  const failed = await publisher.publishSingleItem('local', media('retry-item'));
  assert.strictEqual(failed.status, 'FAILED');
  assert.strictEqual(publisher.publishLedger.getNextRoundRobinIndex(), 0);
  const retried = await publisher.publishSingleItem('local', media('retry-item'));
  assert.strictEqual(retried.status, 'PUBLISHED');
  assert.strictEqual(retried.destinationId, EXPECTED[0]);
  assert.strictEqual(publisher.publishLedger.getNextRoundRobinIndex(), 1);
  assert.strictEqual(fs.existsSync(path.join(work, 'retry-item.mp4')), false, 'cleanup follows confirmed publish');

  // Reload between every publication: the next destination is persistent.
  for (let i = 1; i < 12; i++) {
    publisher = makePublisher();
    const item = media(`item-${i}`);
    const result = await publisher.publishSingleItem('local', item);
    assert.strictEqual(result.status, 'PUBLISHED');
    assert.strictEqual(result.destinationId, EXPECTED[i]);
    assert.strictEqual(fs.existsSync(item.filePath), false, 'confirmed media is cleaned');
  }
  assert.deepStrictEqual(sent, EXPECTED);

  // Same media remains idempotent and does not advance or send twice.
  publisher = makePublisher();
  const before = publisher.publishLedger.getNextRoundRobinIndex();
  const duplicate = await publisher.publishSingleItem('local', { mediaId: 'item-11', title: 'Korean Web Series Episode', filePath: path.join(work, 'item-11.mp4') });
  assert.strictEqual(duplicate.status, 'SKIPPED_ALREADY_PUBLISHED');
  assert.strictEqual(sent.length, 12);
  assert.strictEqual(publisher.publishLedger.getNextRoundRobinIndex(), before);
  assert.strictEqual(publisher.publishLedger.isPublished('item-11', EXPECTED[11]), true);

  // BatchCycleManager's existing publish boundary must preserve the selected
  // target all the way to the injected Telegram client.
  const chainDir = path.join(work, 'manager-chain');
  fs.mkdirSync(chainDir);
  const chainOutputDir = path.join(chainDir, 'output');
  const chainDownloadsDir = path.join(chainDir, 'downloads');
  fs.mkdirSync(chainOutputDir);
  fs.mkdirSync(chainDownloadsDir);
  const chainState = new BatchState({ statePath: path.join(chainDir, 'batch.json') });
  const chainLedger = new PublishLedger({ ledgerPath: path.join(chainDir, 'publish.json') });
  const chainCalls = [];
  const chainPublisher = new VideoBatchPublisher({
    telegramClient: { sendVideo: async (chatId) => { chainCalls.push(chatId); return { message_id: 2001 }; } },
    batchState: chainState,
    publishLedger: chainLedger,
    mediaCleaner: new MediaCleaner({ publishLedger: chainLedger, allowedDirectory: chainDir }),
    mediaValidator: async () => ({ valid: true }), enableCleanup: true, rateLimitDelayMs: 0
  });
  const chainItem = { mediaId: 'manager-item', title: 'Korean Web Series Fixture', filePath: path.join(chainDir, 'manager-item.mp4') };
  fs.writeFileSync(chainItem.filePath, 'manager fixture');
  chainState.startCycle('manager-cycle', { media: [chainItem], status: 'BATCH_READY' });
  const manager = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1/local-fixture-only',
    outputDir: chainOutputDir,
    downloadsDir: chainDownloadsDir,
    batchState: chainState,
    videoBatchPublisher: chainPublisher
  });
  const chainResult = await manager.publishCycle('manager-cycle');
  assert.strictEqual(chainResult.status, 'COMPLETED');
  assert.deepStrictEqual(chainCalls, [EXPECTED[0]]);
  assert.strictEqual(fs.existsSync(chainItem.filePath), false);
  console.log('PASS: local round-robin publisher integration (12 sends, persistence, failure lock, dedupe, cleanup)');
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
