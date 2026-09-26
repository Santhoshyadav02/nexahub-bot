const path = require('path');
const { CatalogManager } = require('./catalog_manager');
const config = require('./config.json');

const cm = new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));
const conf18 = Object.values(config.channels).find(c => c.key === '18');
const pageData = cm.getPage('18', 1);

console.log('--- COMPACT PREVIEW ---');
console.log(cm.formatCatalogText(conf18, pageData));
console.log('Keyboard:', JSON.stringify(cm.buildPaginationKeyboard(conf18, pageData)));
