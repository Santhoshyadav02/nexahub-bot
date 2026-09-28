/**
 * ============================================================
 * 🎬 VIP-2 SCRAPER MANAGER (BJ & AV AUTOMATED ENGINE)
 * ============================================================
 * - Scrapes fresh BJ & AV videos from 02.avsee.is (Korean BJ & JAV Caption)
 * - Daily quota: 5-7 videos per category per day
 * - Multi-destination publishing:
 *    1. Channel (-1004361683750): Teaser / Preview post + Korean Title & Invite
 *    2. Discussion Group (-1004442518512): Full Video in discussion thread
 *    3. Extra Group (-1003983458986): Full Video + Korean Title & Hashtags
 * - Immediate local file cleanup after upload
 * - Complete deduplication tracking
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const STATE_FILE = path.resolve(__dirname, 'scraper_state.json');
const DOWNLOADS_DIR = path.resolve(__dirname, 'downloads');

class Vip2ScraperManager {
  constructor(pipeline = null) {
    this.pipeline = pipeline;
    this.apiId = Number(process.env.TELEGRAM_API_ID || 30473305);
    this.apiHash = process.env.TELEGRAM_API_HASH || '6d91c6c87e7ff45433bb3aa90282e412';
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || '';

    this.destChatId = process.env.VIP2_DEST_CHAT_ID || '-1004361683750';
    this.discussionChatId = process.env.VIP2_DISCUSSION_CHAT_ID || '-1004442518512';
    this.extraGroupChatId = process.env.VIP2_EXTRA_GROUP_CHAT_ID || '-1003983458986';
    this.destInviteLink = process.env.VIP2_DEST_INVITE_LINK || 'https://t.me/+HKD-EF-iSK5iN2Rh';

    // Daily quota: 5 to 7 videos per category per day
    this.dailyQuotaPerCategory = 6;

    this.pythonPath = process.env.PYTHON_PATH || (fs.existsSync('/opt/nexahub-bot/.venv/bin/python3') ? '/opt/nexahub-bot/.venv/bin/python3' : 'python3');
    this.client = null;
    this.isJobRunning = false;
    this.timer = null;

    this.state = this._loadState();
  }

  _loadState() {
    const today = new Date().toISOString().slice(0, 10);
    let state = {
      date: today,
      bj_count: 0,
      av_count: 0,
      processed_urls: []
    };

    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (data.date === today) {
          state = data;
        } else {
          state.processed_urls = data.processed_urls ? data.processed_urls.slice(-2000) : [];
        }
      }
    } catch (e) {
      console.warn('⚠️ [VIP2_SCRAPER] Could not load scraper_state.json:', e.message);
    }
    return state;
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [VIP2_SCRAPER] Failed to save scraper state:', e.message);
    }
  }

  async _getClient() {
    if (this.pipeline && this.pipeline.client) {
      return this.pipeline.client;
    }
    if (this.client) {
      return this.client;
    }
    this.client = new TelegramClient(
      new StringSession(this.sessionString),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5, timeout: 30000 }
    );
    await this.client.connect();
    return this.client;
  }

  async _findDiscussionRootMsgId(client, channelPostId, maxWaitSec = 8) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitSec * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const msgs = await client.getMessages(this.discussionChatId, { limit: 12 });
        for (const m of msgs) {
          if (m.fwdFrom && Number(m.fwdFrom.channelPost) === Number(channelPostId)) {
            return m.id;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  async scrapeBoardItems(category = 'bj', limit = 6) {
    const board = category === 'bj' ? 'korea' : 'caption';
    const scraperScript = path.resolve(__dirname, 'scrapers', category === 'bj' ? 'bj_scraper.py' : 'av_scraper.py');
    const tempJson = path.resolve(__dirname, 'scrapers', `${category}_temp.json`);

    console.log(`\n🔍 [VIP2_SCRAPER] Scraping latest ${category.toUpperCase()} posts (limit ${limit}) from https://02.avsee.is/${board}...`);

    try {
      const cmd = `"${this.pythonPath}" "${scraperScript}" --board ${board} --limit ${limit} --output "${tempJson}"`;
      const { stdout } = await execPromise(cmd, { timeout: 300000, cwd: path.resolve(__dirname, 'scrapers') });
      console.log(`📄 [VIP2_SCRAPER] Scraper complete. Log:\n`, stdout.trim());

      if (fs.existsSync(tempJson)) {
        const items = JSON.parse(fs.readFileSync(tempJson, 'utf8'));
        return items.filter(it => it.mp4_download_url && it.title && it.title !== 'Error');
      }
    } catch (e) {
      console.error(`❌ [VIP2_SCRAPER] Scraping failed for ${category}:`, e.message);
    }
    return [];
  }

  async downloadVideoFile(item, category = 'bj') {
    const outDir = path.resolve(DOWNLOADS_DIR, category);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const safeTitle = item.title.replace(/[\/\\?%*:|"<>]/g, '').trim().slice(0, 80) || 'video';
    const filePath = path.resolve(outDir, `${category}_${Date.now()}_${safeTitle}.mp4`);

    console.log(`⬇️ [VIP2_SCRAPER] Downloading ${category.toUpperCase()}: "${item.title}"...`);

    const pyCode = `
import requests, sys, os

url = """${item.mp4_download_url}"""
filepath = """${filePath}"""
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://02.avsee.is/"
}

try:
    with requests.get(url, headers=headers, stream=True, timeout=180) as r:
        if r.status_code in [200, 206]:
            with open(filepath, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024*1024):
                    if chunk:
                        f.write(chunk)
            size_mb = os.path.getsize(filepath) / (1024 * 1024)
            print(f"SUCCESS:{size_mb:.2f}")
        else:
            print(f"HTTP_ERROR:{r.status_code}")
except Exception as e:
    print(f"ERROR:{e}")
`;

    try {
      const { stdout } = await execPromise(`"${this.pythonPath}" -c "${pyCode.replace(/"/g, '\\"')}"`, {
        timeout: 300000
      });

      if (stdout.includes('SUCCESS:')) {
        const sizeMb = parseFloat(stdout.split('SUCCESS:')[1].trim());
        console.log(`✅ [VIP2_SCRAPER] Downloaded ${sizeMb.toFixed(2)} MB -> ${filePath}`);
        return { success: true, filePath, sizeMb };
      } else {
        console.error(`❌ [VIP2_SCRAPER] Download response:`, stdout.trim());
      }
    } catch (e) {
      console.error(`❌ [VIP2_SCRAPER] Download execution failed:`, e.message);
    }
    return { success: false };
  }

  async publishScrapedVideo(item, downloadResult, category = 'bj') {
    const client = await this._getClient();
    const filePath = downloadResult.filePath;
    const rawTitle = item.title;

    const categoryTag = category === 'bj' ? '#BJ #한국BJ #소통방송' : '#AV #자막 #일본AV';
    const captionPrefix = category === 'bj' ? '💋 <b>[VIP-2 BJ 단독 업로드]</b>' : '🔞 <b>[VIP-2 일본 자막 AV 최신작]</b>';

    const fullCaption = `${captionPrefix}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎬 <b>제목:</b> ${rawTitle}\n` +
      `📦 <b>용량:</b> ${downloadResult.sizeMb.toFixed(1)} MB\n` +
      `🏷️ <b>분류:</b> ${categoryTag}\n` +
      `👑 <b>VIP 전용 입장:</b> <a href="${this.destInviteLink}">VIP 정보공유 채널 입장</a>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💬 <i>전체 풀버전 영상은 댓글(Discussion) 및 VIP 그룹에서 바로 시청 가능합니다!</i>`;

    console.log(`\n📤 [VIP2_SCRAPER] Publishing ${category.toUpperCase()} to Channel & Groups: "${rawTitle}"`);

    try {
      // Step 1: Upload to Channel
      const sentChannelMsg = await client.sendFile(this.destChatId, {
        file: filePath,
        caption: fullCaption,
        parseMode: 'html',
        forceDocument: false
      });

      if (sentChannelMsg) {
        const publishedMsgId = Array.isArray(sentChannelMsg) ? sentChannelMsg[0].id : sentChannelMsg.id;
        const cleanChatId = String(this.destChatId).replace(/^-100/, '').replace(/^-/, '');
        const postLink = `https://t.me/c/${cleanChatId}/${publishedMsgId}`;
        console.log(`✅ [VIP2_SCRAPER] Channel Post published: ${postLink}`);

        // Step 2: Discussion thread reply
        const discRootId = await this._findDiscussionRootMsgId(client, publishedMsgId);
        if (discRootId) {
          console.log(`💬 [VIP2_SCRAPER] Replying in discussion thread (root #${discRootId})...`);
          await client.sendMessage(this.discussionChatId, {
            message: `🎬 <b>[고화질 풀버전 재생 완료]</b>\n${rawTitle}\n\n👑 VIP 멤버 전용 영상입니다. 즐겁게 시청하세요!`,
            replyTo: discRootId,
            parseMode: 'html'
          });
        }

        // Step 3: Broadcast to Extra Group
        if (this.extraGroupChatId) {
          console.log(`📢 [VIP2_SCRAPER] Broadcasting to Extra Group (${this.extraGroupChatId})...`);
          try {
            await client.sendFile(this.extraGroupChatId, {
              file: filePath,
              caption: fullCaption,
              parseMode: 'html',
              forceDocument: false
            });
            console.log(`✅ [VIP2_SCRAPER] Extra Group broadcast complete.`);
          } catch (grpErr) {
            console.error(`⚠️ [VIP2_SCRAPER] Extra group post error:`, grpErr.message);
          }
        }

        // Step 4: Add to Catalog if catalogManager exists
        if (this.pipeline && this.pipeline.catalogManager) {
          this.pipeline.catalogManager.addVideo({
            messageId: publishedMsgId,
            title: rawTitle,
            link: postLink,
            date: new Date().toISOString()
          });
        }

        return true;
      }
    } catch (pubErr) {
      console.error(`❌ [VIP2_SCRAPER] Failed to publish video to Telegram:`, pubErr.message);
    } finally {
      // Step 5: Clean up local file immediately to save disk
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🧹 [VIP2_SCRAPER] Cleaned up temporary video file: ${filePath}`);
        }
      } catch (delErr) {
        console.warn(`⚠️ [VIP2_SCRAPER] Could not delete temp file:`, delErr.message);
      }
    }
    return false;
  }

  async runCycle() {
    if (this.isJobRunning) {
      console.log('⏳ [VIP2_SCRAPER] Scraper cycle already running, skipping.');
      return;
    }

    this.isJobRunning = true;
    this.state = this._loadState();

    console.log(`\n======================================================`);
    console.log(`🚀 [VIP2_SCRAPER] Starting Scraper Cycle`);
    console.log(`📊 Current Daily Count - BJ: ${this.state.bj_count}/${this.dailyQuotaPerCategory}, AV: ${this.state.av_count}/${this.dailyQuotaPerCategory}`);
    console.log(`======================================================`);

    try {
      // Process BJ
      if (this.state.bj_count < this.dailyQuotaPerCategory) {
        const remainingBj = this.dailyQuotaPerCategory - this.state.bj_count;
        console.log(`🎯 [VIP2_SCRAPER] Scraping up to ${remainingBj} new BJ video(s)...`);
        const bjItems = await this.scrapeBoardItems('bj', remainingBj + 2);

        for (const item of bjItems) {
          if (this.state.bj_count >= this.dailyQuotaPerCategory) break;
          if (this.state.processed_urls.includes(item.post_url)) continue;

          const downloadRes = await this.downloadVideoFile(item, 'bj');
          if (downloadRes.success) {
            const published = await this.publishScrapedVideo(item, downloadRes, 'bj');
            if (published) {
              this.state.bj_count++;
              this.state.processed_urls.push(item.post_url);
              this._saveState();
              await new Promise(r => setTimeout(r, 6000));
            }
          }
        }
      } else {
        console.log(`✅ [VIP2_SCRAPER] BJ daily quota reached (${this.state.bj_count}/${this.dailyQuotaPerCategory}).`);
      }

      // Process AV
      if (this.state.av_count < this.dailyQuotaPerCategory) {
        const remainingAv = this.dailyQuotaPerCategory - this.state.av_count;
        console.log(`🎯 [VIP2_SCRAPER] Scraping up to ${remainingAv} new AV video(s)...`);
        const avItems = await this.scrapeBoardItems('av', remainingAv + 2);

        for (const item of avItems) {
          if (this.state.av_count >= this.dailyQuotaPerCategory) break;
          if (this.state.processed_urls.includes(item.post_url)) continue;

          const downloadRes = await this.downloadVideoFile(item, 'av');
          if (downloadRes.success) {
            const published = await this.publishScrapedVideo(item, downloadRes, 'av');
            if (published) {
              this.state.av_count++;
              this.state.processed_urls.push(item.post_url);
              this._saveState();
              await new Promise(r => setTimeout(r, 6000));
            }
          }
        }
      } else {
        console.log(`✅ [VIP2_SCRAPER] AV daily quota reached (${this.state.av_count}/${this.dailyQuotaPerCategory}).`);
      }
    } catch (cycleErr) {
      console.error(`❌ [VIP2_SCRAPER] Cycle error:`, cycleErr.message);
    } finally {
      this.isJobRunning = false;
      console.log(`🏁 [VIP2_SCRAPER] Cycle finished. Current totals - BJ: ${this.state.bj_count}, AV: ${this.state.av_count}`);
    }
  }

  startScheduler(intervalHours = 3) {
    if (this.timer) clearInterval(this.timer);
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    console.log(`⏰ [VIP2_SCRAPER] Periodic scraper runner scheduled every ${intervalHours} hours.`);

    setTimeout(() => {
      this.runCycle();
    }, 20000);

    this.timer = setInterval(() => {
      this.runCycle();
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  Vip2ScraperManager
};
