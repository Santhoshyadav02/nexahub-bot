const fs = require('fs');
const path = require('path');
const { CatalogManager } = require('./catalog_manager');
const { VipForwarder } = require('./vip_forwarder');

console.log('============================================================');
console.log('🧪 Testing VIP Bot 6-Card Menu & Interactive Catalogs');
console.log('============================================================\n');

const forwarder = new VipForwarder();

// Test 1: Main Menu Text & 6 Buttons
console.log('[Test 1] Testing Main Menu Formatting & 6 Group Cards...');
const menuText = forwarder.formatMainMenuText();
const menuKeyboard = forwarder.buildMainMenuKeyboard();

console.log('--- Rendered Main Menu ---');
console.log(menuText);
console.log('--------------------------');

if (!menuText.includes('18+') || !menuText.includes('CN') || !menuText.includes('JP') ||
    !menuText.includes('KR') || !menuText.includes('BJ.') || !menuText.includes('AV')) {
  throw new Error('❌ Main menu missing one of the 6 group cards!');
}

const buttons = menuKeyboard.inline_keyboard.flat();
if (buttons.length !== 6) {
  throw new Error(`❌ Expected 6 card buttons, got ${buttons.length}`);
}
console.log('✅ 6 Card Buttons Verified:', buttons.map(b => b.text).join(' | '));

// Test 2: Testing Each of the 6 Channel Catalogs
console.log('\n[Test 2] Testing 6 Channel Paginated Catalogs...');
const channelKeys = ['18', 'CN', 'JP', 'KR', 'BJ', 'AV'];

for (const key of channelKeys) {
  const chConfig = Object.values(forwarder.config.channels).find(c => c.key === key);
  const pageData = forwarder.catalogManager.getPage(key, 1);
  const cardText = forwarder.catalogManager.formatCatalogText(chConfig, pageData);
  const keyboard = forwarder.catalogManager.buildPaginationKeyboard(key, pageData);

  console.log(`\n--- [Channel: ${chConfig.buttonLabel}] ---`);
  console.log(cardText.substring(0, 180) + '...');
  console.log('Buttons:', keyboard.inline_keyboard.map(row => row.map(b => b.text).join(' ')).join(' | '));

  // Verify Home Button exists
  const hasHomeBtn = keyboard.inline_keyboard.some(row => row.some(b => b.callback_data === 'vip_main_menu'));
  if (!hasHomeBtn) {
    throw new Error(`❌ Missing Home / Main Menu button for channel ${key}`);
  }
}

console.log('\n============================================================');
console.log('🎉 ALL 6 CARDS & CATALOG TESTS PASSED!');
console.log('============================================================\n');
