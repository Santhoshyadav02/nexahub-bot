/**
 * Utility script to clean all leftover temp files in scraping/downloads
 */

const { ModularScraperPipeline } = require('./modular_scraper_pipeline');

console.log('🧹 Purging all leftover downloaded files across 10 channels...');
const pipeline = new ModularScraperPipeline();
const res = pipeline.cleanAllDownloads();
console.log(`✅ Cleanup completed: Freed ${res.freedMb} MB across ${res.count} files.`);
