/**
 * ============================================================
 * 🤖 AVSEE AUTOMATED MEDIA RESOLUTION FLOW
 * ============================================================
 * Automates:
 *   1. Board Discovery (Auto-extracts post listings)
 *   2. Dedupe Filtering (Selects ONLY genuinely new posts)
 *   3. Headless Player Resolution (Stage 1)
 *   4. Authorized Media Streaming Download (Stage 2)
 *   5. Deep ISOBMFF MP4 Validation & Duration Matching (Stage 2)
 *   6. Canonical Normalization & 12-Topic Routing (Stage 3)
 *   7. Dry-Run Retention Pool Ingestion (Stage 3)
 * 
 * Safety & Compliance:
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 * - Zero production Telegram publication.
 * - Redacted token logging.
 */

const { discoverBoardPosts, filterNewPosts } = require("./board_discovery");
const { AvseePipelineOrchestrator, PIPELINE_STATES } = require("./pipeline_orchestrator");
const { redactUrl } = require("./player_resolver");

/**
 * Runs the fully automated discovery-to-dryrun pipeline for an authorized board URL.
 * 
 * @param {string} boardUrl Authorized board/listing URL
 * @param {object} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   discoveryPass: boolean,
 *   totalDiscovered: number,
 *   newPostsFound: number,
 *   selectedPostId: string|null,
 *   pipelineResult?: object,
 *   error?: string,
 *   diagnosticsText: string
 * }>}
 */
async function runAutomatedFlow(boardUrl, options = {}) {
  const orchestrator = options.orchestrator || new AvseePipelineOrchestrator({
    dryRun: options.dryRun !== undefined ? options.dryRun : true,
    tempDir: options.tempDir,
    stateFilePath: options.stateFilePath,
    apiUrl: options.apiUrl || boardUrl,
    allowedDomains: options.allowedDomains
  });

  const stateStore = orchestrator.stateStore;

  // 1. Board Discovery
  const discovery = await discoverBoardPosts(boardUrl, {
    headless: options.headless !== false,
    pageTimeoutMs: options.discoveryTimeoutMs || 30000,
    limit: options.limit || 20
  });

  if (!discovery.success) {
    return {
      success: false,
      discoveryPass: false,
      totalDiscovered: 0,
      newPostsFound: 0,
      selectedPostId: null,
      error: `Discovery failed: ${discovery.error}`,
      diagnosticsText: `DISCOVERY=FAIL\nFINAL_RESULT=FAIL`
    };
  }

  const allPosts = discovery.posts || [];
  const newPosts = filterNewPosts(allPosts, stateStore);

  if (newPosts.length === 0) {
    const diagText = [
      "DISCOVERY=PASS",
      `NEW_POSTS_FOUND=0`,
      "POST_SELECTED=NONE",
      "DEDUPE=ALL_SEEN",
      "LEDGER=NO_NEW_ITEMS",
      "TELEGRAM=SKIPPED",
      "FINAL_RESULT=PASS"
    ].join("\n");

    return {
      success: true,
      discoveryPass: true,
      totalDiscovered: allPosts.length,
      newPostsFound: 0,
      selectedPostId: null,
      status: "NO_NEW_POSTS",
      diagnosticsText: diagText
    };
  }

  // 2. Select the newest genuinely un-seen post
  const selectedPost = newPosts[0];
  const selectedPostId = selectedPost.itemId || selectedPost.postId;

  // 3. Process the selected post through the integrated orchestrator
  const pipelineResult = await orchestrator.processAuthorizedPost(selectedPost, {
    pageTimeoutMs: options.postTimeoutMs || 15000,
    playerTimeoutMs: options.playerTimeoutMs || 10000,
    logDiagnostics: options.logDiagnostics !== undefined ? options.logDiagnostics : false
  });

  const isSuccess = pipelineResult && pipelineResult.success;

  const diagText = [
    "DISCOVERY=PASS",
    `NEW_POSTS_FOUND=${newPosts.length}`,
    `POST_SELECTED=${selectedPostId}`,
    `PLAYER_RESOLVER=${pipelineResult.playerResolverPass ? "PASS" : "FAIL"}`,
    `MEDIA_SOURCE_FOUND=${pipelineResult.mediaUrlResolved ? "true" : "false"}`,
    `DOWNLOAD=${pipelineResult.downloadPass ? "PASS" : "FAIL"}`,
    `MP4_VALIDATION=${pipelineResult.mp4ValidationPass ? "PASS" : "FAIL"}`,
    `PLAYER_DURATION=${pipelineResult.playerDuration || 0}`,
    `DOWNLOADED_DURATION=${pipelineResult.downloadedDuration || 0}`,
    `DURATION_DELTA=${pipelineResult.durationDelta || 0}`,
    `NORMALIZATION=${pipelineResult.normalizationPass ? "PASS" : "FAIL"}`,
    `CLASSIFICATION=${pipelineResult.classificationPass ? "PASS" : "FAIL"}`,
    `ROUTING=${pipelineResult.routingPass ? "PASS" : "FAIL"}`,
    `DEDUPE=${pipelineResult.dedupeCheckPass ? "PASS" : "FAIL"}`,
    `LEDGER=${pipelineResult.ledgerDecision || "NONE"}`,
    `TELEGRAM=${pipelineResult.telegramPublish || "SKIPPED"}`,
    `FINAL_RESULT=${isSuccess ? "PASS" : "FAIL"}`
  ].join("\n");

  return {
    success: isSuccess,
    discoveryPass: true,
    totalDiscovered: allPosts.length,
    newPostsFound: newPosts.length,
    selectedPostId,
    pipelineResult,
    error: pipelineResult.error || null,
    diagnosticsText: diagText
  };
}

module.exports = {
  runAutomatedFlow
};
