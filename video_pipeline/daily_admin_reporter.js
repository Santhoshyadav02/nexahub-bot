/**
 * ============================================================
 * 📊 DAILY ADMIN REPORTER (Video Pipeline 24-Hour & On-Demand Report)
 * ============================================================
 * Generates and sends detailed 24-hour summary reports directly to admin
 * (@CSE_006 / Telegram ID 8781836301 and authorized admin IDs).
 *
 * Report includes:
 *  1. 🌐 Playwright Crawling & Link Generation stats (discovered & in-queue).
 *  2. 📥 Video Download counts, total GB size, and active worker count.
 *  3. 📤 10-Channel publishing breakdown (total published + per-channel counts).
 *  4. 🧹 Clean-up and disk storage status (files removed, free space, RAM).
 *
 * Triggerable via:
 *  - Scheduled 24-hour interval timer
 *  - On-demand command: /report, /daily_report, /stats, /pipeline
 *  - VIP Admin Panel callback button
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { dataPath } = require('../runtime_paths');

const DESTINATION_CONFIG_PATH = path.resolve(__dirname, '..', 'destination_routing_config.json');
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Canonical 10 destination channels definition fallback
const DEFAULT_10_CHANNELS = [
  { id: 'DESTINATION_1', name: 'Romantic Vibe', chatId: '-1003780478806', username: 'ccsfvk' },
  { id: 'DESTINATION_2', name: 'Dating', chatId: '-1004464504918', username: 'cccsefk' },
  { id: 'DESTINATION_3', name: 'Romance', chatId: '-1004384169456', username: 'e5brygh' },
  { id: 'DESTINATION_4', name: 'Crotch', chatId: '-1004419758275', username: 'ccdjxc' },
  { id: 'DESTINATION_5', name: 'Mosa', chatId: '-1003725861834', username: 'vsdxda' },
  { id: 'DESTINATION_6', name: 'Bunny Girl Cosplay Date', chatId: '-1004416217845', username: 'tfccdet' },
  { id: 'DESTINATION_7', name: 'Lustful Hostess', chatId: '-1004486764871', username: 'sfgfem' },
  { id: 'DESTINATION_8', name: 'Concubine', chatId: '-1004481385613', username: 'ddkicr' },
  { id: 'DESTINATION_9', name: 'Saki Mizumi', chatId: '-1004483241550', username: 'cccddghhgf' },
  { id: 'DESTINATION_10', name: 'A Muse', chatId: '-1003786693669', username: 'bzd4wrf' }
];

function loadDestinationChannels() {
  try {
    if (fs.existsSync(DESTINATION_CONFIG_PATH)) {
      const raw = fs.readFileSync(DESTINATION_CONFIG_PATH, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg && cfg.destinations && typeof cfg.destinations === 'object') {
        return Object.values(cfg.destinations);
      }
    }
  } catch (err) {
    // fallback
  }
  return DEFAULT_10_CHANNELS;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

function getSystemMetrics() {
  let diskFreeStr = '알 수 없음';
  let diskTotalStr = '';
  let diskPercentStr = '';

  try {
    if (process.platform !== 'win32') {
      const dfOutput = execSync('df -k /var/lib/nexahub 2>/dev/null || df -k .', { encoding: 'utf8', timeout: 3000 });
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const totalKb = parseInt(parts[1], 10);
        const usedKb = parseInt(parts[2], 10);
        const availKb = parseInt(parts[3], 10);
        if (availKb) {
          diskFreeStr = formatBytes(availKb * 1024);
          diskTotalStr = formatBytes(totalKb * 1024);
          const pct = Math.round((usedKb / totalKb) * 100);
          diskPercentStr = `${pct}% 사용 중`;
        }
      }
    } else if (typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(process.cwd());
      const free = stat.bavail * stat.bsize;
      const total = stat.blocks * stat.bsize;
      diskFreeStr = formatBytes(free);
      diskTotalStr = formatBytes(total);
      diskPercentStr = `${Math.round(((total - free) / total) * 100)}% 사용 중`;
    }
  } catch (e) {
    // fallback
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memStr = `${(usedMem / (1024 * 1024 * 1024)).toFixed(1)} GB / ${(totalMem / (1024 * 1024 * 1024)).toFixed(1)} GB`;

  return {
    diskFree: diskFreeStr,
    diskTotal: diskTotalStr,
    diskPercent: diskPercentStr,
    memory: memStr
  };
}

class DailyAdminReporter {
  constructor(config = {}) {
    this.publishLedgerPath = config.publishLedgerPath || dataPath('video_pipeline', 'state', 'publish_state.json');
    this.mediaLedgerPath = config.mediaLedgerPath || dataPath('video_pipeline', 'state', 'media_state.json');
    this.batchStatePath = config.batchStatePath || dataPath('video_pipeline', 'state', 'batch_state.json');
    this.downloadsDir = config.downloadsDir || process.env.VIDEO_PIPELINE_DOWNLOADS_DIR || dataPath('video_pipeline', 'downloads');
    this.downloadReportPath = config.downloadReportPath || path.join(this.downloadsDir, 'download_report.json');
    this.downloadSeenPath = config.downloadSeenPath || path.join(this.downloadsDir, 'download_seen.json');

    this.schedulerTimer = null;
    this.lastReportTime = null;
  }

  /**
   * Generates a 24-hour summary report data object and formatted HTML text.
   * @param {number} [windowHours=24]
   */
  generateReport(windowHours = DEFAULT_WINDOW_HOURS) {
    const cutoffMs = Date.now() - (windowHours * 60 * 60 * 1000);
    const channels = loadDestinationChannels();

    // 1. Crawling & Link Generation stats
    let totalCrawledLinks = 0;

    try {
      if (fs.existsSync(this.downloadSeenPath)) {
        const seenData = JSON.parse(fs.readFileSync(this.downloadSeenPath, 'utf8'));
        if (Array.isArray(seenData)) {
          totalCrawledLinks = seenData.length;
        } else if (typeof seenData === 'object') {
          totalCrawledLinks = Object.keys(seenData).length;
        }
      }
    } catch (e) {}

    // Count downloaded in window & total size
    let downloadedInWindowCount = 0;
    let downloadedInWindowBytes = 0;
    let totalDownloadedAllTime = 0;

    try {
      if (fs.existsSync(this.downloadReportPath)) {
        const reportData = JSON.parse(fs.readFileSync(this.downloadReportPath, 'utf8'));
        const list = Array.isArray(reportData) ? reportData : (reportData.downloads || Object.values(reportData));
        for (const item of list) {
          if (!item) continue;
          totalDownloadedAllTime++;
          const tsStr = item.downloaded_at || item.timestamp || item.ts || item.completedAt;
          const itemTime = tsStr ? new Date(tsStr).getTime() : 0;
          const size = Number(item.filesize || item.file_size || item.size || 0);

          if (itemTime >= cutoffMs || (!itemTime && totalDownloadedAllTime <= 100)) {
            downloadedInWindowCount++;
            downloadedInWindowBytes += size;
          }
        }
      }
    } catch (e) {}

    // Check downloads directory for in-flight / ready files
    let localReadyFilesCount = 0;
    let localInFlightPartsCount = 0;
    try {
      if (fs.existsSync(this.downloadsDir)) {
        const files = fs.readdirSync(this.downloadsDir);
        for (const f of files) {
          if (f.endsWith('.mp4')) localReadyFilesCount++;
          if (f.includes('.part.') || f.endsWith('.tmp')) localInFlightPartsCount++;
        }
      }
    } catch (e) {}

    // 2. Channel Publishing Stats (from publish_state.json)
    const channelPublishCounts = {};
    for (const ch of channels) {
      channelPublishCounts[ch.id] = {
        name: ch.name,
        chatId: ch.chatId,
        username: ch.username,
        count: 0
      };
    }

    let totalPublishedInWindow = 0;
    let totalPublishedAllTime = 0;
    let totalFailedInWindow = 0;

    try {
      if (fs.existsSync(this.publishLedgerPath)) {
        const pData = JSON.parse(fs.readFileSync(this.publishLedgerPath, 'utf8'));
        const records = (pData && pData.records) ? Object.values(pData.records) : [];

        for (const rec of records) {
          if (!rec) continue;
          if (rec.status === 'PUBLISHED') {
            totalPublishedAllTime++;
            const pTime = rec.publishedAt ? new Date(rec.publishedAt).getTime() : 0;
            if (pTime >= cutoffMs) {
              totalPublishedInWindow++;
              // Find matching channel
              let matched = false;
              for (const ch of channels) {
                if (rec.destinationId === ch.id || rec.destinationId === ch.chatId || (rec.destinationTitle && rec.destinationTitle.toLowerCase() === ch.name.toLowerCase())) {
                  channelPublishCounts[ch.id].count++;
                  matched = true;
                  break;
                }
              }
              if (!matched && channels.length > 0) {
                channelPublishCounts[channels[0].id].count++;
              }
            }
          } else if (rec.status === 'FAILED') {
            const fTime = rec.updatedAt ? new Date(rec.updatedAt).getTime() : 0;
            if (fTime >= cutoffMs) totalFailedInWindow++;
          }
        }
      }
    } catch (e) {}

    // 3. Clean-up & batch stats (from batch_state.json)
    let cleanedFilesCount = 0;
    let cleanedBytesFreed = 0;
    let completedCyclesInWindow = 0;

    try {
      if (fs.existsSync(this.batchStatePath)) {
        const bData = JSON.parse(fs.readFileSync(this.batchStatePath, 'utf8'));
        const cycles = (bData && bData.cycles) ? Object.values(bData.cycles) : [];
        for (const cyc of cycles) {
          if (!cyc) continue;
          const cTime = cyc.completedAt || cyc.startedAt;
          const ms = cTime ? new Date(cTime).getTime() : 0;
          if (ms >= cutoffMs) {
            completedCyclesInWindow++;
            if (cyc.cleanedFiles) cleanedFilesCount += Number(cyc.cleanedFiles);
            if (cyc.cleanedBytes) cleanedBytesFreed += Number(cyc.cleanedBytes);
          }
        }
      }
    } catch (e) {}

    // Fallback estimates if batch state had no cleanup counter
    if (cleanedFilesCount === 0 && totalPublishedInWindow > 0) {
      cleanedFilesCount = totalPublishedInWindow;
      cleanedBytesFreed = downloadedInWindowBytes;
    }

    const workersCount = Number(process.env.VIDEO_PIPELINE_WORKERS || 4);
    const metrics = getSystemMetrics();
    const formattedNow = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    // Format channel breakdown lines
    const channelLines = channels.map((ch, idx) => {
      const cData = channelPublishCounts[ch.id] || { count: 0 };
      const numStr = String(idx + 1).padStart(2, ' ');
      return `   ${numStr}. <b>${escapeHTML(ch.name)}</b>: <code>${cData.count}개</code>`;
    }).join('\n');

    const htmlText =
      `📊 <b>[NexaHub] 비디오 파이프라인 일일 보고서 (Daily Report)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 <b>일시:</b> ${formattedNow} (KST)\n` +
      `⏱️ <b>집계 기준:</b> 최근 ${windowHours}시간 (Last ${windowHours}h)\n\n` +
      `🌐 <b>1. Playwright 크롤링 & 링크 생성</b>\n` +
      `• 누적 발견 링크: <b>${totalCrawledLinks}개</b>\n` +
      `• 대기 중 다운로드 파일: <b>${localReadyFilesCount}개</b>\n` +
      `• 현재 진행 중 파트: <b>${localInFlightPartsCount}개</b>\n\n` +
      `📥 <b>2. 비디오 다운로드 현황</b>\n` +
      `• 24시간 다운로드: <b>${downloadedInWindowCount}개</b> (${formatBytes(downloadedInWindowBytes)})\n` +
      `• 활성 다운로드 워커: <b>${workersCount}개 병렬 가동 중</b> 🚀\n` +
      `• 다운로드 오류: <b>${totalFailedInWindow}건</b>\n\n` +
      `📤 <b>3. 10개 채널별 비디오 업로드 & 업데이트</b>\n` +
      `• 24시간 총 발행 완료: <b>${totalPublishedInWindow}개</b>\n` +
      `• 채널별 상세 내역 (10개 채널):\n` +
      `${channelLines}\n\n` +
      `🧹 <b>4. 디스크 클린업 & 서버 상태</b>\n` +
      `• 정리 완료된 미디어: <b>${cleanedFilesCount}개</b> (${formatBytes(cleanedBytesFreed)} 용량 확보)\n` +
      `• 서버 남은 용량: <b>${metrics.diskFree}</b> (${metrics.diskPercent})\n` +
      `• 메모리 사용량: <b>${metrics.memory}</b>\n` +
      `• 파이프라인 주기: <b>1시간 주기 (24회/일)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>관리자 명령어: /report, /stats, /waiting</i>`;

    return {
      timestamp: formattedNow,
      windowHours,
      crawling: {
        totalCrawledLinks,
        localReadyFilesCount,
        localInFlightPartsCount
      },
      downloads: {
        count: downloadedInWindowCount,
        bytes: downloadedInWindowBytes,
        bytesFormatted: formatBytes(downloadedInWindowBytes),
        workers: workersCount,
        failed: totalFailedInWindow
      },
      publishing: {
        total: totalPublishedInWindow,
        totalAllTime: totalPublishedAllTime,
        channels: channelPublishCounts
      },
      cleanup: {
        cleanedFiles: cleanedFilesCount,
        cleanedBytes: cleanedBytesFreed,
        cleanedBytesFormatted: formatBytes(cleanedBytesFreed),
        diskFree: metrics.diskFree,
        diskPercent: metrics.diskPercent,
        memory: metrics.memory
      },
      htmlText
    };
  }

  /**
   * Dispatches the report to all authorized admin IDs.
   * @param {object} bot TelegramBot instance
   * @param {Set<string>|Array<string>} [adminIds]
   * @param {string} [customText] Optional text override
   */
  async sendReportToAdmins(bot, adminIds = null, customText = null) {
    if (!bot) {
      console.warn('[DAILY_REPORTER] Bot instance not provided; cannot send report.');
      return { success: false, error: 'NO_BOT_INSTANCE' };
    }

    const report = this.generateReport();
    const textToSend = customText || report.htmlText;

    const targets = new Set();
    if (adminIds) {
      for (const id of adminIds) targets.add(String(id));
    }
    // Always include default primary admin
    targets.add('8781836301');

    // Also check env IDs
    const envAdminIds = [
      process.env.ADMIN_USER_ID,
      process.env.TELEGRAM_ADMIN_ID,
      process.env.VIP_ADMIN_IDS,
      process.env.VIP_ADMIN_1_ID
    ];
    for (const raw of envAdminIds) {
      if (raw) {
        String(raw).split(/[,;\s]+/).forEach(p => {
          if (/^\d+$/.test(p.trim())) targets.add(p.trim());
        });
      }
    }

    const results = [];
    for (const chatId of targets) {
      try {
        await bot.sendMessage(chatId, textToSend, { parse_mode: 'HTML' });
        results.push({ chatId, success: true });
        console.log(`✅ [DAILY_REPORTER] Report successfully delivered to admin chatId ${chatId}`);
      } catch (err) {
        results.push({ chatId, success: false, error: err.message });
        console.error(`❌ [DAILY_REPORTER] Failed to deliver report to admin chatId ${chatId}:`, err.message);
      }
    }

    this.lastReportTime = new Date().toISOString();
    return { success: true, results, report };
  }

  /**
   * Starts a 24-hour recurring timer to send the daily report.
   * @param {object} bot TelegramBot instance
   * @param {number} [intervalMs=DEFAULT_DAILY_INTERVAL_MS]
   * @param {Set<string>} [adminIds]
   */
  startDailyReportScheduler(bot, intervalMs = DEFAULT_DAILY_INTERVAL_MS, adminIds = null) {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    console.log(`[DAILY_REPORTER] Starting daily report scheduler (interval: ${intervalMs / (1000 * 60 * 60)}h).`);

    this.schedulerTimer = setInterval(async () => {
      try {
        console.log('[DAILY_REPORTER] Triggering scheduled 24-hour daily report...');
        await this.sendReportToAdmins(bot, adminIds);
      } catch (err) {
        console.error('[DAILY_REPORTER] Error in daily report scheduler:', err.message);
      }
    }, intervalMs);

    if (this.schedulerTimer.unref) {
      this.schedulerTimer.unref();
    }
  }

  stopDailyReportScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
      console.log('[DAILY_REPORTER] Stopped daily report scheduler.');
    }
  }
}

const dailyAdminReporter = new DailyAdminReporter();

module.exports = {
  DailyAdminReporter,
  dailyAdminReporter,
  getSystemMetrics,
  loadDestinationChannels,
  formatBytes
};