/**
 * Test Suite: Playwright Output JSON -> Downloader Integration
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('\n' + '='.repeat(60));
console.log('🔍 Test: Playwright JSON Payload Schema Compatibility');
console.log('='.repeat(60));

const { ModularScraperPipeline } = require('./modular_scraper_pipeline');
const pipeline = new ModularScraperPipeline();

const samplePlaywrightPayload = [
  {
    "page_url": "https://02.avsee.is/bbs/board.php?bo_table=javc&wr_id=2150369",
    "title": "USAG-098",
    "video_urls": [
      "https://data.cdn.avsee.is/bcdn_token=WjecmPuOUo9UystXhdrXZQPMN3iSqzitWV9iNzmpMRU&expires=1789298433&token_path=%2Fa%2Fh%2F2026%2F09%2F13%2FUSAG-098.mp4/a/h/2026/09/13/USAG-098.mp4"
    ],
    "status": "found",
    "error": ""
  },
  {
    "page_url": "https://02.avsee.is/bbs/board.php?bo_table=javc&wr_id=2150368",
    "title": "SS-155 키노시타 리리코",
    "video_urls": [
      "https://data.cdn.avsee.is/bcdn_token=NNcE9n0ChlXjZghmKTAUINFHH-xOmoueQB6ndWpCvhA&expires=1789298434&token_path=%2Fa%2Fh%2F2026%2F09%2F13%2FSS-155.mp4/a/h/2026/09/13/SS-155.mp4"
    ],
    "status": "found",
    "error": ""
  },
  {
    "page_url": "https://02.avsee.is/bbs/board.php?bo_table=javc&wr_id=2149347",
    "title": "OTIN-028 코코노이 스나오",
    "video_urls": [],
    "status": "error",
    "error": "Frame.evaluate: Connection closed while reading from the driver"
  }
];

const channelConf = {
  key: "javc",
  name: "가랑이(CN)",
  chatId: "-1004481385613"
};

const candidates = pipeline._getNonDuplicateCandidates(channelConf, samplePlaywrightPayload);
console.log(`Candidate count resolved: ${candidates.length}`);

assert.strictEqual(candidates.length, 2, "Must extract exactly 2 valid video items and skip the 1 empty/error item");
assert.strictEqual(candidates[0].title, "USAG-098");
assert.strictEqual(candidates[0].mp4_download_url, samplePlaywrightPayload[0].video_urls[0]);
assert.strictEqual(candidates[0].post_url, samplePlaywrightPayload[0].page_url);

assert.strictEqual(candidates[1].title, "SS-155 키노시타 리리코");
assert.strictEqual(candidates[1].mp4_download_url, samplePlaywrightPayload[1].video_urls[0]);

console.log('  ✅ Successfully parsed Playwright JSON schema into downloader candidates!');
console.log('\n' + '='.repeat(60));
console.log('RESULT: Playwright to Downloader Schema Test PASSED! 🚀');
console.log('='.repeat(60) + '\n');
