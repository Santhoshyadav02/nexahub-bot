/**
 * test_source_fallback_routing.js
 * 
 * Unit Test Suite for Stage 5 Source-Based Fallback Routing Engine
 */

const assert = require("assert");
const {
  SOURCE_FALLBACK_CONFIG,
  SourceFallbackRouter
} = require("./source_fallback_routing");

let totalTests = 0;
let passedTests = 0;

function runTest(description, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`✅ [PASS] ${totalTests}. ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${description}`);
    console.error(`   Error: ${err.message}`);
  }
}

console.log("==================================================");
console.log("🧪 RUNNING SOURCE FALLBACK ROUTING UNIT TESTS");
console.log("==================================================\n");

// 1. Direct match priority
runTest("Direct keyword match takes precedence over source fallback", () => {
  const router = new SourceFallbackRouter();
  // Source is @korea18movie (fallback DESTINATION_3 Romance), but caption explicitly matches Crotch
  const item = {
    sourceChannelId: "1762071168",
    sourceUsername: "korea18movie",
    messageId: "101",
    caption: "Between Her Legs Drunk [Full HD]"
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "DIRECT_KEYWORD_MATCH");
  assert.strictEqual(decision.fallbackApplied, false);
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_4"); // Crotch
  assert.strictEqual(decision.matchedCategory, "Crotch");
});

// 2. Source fallback application
runTest("Source fallback routes blank caption from @xuexiziliao2 to DESTINATION_10 (A Muse)", () => {
  const router = new SourceFallbackRouter();
  const item = {
    sourceChannelId: "1521978999",
    sourceUsername: "xuexiziliao2",
    messageId: "906500",
    caption: ""
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "SOURCE_LEVEL_FALLBACK");
  assert.strictEqual(decision.fallbackApplied, true);
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_10");
  assert.strictEqual(decision.matchedCategory, "A Muse");
  assert.strictEqual(decision.confidence, "HIGH");
});

runTest("Source fallback routes @DSDSZY4 to DESTINATION_5 (Mosa)", () => {
  const router = new SourceFallbackRouter();
  const item = {
    sourceChannelId: "3674181298",
    sourceUsername: "DSDSZY4",
    messageId: "18200",
    caption: "Random video without specific keywords"
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "SOURCE_LEVEL_FALLBACK");
  assert.strictEqual(decision.fallbackApplied, true);
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_5");
  assert.strictEqual(decision.matchedCategory, "Mosa");
});

// 3. Low confidence fallback rejection
runTest("LOW confidence fallback remains UNCLASSIFIED for manual review", () => {
  const customConfig = {
    "9999": {
      username: "ambiguous_channel",
      enabled: true,
      fallbackDestination: "DESTINATION_1",
      fallbackCategory: "Romantic Vibe",
      reason: "Weak guess",
      confidence: "LOW"
    }
  };
  const router = new SourceFallbackRouter(customConfig);
  const item = {
    sourceChannelId: "9999",
    sourceUsername: "ambiguous_channel",
    messageId: "1",
    caption: "No matching text"
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "REJECTED_LOW_CONFIDENCE_FALLBACK");
  assert.strictEqual(decision.fallbackApplied, false);
  assert.strictEqual(decision.confidence, "UNCLASSIFIED");
});

// 4. Disabled source fallback
runTest("Disabled source fallback remains UNCLASSIFIED", () => {
  const customConfig = {
    "1762071168": {
      username: "korea18movie",
      enabled: false,
      fallbackDestination: "DESTINATION_3",
      confidence: "MEDIUM"
    }
  };
  const router = new SourceFallbackRouter(customConfig);
  const item = {
    sourceChannelId: "1762071168",
    sourceUsername: "korea18movie",
    messageId: "2",
    caption: "Unmatched movie"
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "UNCLASSIFIED");
  assert.strictEqual(decision.fallbackApplied, false);
  assert.strictEqual(decision.destinationChannelId, null);
});

// 5. Unknown source channel
runTest("Unknown source channel without match remains UNCLASSIFIED", () => {
  const router = new SourceFallbackRouter();
  const item = {
    sourceChannelId: "88888888",
    sourceUsername: "unregistered",
    messageId: "3",
    caption: "Completely unknown text sequence"
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.routingStage, "UNCLASSIFIED");
  assert.strictEqual(decision.destinationChannelId, null);
});

// 6. Batch comparison metrics
runTest("Batch processing computes before vs after metrics and delta accurately", () => {
  const router = new SourceFallbackRouter();
  const items = [
    // 1. Direct match
    { sourceChannelId: "1762071168", sourceUsername: "korea18movie", messageId: "1", caption: "Romantic Vibe Episode" },
    // 2. Unclassified before -> Fallback to DESTINATION_10 after
    { sourceChannelId: "1521978999", sourceUsername: "xuexiziliao2", messageId: "2", caption: "" },
    // 3. Unclassified before -> Fallback to DESTINATION_8 after
    { sourceChannelId: "1518888395", sourceUsername: "koreannarchive", messageId: "3", caption: "" }
  ];

  const summary = router.processBatch(items);

  assert.strictEqual(summary.totalVideos, 3);
  assert.strictEqual(summary.beforeFallback.classified, 1);
  assert.strictEqual(summary.beforeFallback.unclassified, 2);
  assert.strictEqual(summary.afterFallback.classified, 3);
  assert.strictEqual(summary.afterFallback.unclassified, 0);
  assert.strictEqual(summary.afterFallback.newlyClassified, 2);
  assert.strictEqual(summary.fallbackAppliedCount, 2);
});

// 8. Source 8 @wanwu5555 routing test
runTest("Source 8 @wanwu5555 remains UNCLASSIFIED when no reliable category matches", () => {
  const router = new SourceFallbackRouter();
  const item = {
    sourceChannelId: "3832681538",
    sourceUsername: "wanwu5555",
    messageId: "76611",
    caption: ""
  };
  const decision = router.routeItem(item);

  assert.strictEqual(decision.confidence, "UNCLASSIFIED");
  assert.strictEqual(decision.destinationChannelId, null);
});

console.log("\n==================================================");
console.log(`📊 SOURCE FALLBACK ROUTING TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
