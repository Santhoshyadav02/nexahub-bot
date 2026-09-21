/**
 * ============================================================
 * 🤖 BOT 2 STANDALONE ENTRY POINT (Scraping-1 Sub-Project)
 * ============================================================
 * Independent bot runtime completely decoupled from Bot 1.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { getBot2PipelineInstance } = require('./bot2_pipeline/bot2_pipeline_orchestrator');

const BOT2_TOKEN = process.env.BOT2_TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN_2 || null;

console.log('\n======================================================');
console.log('🤖 NEXAHUB BOT 2 - SCRAPING-1 AUTOMATION RUNTIME');
console.log('======================================================\n');

let bot2 = null;
if (BOT2_TOKEN && !BOT2_TOKEN.includes('PLACEHOLDER')) {
  try {
    bot2 = new TelegramBot(BOT2_TOKEN, { polling: true });
    console.log('✅ Bot 2 Telegram Client connected with Polling.');
  } catch (err) {
    console.error('❌ Failed to initialize Bot 2 Telegram client:', err.message);
  }
} else {
  console.log('ℹ️ BOT2_TELEGRAM_TOKEN not set or placeholder. Running in dry-run/local test mode.');
}

const pipeline = getBot2PipelineInstance({
  telegramClient: bot2,
  workers: Number(process.env.BOT2_PIPELINE_WORKERS) || 2,
  dailyQuota: Number(process.env.BOT2_PIPELINE_DAILY_QUOTA) || 5,
  maxDailyTotal: Number(process.env.BOT2_PIPELINE_MAX_DAILY) || 30
});

const intervalMs = Number(process.env.BOT2_PIPELINE_INTERVAL_MS) || (2 * 60 * 60 * 1000);
pipeline.startScheduler(intervalMs);

console.log(`✅ [BOT 2] Pipeline Scheduler active (every ${intervalMs / 1000 / 60}m across 6 channels).`);

module.exports = {
  bot2,
  pipeline
};
