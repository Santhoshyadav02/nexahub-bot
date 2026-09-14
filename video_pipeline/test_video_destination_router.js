/**
 * ============================================================
 * 🧪 TEST: VIDEO DESTINATION ROUTER (Phase 4B)
 * ============================================================
 * Tests deterministic keyword classification across all 10 canonical
 * destination channels using destination_routing_config.json.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { VideoDestinationRouter, normalizeText, WEIGHTS } = require('./video_destination_router');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'destination_routing_config.json');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

async function runRouterTests() {
  console.log('============================================================');
  console.log('🧭 VIDEO DESTINATION ROUTER TEST SUITE (PHASE 4B)');
  console.log('============================================================');

  const router = new VideoDestinationRouter();

  // ============================================================
  // Test 1: Canonical Config Loading & 10 Destinations Verification
  // ============================================================
  section('Test 1: Verify all 10 canonical destination channels');
  const destinations = router.getDestinations();
  check('Router loaded exactly 10 destinations', destinations.length === 10);

  const expectedDestinations = [
    { id: 'DESTINATION_1', name: 'Korean Drama', username: 'ccsfvk', priority: 1 },
    { id: 'DESTINATION_2', name: 'Romance Drama', username: 'cccsefk', priority: 2 },
    { id: 'DESTINATION_3', name: 'Comedy Drama', username: 'e5brygh', priority: 3 },
    { id: 'DESTINATION_4', name: 'Action Drama', username: 'ccdjxc', priority: 4 },
    { id: 'DESTINATION_5', name: 'Thriller Drama', username: 'vsdxda', priority: 5 },
    { id: 'DESTINATION_6', name: 'Historical Drama', username: 'tfccdet', priority: 6 },
    { id: 'DESTINATION_7', name: 'Mystery Drama', username: 'sfgfem', priority: 7 },
    { id: 'DESTINATION_8', name: 'Slice of Life', username: 'ddkicr', priority: 8 },
    { id: 'DESTINATION_9', name: 'Family Drama', username: 'cccddghhgf', priority: 9 },
    { id: 'DESTINATION_10', name: 'Youth Drama', username: 'bzd4wrf', priority: 10 }
  ];

  for (let i = 0; i < expectedDestinations.length; i++) {
    const exp = expectedDestinations[i];
    const actual = destinations.find(d => d.id === exp.id);
    check(`Destination ${exp.id} (${exp.name}) exists with username @${exp.username}`,
      actual && actual.name === exp.name && actual.username === exp.username && actual.priority === exp.priority);
  }

  // ============================================================
  // Test 2: Category Matching for each of the 10 destinations
  // ============================================================
  section('Test 2: Known keyword routing for all 10 destination channels');

  const testCases = [
    {
      title: 'Korean Drama Special Episode',
      expectedDest: 'DESTINATION_1',
      desc: 'Destination 1: Korean Drama (high keyword)'
    },
    {
      title: 'A Touching Romance Drama Love Story',
      expectedDest: 'DESTINATION_2',
      desc: 'Destination 2: Romance Drama'
    },
    {
      title: 'New Rom-Com Comedy Drama Release',
      expectedDest: 'DESTINATION_3',
      desc: 'Destination 3: Comedy Drama'
    },
    {
      title: 'High-Octane Action Drama Special',
      expectedDest: 'DESTINATION_4',
      desc: 'Destination 4: Action Drama'
    },
    {
      title: 'Gripping Thriller Drama Finale',
      expectedDest: 'DESTINATION_5',
      desc: 'Destination 5: Thriller Drama'
    },
    {
      title: 'Royal Historical Drama Premiere',
      expectedDest: 'DESTINATION_6',
      desc: 'Destination 6: Historical Drama'
    },
    {
      title: 'Detective Mystery Drama Case File',
      expectedDest: 'DESTINATION_7',
      desc: 'Destination 7: Mystery Drama'
    },
    {
      title: 'Warm Slice of Life Everyday Story',
      expectedDest: 'DESTINATION_8',
      desc: 'Destination 8: Slice of Life'
    },
    {
      title: 'Heartwarming Family Drama Reunion',
      expectedDest: 'DESTINATION_9',
      desc: 'Destination 9: Family Drama'
    },
    {
      title: 'Campus Romance Youth Drama Debut',
      expectedDest: 'DESTINATION_10',
      desc: 'Destination 10: Youth Drama'
    }
  ];

  for (const tc of testCases) {
    const res = router.routeMedia({ mediaId: 'test_m1', title: tc.title });
    check(`${tc.desc} -> ${tc.expectedDest}`,
      res.status === 'CLASSIFIED' && res.primaryDestination.id === tc.expectedDest,
      `got ${res.primaryDestination ? res.primaryDestination.id : 'null'}`);
  }

  // ============================================================
  // Test 3: Multilingual & Case-Insensitive Matching (Korean, English)
  // ============================================================
  section('Test 3: Case-insensitive and Multilingual Matching');
  const koreanCase = router.routeMedia({ mediaId: 'k1', title: '로맨스 드라마 첫사랑 이야기' });
  check('Korean text matched Romance Drama / Youth Drama keywords',
    koreanCase.status === 'CLASSIFIED' && (koreanCase.primaryDestination.id === 'DESTINATION_2' || koreanCase.primaryDestination.id === 'DESTINATION_10'));

  const upperCase = router.routeMedia({ mediaId: 'u1', title: 'KOREAN DRAMA HIGHLIGHTS' });
  check('Uppercase string matched correctly', upperCase.primaryDestination.id === 'DESTINATION_1');

  // ============================================================
  // Test 4: Multiple Matching Categories (Score & Tie-breaking)
  // ============================================================
  section('Test 4: Multiple matching categories resolved by score/priority');
  // Title contains low keyword for dest 1 ('episode') and high keyword for dest 4 ('action drama')
  const multiMatch = router.routeMedia({ mediaId: 'm1', title: 'Action Drama Episode Highlights' });
  check('Higher weighted keyword wins (Action Drama 10pts vs episode 2pts -> DESTINATION_4)',
    multiMatch.primaryDestination.id === 'DESTINATION_4');
  check('allMatches contains both matched destinations',
    multiMatch.allMatches.length >= 2);

  // ============================================================
  // Test 5: No Keyword Match & Fallback Handling
  // ============================================================
  section('Test 5: No keyword match fallback handling');
  const noMatch = router.routeMedia({ mediaId: 'nm1', title: 'Completely Unrelated Generic Clip 12345' });
  check('No keyword match returns FALLBACK_ASSIGNED', noMatch.status === 'FALLBACK_ASSIGNED');
  check('Fallback destination assigned default DESTINATION_1', noMatch.primaryDestination.id === 'DESTINATION_1');
  check('fallbackUsed is true', noMatch.fallbackUsed === true);
  check('reasonCode is NO_KEYWORD_MATCH', noMatch.reasonCode === 'NO_KEYWORD_MATCH');

  // ============================================================
  // Test 6: Empty / Invalid Title Handling
  // ============================================================
  section('Test 6: Empty or invalid title handling');
  const emptyTitle = router.routeMedia({ mediaId: 'e1', title: '' });
  check('Empty title returns FALLBACK_ASSIGNED', emptyTitle.status === 'FALLBACK_ASSIGNED');
  check('reasonCode is EMPTY_TITLE', emptyTitle.reasonCode === 'EMPTY_TITLE');

  const invalidMedia = router.routeMedia(null);
  check('Null media returns UNCLASSIFIED', invalidMedia.status === 'UNCLASSIFIED');

  // ============================================================
  // Test 7: Determinism Verification
  // ============================================================
  section('Test 7: Determinism (100 iterations on identical input)');
  const sampleTitle = 'A Touching Romance Drama Love Story';
  let allIdentical = true;
  const firstResult = JSON.stringify(router.routeMedia({ mediaId: 'det1', title: sampleTitle }).primaryDestination);

  for (let i = 0; i < 100; i++) {
    const current = JSON.stringify(router.routeMedia({ mediaId: 'det1', title: sampleTitle }).primaryDestination);
    if (current !== firstResult) {
      allIdentical = false;
      break;
    }
  }
  check('100 iterations produce 100% identical primaryDestination', allIdentical);

  // ============================================================
  // Test 8: Batch Routing
  // ============================================================
  section('Test 8: Batch Routing (routeBatch)');
  const batchList = [
    { mediaId: 'b1', title: 'Korean Drama 1' },
    { mediaId: 'b2', title: 'Action Drama 2' },
    { mediaId: 'b3', title: 'Generic 3' }
  ];
  const batchResults = router.routeBatch(batchList);
  check('routeBatch returns array of 3 decisions', Array.isArray(batchResults) && batchResults.length === 3);
  check('Item 1 routed to DESTINATION_1', batchResults[0].primaryDestination.id === 'DESTINATION_1');
  check('Item 2 routed to DESTINATION_4', batchResults[1].primaryDestination.id === 'DESTINATION_4');
  check('Item 3 routed to fallback DESTINATION_1', batchResults[2].primaryDestination.id === 'DESTINATION_1');

  // ============================================================
  // Test 9: Production Config Integrity
  // ============================================================
  section('Test 9: Production routing config remains unmodified');
  const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  check('destination_routing_config.json contains 10 destinations on disk',
    rawConfig.destinations && Object.keys(rawConfig.destinations).length === 10);

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRouterTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
