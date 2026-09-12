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
    { id: 'DESTINATION_1', name: 'Romantic Vibe', username: 'ccsfvk', priority: 1 },
    { id: 'DESTINATION_2', name: 'Dating', username: 'cccsefk', priority: 2 },
    { id: 'DESTINATION_3', name: 'Romance', username: 'e5brygh', priority: 3 },
    { id: 'DESTINATION_4', name: 'Crotch', username: 'ccdjxc', priority: 4 },
    { id: 'DESTINATION_5', name: 'Mosa', username: 'vsdxda', priority: 5 },
    { id: 'DESTINATION_6', name: 'Bunny Girl Cosplay Date', username: 'tfccdet', priority: 6 },
    { id: 'DESTINATION_7', name: 'Lustful Hostess', username: 'sfgfem', priority: 7 },
    { id: 'DESTINATION_8', name: 'Concubine', username: 'ddkicr', priority: 8 },
    { id: 'DESTINATION_9', name: 'Saki Mizumi', username: 'cccddghhgf', priority: 9 },
    { id: 'DESTINATION_10', name: 'A Muse', username: 'bzd4wrf', priority: 10 }
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
      title: 'Romantic Vibe Special Episode',
      expectedDest: 'DESTINATION_1',
      desc: 'Destination 1: Romantic Vibe (high keyword)'
    },
    {
      title: 'Evergrande Troupe Private Meeting Scandal',
      expectedDest: 'DESTINATION_2',
      desc: 'Destination 2: Evergrande Troupe / Dating'
    },
    {
      title: 'Myanmar Women First Love Story',
      expectedDest: 'DESTINATION_3',
      desc: 'Destination 3: Myanmar Women / Romance'
    },
    {
      title: 'Sister Snake Between Her Legs Drunk Video',
      expectedDest: 'DESTINATION_4',
      desc: 'Destination 4: Sister Snake / Crotch'
    },
    {
      title: 'Has Work Tanhua Uncensored Stream',
      expectedDest: 'DESTINATION_5',
      desc: 'Destination 5: Has Work / Tanhua / Mosa'
    },
    {
      title: 'Bunny Girl Cosplay Date Secret Party',
      expectedDest: 'DESTINATION_6',
      desc: 'Destination 6: Bunny Girl Cosplay Date'
    },
    {
      title: 'Award-winning Housekeeper Da Ci Ge Viral Story',
      expectedDest: 'DESTINATION_7',
      desc: 'Destination 7: Da Ci Ge / Lustful Hostess'
    },
    {
      title: 'Senior Year Love Story Delicious Sister Rice Bowl',
      expectedDest: 'DESTINATION_8',
      desc: 'Destination 8: Senior Year Love Story / Concubine'
    },
    {
      title: 'Sichuan Mother & Son Japanese Exclusive',
      expectedDest: 'DESTINATION_9',
      desc: 'Destination 9: Sichuan Mother & Son / Saki Mizumi'
    },
    {
      title: 'Hu Siyuan 91porn Madou Model Photoshoot',
      expectedDest: 'DESTINATION_10',
      desc: 'Destination 10: Hu Siyuan / A Muse'
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
  const koreanCase = router.routeMedia({ mediaId: 'k1', title: '케이팝 열애설 비밀 데이트' });
  check('Korean text matched Romantic Vibe / Dating keywords',
    koreanCase.status === 'CLASSIFIED' && (koreanCase.primaryDestination.id === 'DESTINATION_1' || koreanCase.primaryDestination.id === 'DESTINATION_2'));

  const upperCase = router.routeMedia({ mediaId: 'u1', title: 'ROMANTIC VIBE HIGHLIGHTS' });
  check('Uppercase string matched correctly', upperCase.primaryDestination.id === 'DESTINATION_1');

  // ============================================================
  // Test 4: Multiple Matching Categories (Score & Tie-breaking)
  // ============================================================
  section('Test 4: Multiple matching categories resolved by score/priority');
  // Title contains low keyword for dest 1 ('mood') and high keyword for dest 6 ('bunny girl')
  const multiMatch = router.routeMedia({ mediaId: 'm1', title: 'Bunny Girl in a Romantic Mood' });
  check('Higher weighted keyword wins (Bunny Girl 10pts vs Mood 2pts -> DESTINATION_6)',
    multiMatch.primaryDestination.id === 'DESTINATION_6');
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
  const sampleTitle = 'Evergrande Troupe Private Meeting Scandal';
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
    { mediaId: 'b1', title: 'Romantic Vibe 1' },
    { mediaId: 'b2', title: 'Bunny Girl 2' },
    { mediaId: 'b3', title: 'Generic 3' }
  ];
  const batchResults = router.routeBatch(batchList);
  check('routeBatch returns array of 3 decisions', Array.isArray(batchResults) && batchResults.length === 3);
  check('Item 1 routed to DESTINATION_1', batchResults[0].primaryDestination.id === 'DESTINATION_1');
  check('Item 2 routed to DESTINATION_6', batchResults[1].primaryDestination.id === 'DESTINATION_6');
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
