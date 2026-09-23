try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { getDataDir, dataPath, writeJsonAtomicSync } = require("./runtime_paths");
const { acquireBotLock } = require("./process_lock");
const { startScraperScheduler, stopScraperScheduler } = require("./scraper");
const { startPipelineScheduler, stopPipelineScheduler, waitForActiveCycle } = require("./telegram_pipeline_publisher");
const rankingScraper = require("./ranking_scraper");
const sourceRegistry = require("./source_registry");
const contentHubScraper = require("./content_hub_scraper");
const { translateToKorean, detectSourceLanguage, captionTranslationCache } = require("./korean_caption_generator");
const { getPipelineInstance } = require("./external_source_pipeline");
const { vipAccessManager } = require("./vip_access_manager");
const { dailyAdminReporter } = require("./video_pipeline/daily_admin_reporter");




// ============================
// 🤖 MAIN BOT TOKEN & INIT
// ============================
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN environment variable is not defined!");
  console.error("Please set BOT_TOKEN in your environment or .env file.");
  process.exit(1);
}

const os = require("os");
const APP_PID = process.pid;
const APP_HOST = os.hostname();

function sanitizeUTF8(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '');
}

const isMainModule = require.main === module;

let enablePolling = false;
if (isMainModule && !global.__botPollingInitialized) {
  enablePolling = true;
  global.__botPollingInitialized = true;
}

if (isMainModule) {
  // Refuse to start a second bot process on this machine: it would fight for
  // the polling slot (409) and reuse the MTProto session (AUTH_KEY_DUPLICATED).
  const lockResult = acquireBotLock();
  if (!lockResult.acquired) {
    console.error(`❌ [PID:${APP_PID}] Another NexaHub bot process (PID ${lockResult.holder.pid}, started ${lockResult.holder.startedAt}) is already running on this machine. Exiting.`);
    process.exit(1);
  }
  console.log(`📁 [PID:${APP_PID}] Runtime data dir: ${getDataDir()}`);
}

console.log(`🤖 [PID:${APP_PID}] [Host:${APP_HOST}] Main module initialized. isMainModule=${isMainModule}, enablePolling=${enablePolling}`);

const bot = new TelegramBot(TOKEN, {
  polling: enablePolling ? {
    params: {
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"]
    }
  } : false
});



let currentBotUsername = process.env.TELEGRAM_BOT_USERNAME || "santhosh_learning_2026_bot";
bot.getMe().then(me => {
  if (me && me.username) {
    currentBotUsername = me.username;
    console.log(`🤖 Bot username initialized: @${currentBotUsername}`);
  }
}).catch(() => {});

if (enablePolling) {
  console.log(`[TELEGRAM] Polling: ACTIVE (requesting getUpdates - a 409 below means another instance already holds this BOT_TOKEN's polling slot; outgoing sends are unaffected either way).`);
}

let pollingConflictRetryTimer = null;
let pollingConflictAttempts = 0;
let pollingConflictLastAt = 0;
const POLLING_CONFLICT_MAX_RETRIES = 5;
const POLLING_CONFLICT_RESET_WINDOW_MS = 5 * 60 * 1000; // treat a conflict >5 min after the last one as a fresh episode

bot.on("polling_error", async (error) => {
  const errMsg = String(error.message || error);
  const errCode = error.code || "";

  if (errMsg.includes("409 Conflict") || errMsg.includes("terminated by other getUpdates request")) {
    if (!isShuttingDown) {
      const now = Date.now();
      if (now - pollingConflictLastAt > POLLING_CONFLICT_RESET_WINDOW_MS) {
        pollingConflictAttempts = 0;
      }
      pollingConflictLastAt = now;
      pollingConflictAttempts++;

      console.log(`[TELEGRAM] Polling: CONFLICT (attempt ${pollingConflictAttempts}/${POLLING_CONFLICT_MAX_RETRIES}) - another instance (e.g. the production deployment) already holds this BOT_TOKEN's polling slot. Pausing local polling; outgoing sends (e.g. video publishing) are NOT affected by this.`);
      // Plain stopPolling(): with { cancel: true } node-telegram-bot-api never
      // sets its abort flag, so the polling loop immediately schedules the
      // next getUpdates and the conflict repeats forever.
      try {
        if (bot.isPolling && bot.isPolling()) {
          await bot.stopPolling();
        }
      } catch (e) {}

      if (pollingConflictAttempts >= POLLING_CONFLICT_MAX_RETRIES) {
        console.error(`[TELEGRAM] Polling: CONFLICT - giving up after ${POLLING_CONFLICT_MAX_RETRIES} attempts. This BOT_TOKEN is already actively polling elsewhere. Polling stays stopped for this process (no further automatic retries); restart with a different/dedicated BOT_TOKEN to receive updates locally. Bot commands will not work locally until then, but video-pipeline publishing is unaffected.`);
        return;
      }

      if (!pollingConflictRetryTimer) {
        pollingConflictRetryTimer = setTimeout(async () => {
          pollingConflictRetryTimer = null;
          if (!isShuttingDown && isMainModule) {
            console.log(`🔄 [PID:${APP_PID}] Attempting to resume Telegram Bot polling after backoff...`);
            try {
              if (bot.isPolling && !bot.isPolling()) {
                await bot.startPolling({
                  params: {
                    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"]
                  }
                });
              }
            } catch (startErr) {
              console.error(`⚠️ [PID:${APP_PID}] Error resuming polling:`, startErr.message);
            }
          }
        }, 10000);
      }
    }
    return;
  }

  // An invalid/revoked BOT_TOKEN can never recover by retrying; without this the
  // library re-polls immediately and floods the logs with 401s.
  if (errMsg.includes("401 Unauthorized") || errMsg.includes("404 Not Found")) {
    if (!botTokenRejected) {
      botTokenRejected = true;
      console.error(`❌ [PID:${APP_PID}] Telegram rejected BOT_TOKEN (${errMsg}). Polling stopped - the token is invalid or was revoked. Put the current token from @BotFather into .env and restart the bot.`);
      try {
        if (bot.isPolling && bot.isPolling()) {
          await bot.stopPolling();
        }
      } catch (e) {}
    }
    return;
  }

  console.error(`⚠️ [PID:${APP_PID}] Telegram Bot Polling Error: ${errCode} - ${errMsg}`);
});

let botTokenRejected = false;

let isShuttingDown = false;

// Must stay below the process manager's kill timeout (ecosystem.config.js
// kill_timeout: 20000) so cleanup is never cut off by SIGKILL.
const SHUTDOWN_BUDGET_MS = 15000;

// Graceful shutdown for SIGTERM/SIGINT (PM2 restart/stop, deploys) and fatal errors
async function handleProcessExit(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`🛑 [PID:${APP_PID}] Received ${signal}. Starting graceful bounded shutdown...`);

  // Bounded fallback: hard timeout guard to ensure exit even if a resource hangs
  const forceExitTimer = setTimeout(() => {
    console.warn(`⚠️ [PID:${APP_PID}] Graceful shutdown timed out for ${signal} after ${SHUTDOWN_BUDGET_MS}ms. Forcing exit.`);
    process.exit(exitCode);
  }, SHUTDOWN_BUDGET_MS);
  forceExitTimer.unref();

  // 1. No new scheduled work.
  try {
    stopPipelineScheduler();
  } catch (err) {}
  try {
    contentHubScraper.stopContentHubScheduler();
  } catch (err) {}
  try {
    stopScraperScheduler();
  } catch (err) {}
  try {
    if (typeof rankingScraper.stopRankingScheduler === "function") {
      rankingScraper.stopRankingScheduler();
    }
  } catch (err) {}
  // 2. No new user interactions.
  try {
    if (bot.isPolling()) {
      // Bounded: a plain stop waits for the in-flight long-poll request.
      await Promise.race([bot.stopPolling(), new Promise(resolve => setTimeout(resolve, 3000))]);
      console.log(`✅ [PID:${APP_PID}] Bot polling stopped cleanly for ${signal}.`);
    }
  } catch (err) {
    console.error(`⚠️ [PID:${APP_PID}] Error stopping polling on ${signal}:`, err.message);
  }

  // 3. Let in-flight work finish (bounded), in parallel: the video pipeline
  //    child process, a publish cycle's current send + ledger write, and the
  //    external source pipeline (aborts downloads, closes browsers).
  await Promise.all([
    (async () => {
      try {
        await getPipelineInstance().stopScheduler();
      } catch (err) {
        console.error(`⚠️ [PID:${APP_PID}] Error stopping external source pipeline on ${signal}:`, err.message);
      }
    })(),
    (async () => {
      try {
        const { getVideoPipelineRuntime } = require("./video_pipeline/video_pipeline_runtime");
        const videoRuntime = getVideoPipelineRuntime();
        if (videoRuntime.isStarted()) {
          await videoRuntime.stop();
          console.log(`✅ [PID:${APP_PID}] Video Pipeline Runtime stopped cleanly for ${signal}.`);
        }
      } catch (err) {
        console.error(`⚠️ [PID:${APP_PID}] Error stopping Video Pipeline Runtime on ${signal}:`, err.message);
      }
    })(),
    (async () => {
      try {
        const { getModularPipelineInstance } = require("./video_pipeline/modular_scraper_pipeline");
        const modularPipeline = getModularPipelineInstance();
        modularPipeline.stopScheduler();
        console.log(`✅ [PID:${APP_PID}] Modular Scraper Pipeline stopped cleanly for ${signal}.`);
      } catch (err) {
        // Modular pipeline might not be instantiated, silent pass
      }
    })(),
    (async () => {
      try {
        const finished = await waitForActiveCycle(10000);
        if (!finished) {
          console.warn(`⚠️ [PID:${APP_PID}] Telegram publish cycle still running at shutdown; exiting after the current item.`);
        }
      } catch (err) {}
    })()
  ]);

  // 4. Release the MTProto session last.
  try {
    const MTProtoChannelReader = require("./mtproto_reader");
    if (MTProtoChannelReader.instance) {
      await MTProtoChannelReader.instance.disconnect();
      console.log(`✅ [PID:${APP_PID}] MTProto client disconnected cleanly for ${signal}.`);
    }
  } catch (err) {}

  clearTimeout(forceExitTimer);
  console.log(`✅ [PID:${APP_PID}] Graceful shutdown completed cleanly for ${signal}.`);
  process.exit(exitCode);
}

if (isMainModule) {
  process.on("SIGTERM", () => handleProcessExit("SIGTERM"));
  process.on("SIGINT", () => handleProcessExit("SIGINT"));

  // A stray rejected promise must not take the whole bot down (Node 22 exits
  // on unhandled rejections by default): log it with its stack and keep going.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    console.error(`❌ [PID:${APP_PID}] Unhandled promise rejection (process kept alive):`, detail);
  });

  // After an uncaught exception the process state is unknown: shut down
  // cleanly and let PM2 start a fresh instance.
  process.on("uncaughtException", (err) => {
    console.error(`❌ [PID:${APP_PID}] Uncaught exception - shutting down so the process manager restarts a clean instance:`, err && (err.stack || err.message));
    handleProcessExit("uncaughtException", 1);
  });
}

// ============================
// 📡 REAL-TIME TELEGRAM SOURCE CHANNEL POST LISTENERS
// ============================
bot.on("channel_post", async (msg) => {
  try {
    console.log(`📡 [channel_post] Received from chat ID ${msg.chat.id} (${msg.chat.title || 'Channel'}) message ID ${msg.message_id}`);
    sourceRegistry.processChannelPost(msg);
  } catch (err) {
    console.error("❌ Error processing channel_post:", err.message);
  }
});

bot.on("edited_channel_post", async (msg) => {
  try {
    console.log(`📡 [edited_channel_post] Received from chat ID ${msg.chat.id} message ID ${msg.message_id}`);
    sourceRegistry.processChannelPost(msg);
  } catch (err) {
    console.error("❌ Error processing edited_channel_post:", err.message);
  }
});

// ============================
// 🖼️ WELCOME IMAGE
// ============================
const WELCOME_IMAGE = "https://raw.githubusercontent.com/hiruboyz/news-bot/main/Magnifying%20wealth%20with%20vibrant%20colors.png";

// ============================
// 🌐 DYNAMIC TRANSLATION HELPER
// ============================
const translationCache = new Map();
const MAX_TRANSLATION_CACHE_ENTRIES = 5000;
// Hard cap per translation request; the https `timeout` option only fires on
// an idle socket, not on a slowly trickling response.
const TRANSLATION_DEADLINE_MS = 5000;

function setTranslationCache(key, value) {
  if (!translationCache.has(key) && translationCache.size >= MAX_TRANSLATION_CACHE_ENTRIES) {
    translationCache.delete(translationCache.keys().next().value);
  }
  translationCache.set(key, value);
}

async function translateText(text, targetLang = "ko") {
  if (!text || typeof text !== "string") {
    return text || "";
  }

  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Tier 1: Google GTX
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const translated = await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 3000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed[0] && parsed[0][0] && parsed[0][0][0]) {
              const fullText = parsed[0].map((item) => item[0]).filter(Boolean).join("");
              resolve(fullText);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      const deadline = setTimeout(() => {
        req.destroy();
        resolve(null);
      }, TRANSLATION_DEADLINE_MS);
      req.on("close", () => clearTimeout(deadline));
    });

    if (translated && translated !== text) {
      setTranslationCache(cacheKey, translated);
      return translated;
    }
  } catch (err) {
    // Fall through to Tier 2
  }

  // Tier 2: MyMemory API Fallback
  try {
    const fallbackUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const fallbackTranslated = await new Promise((resolve) => {
      const req = https.get(fallbackUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 3000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.responseData && parsed.responseData.translatedText) {
              resolve(parsed.responseData.translatedText);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      const deadline = setTimeout(() => {
        req.destroy();
        resolve(null);
      }, TRANSLATION_DEADLINE_MS);
      req.on("close", () => clearTimeout(deadline));
    });

    if (fallbackTranslated && fallbackTranslated !== text && !fallbackTranslated.includes("MYMEMORY WARNING") && !fallbackTranslated.includes("INVALID") && !fallbackTranslated.includes("QUOTA")) {
      setTranslationCache(cacheKey, fallbackTranslated);
      return fallbackTranslated;
    }
  } catch (err) {
    // Fall through to safety
  }

  // Tier 3: Return original text safely
  setTranslationCache(cacheKey, text);
  return text;
}

// ============================
// 📢 CHANNEL LISTS
// ============================
const CHANNELS = {
  "ai": [
    {
      "name": "🎬 DASS-891 [The most special day in life - that's the wedding]",
      "user": "fancha07"
    },
    {
      "name": "🎬 ADN-409 Unparalleled woman control, super staying power, intense insemination and intercourse by stepfather",
      "user": "sesedeCB"
    },
    {
      "name": "🎬 ADN-762 For you, I...the sweaty young wife looking for excuses to cheat on her",
      "user": "fanchaku8"
    },
    {
      "name": "🎬 CAWD-259 Uncensored Chinese",
      "user": "yuziyuzi111"
    }
  ],
  "bitcoin": [
    {
      "name": "🎬 🌟Bunny Garden🔞Rin-chan🌟 The incredibly accurate Bunny Garu Rin cosplay is so hot! In the cowgirl position",
      "user": "zzkbraxk"
    },
    {
      "name": "🎬 Tide x Cosplay x Tide Squirting Rapid-Fire Sex Rin Yoda",
      "user": "LaiCai123688"
    },
    {
      "name": "🎬 Tide Gushing Rapid-Fire Sex Rin Yoda with Panties",
      "user": "wuxisk112/245"
    },
    {
      "name": "🎬 Tide Rapid-fire Cumshot Sex Rin Yoda with Panties and Photos",
      "user": "quanzhou99990000/221"
    }
  ],
  "tesla": [
    {
      "name": "🎬 极品奶油风网红，电子魅魔女友，前凸后翘性感身材，一对巨乳摇摇欲坠，情趣丝袜淫荡肥臀，高清写真诱惑十足！",
      "user": "edxrfvtgb111/2319"
    },
    {
      "name": "🎬 抖音少妇微信定制福利视频，高颜值反差婊，性感情趣丝袜淫荡诱惑，各种剧情足交挑逗，年轻的妈妈勾引骚狗儿子，果然戴眼镜的才是最骚的~",
      "user": "youshengyueju1/65938"
    },
    {
      "name": "🎬 高颜值抖音博主，脸足同框私密定制，极品美女御姐黑丝、裸足，美脚诱惑，抹油搓脚心诱惑榨精，这么漂亮的美女帮哥哥打飞机，足交，绝对의 视觉盛宴！",
      "user": "postiingNew03/118"
    },
    {
      "name": "🎬 足控福音！微博百万粉丝玉足女神，单人定制美脚诱惑资源，白里透红的食品级玉足，三寸金莲小脚丫令人垂涎三尺，真想含住脚趾 financially...",
      "user": "postiingNew03/124"
    },
    {
      "name": "🎬 这才是抖音的正确打开方式！吃瓜网友视角VS土豪裸聊视角，以为是一本正经的女主播，没想到幻龙骑乘骚得一笔，红底高跟裤里丝，这谁顶得住啊！",
      "user": "postiingNew03/130"
    }
  ],
  "openai": [
    {
      "name": "🌐 Test-04",
      "user": "postiingNew",
      "members": "620K"
    }
  ],
  "meriolchan": [
    {
      "name": "🎬 🌸 Meriolchan — estghdx/2147",
      "user": "estghdx/2147"
    },
    {
      "name": "🎬 🌸 Meriolchan — weme_lmz/42040",
      "user": "weme_lmz/42040"
    },
    {
      "name": "🎬 🌸 Meriolchan — mitaotv168/1407",
      "user": "mitaotv168/1407"
    },
    {
      "name": "🎬 🌸 Meriolchan — tianwailaike6397/956",
      "user": "tianwailaike6397/956"
    },
    {
      "name": "🎬 🌸 Meriolchan — mospdfjdv/1136",
      "user": "mospdfjdv/1136"
    },
    {
      "name": "🎬 🌸 Meriolchan — SC18M/376",
      "user": "SC18M/376"
    },
    {
      "name": "🎬 🌸 Meriolchan — nieyuanswomen997/2156",
      "user": "nieyuanswomen997/2156"
    },
    {
      "name": "🎬 🌸 Meriolchan — fuli366/34012",
      "user": "fuli366/34012"
    },
    {
      "name": "🎬 🌸 Meriolchan — txavse/4368",
      "user": "txavse/4368"
    },
    {
      "name": "🎬 🌸 Meriolchan — dcrenqi85/45",
      "user": "dcrenqi85/45"
    },
    {
      "name": "🎬 🌸 Meriolchan — Cos_8/3504",
      "user": "Cos_8/3504"
    },
    {
      "name": "🎬 🌸 Meriolchan — sfwanghonga/1163",
      "user": "sfwanghonga/1163"
    },
    {
      "name": "🎬 🌸 Meriolchan — kanmimangrensheng7451/686",
      "user": "kanmimangrensheng7451/686"
    },
    {
      "name": "🎬 🌸 Meriolchan — bigmanXXOO/1898",
      "user": "bigmanXXOO/1898"
    }
  ],
  "isa": [
    {
      "name": "🎬 ⭐ Isa — anrsadn2k1p",
      "user": "anrsadn2k1p"
    },
    {
      "name": "🎬 ⭐ Isa — dnygb/14249",
      "user": "dnygb/14249"
    },
    {
      "name": "🎬 ⭐ Isa — BTCnewsvip02/2580",
      "user": "BTCnewsvip02/2580"
    },
    {
      "name": "🎬 ⭐ Isa — omspjx/37812",
      "user": "omspjx/37812"
    },
    {
      "name": "🎬 ⭐ Isa — ShowMusicTime/1381218",
      "user": "ShowMusicTime/1381218"
    },
    {
      "name": "🎬 ⭐ Isa — ctbrecorderd/11795",
      "user": "ctbrecorderd/11795"
    },
    {
      "name": "🎬 ⭐ Isa — vayi6/1570",
      "user": "vayi6/1570"
    },
    {
      "name": "🎬 ⭐ Isa — OMYJS06/2691",
      "user": "OMYJS06/2691"
    },
    {
      "name": "🎬 ⭐ Isa — kakakov/13868",
      "user": "kakakov/13868"
    },
    {
      "name": "🎬 ⭐ Isa — QiKan2026/7218",
      "user": "QiKan2026/7218"
    },
    {
      "name": "🎬 ⭐ Isa — xiuche696969/7136",
      "user": "xiuche696969/7136"
    },
    {
      "name": "🎬 ⭐ Isa — DNYzccg/15977",
      "user": "DNYzccg/15977"
    },
    {
      "name": "🎬 ⭐ Isa — jlgm168/454",
      "user": "jlgm168/454"
    },
    {
      "name": "🎬 ⭐ Isa — tgccc/1186",
      "user": "tgccc/1186"
    },
    {
      "name": "🎬 ⭐ Isa — XLABdxb/7611",
      "user": "XLABdxb/7611"
    }
  ],
  "hypnotic_eyes": [
    {
      "name": "🎬 👁️ Hypnotic Eyes — TGbiaomei1/2053",
      "user": "TGbiaomei1/2053"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — HaiJiaoVlgo/4297",
      "user": "HaiJiaoVlgo/4297"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — ASC2256/907",
      "user": "ASC2256/907"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — tuite910/1458",
      "user": "tuite910/1458"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — qwert9527_z/2172",
      "user": "qwert9527_z/2172"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — AIAVHH/660",
      "user": "AIAVHH/660"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — aizykls/527",
      "user": "aizykls/527"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — meinf6/319",
      "user": "meinf6/319"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — xgduanjuai/324",
      "user": "xgduanjuai/324"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — yellownovel/671",
      "user": "yellownovel/671"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — JQXS91/414",
      "user": "JQXS91/414"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — hhdabb/279",
      "user": "hhdabb/279"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — xiaoshuo_lt/204",
      "user": "xiaoshuo_lt/204"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — zbhshjjd11/33096",
      "user": "zbhshjjd11/33096"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — taoliabc37629/1552",
      "user": "taoliabc37629/1552"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — gghjghvnbvjlm4/1432",
      "user": "gghjghvnbvjlm4/1432"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — BMBBBY/1360",
      "user": "BMBBBY/1360"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — porncloud004/390",
      "user": "porncloud004/390"
    },
    {
      "name": "🎬 👁️ Hypnotic Eyes — twtrailers/7889",
      "user": "twtrailers/7889"
    }
  ],
  "sun_yezi": [
    {
      "name": "🎬 ☀️ Sun Yezi — lmxpd/1994",
      "user": "lmxpd/1994"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — HOTA015/4356",
      "user": "HOTA015/4356"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — cctv_madou/4621",
      "user": "cctv_madou/4621"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — gayboyvideo00/3883",
      "user": "gayboyvideo00/3883"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — luoli905/467",
      "user": "luoli905/467"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — fancha103/5291",
      "user": "fancha103/5291"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — zhubo6688/59779",
      "user": "zhubo6688/59779"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — haijiao133/1973",
      "user": "haijiao133/1973"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — ir_cosplay/2047",
      "user": "ir_cosplay/2047"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — mz6mz6/4504",
      "user": "mz6mz6/4504"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — chiguaxd/2636",
      "user": "chiguaxd/2636"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — redianqingbaoshe/3243",
      "user": "redianqingbaoshe/3243"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — SanYaQZ888/18",
      "user": "SanYaQZ888/18"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — suisui1256/212",
      "user": "suisui1256/212"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — fljisj/7062",
      "user": "fljisj/7062"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — cgt55555/1480",
      "user": "cgt55555/1480"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — fcmgtgbg3/3171",
      "user": "fcmgtgbg3/3171"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — hao123CNN/870100",
      "user": "hao123CNN/870100"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — chiguadage/12194",
      "user": "chiguadage/12194"
    },
    {
      "name": "🎬 ☀️ Sun Yezi — hlcg001/947",
      "user": "hlcg001/947"
    }
  ],
  "odetta": [
    {
      "name": "🎬 💃 Odetta — haozixun/66425",
      "user": "haozixun/66425"
    },
    {
      "name": "🎬 💃 Odetta — PureWaterSpirit2nd/4822",
      "user": "PureWaterSpirit2nd/4822"
    },
    {
      "name": "🎬 💃 Odetta — css0221/552",
      "user": "css0221/552"
    },
    {
      "name": "🎬 💃 Odetta — moli_R18/18060",
      "user": "moli_R18/18060"
    },
    {
      "name": "🎬 💃 Odetta — gghhuuh5668/7672",
      "user": "gghhuuh5668/7672"
    },
    {
      "name": "🎬 💃 Odetta — SLFMJ/65702",
      "user": "SLFMJ/65702"
    },
    {
      "name": "🎬 💃 Odetta — Genshinsetu/19188",
      "user": "Genshinsetu/19188"
    },
    {
      "name": "🎬 💃 Odetta — hacgr18/5279",
      "user": "hacgr18/5279"
    },
    {
      "name": "🎬 💃 Odetta — DYPD_3/5736",
      "user": "DYPD_3/5736"
    },
    {
      "name": "🎬 💃 Odetta — WANJSW/3612",
      "user": "WANJSW/3612"
    },
    {
      "name": "🎬 💃 Odetta — TBBDY/13787",
      "user": "TBBDY/13787"
    },
    {
      "name": "🎬 💃 Odetta — kuakenetpan/3060",
      "user": "kuakenetpan/3060"
    },
    {
      "name": "🎬 💃 Odetta — seedhub_pro/2297",
      "user": "seedhub_pro/2297"
    },
    {
      "name": "🎬 💃 Odetta — djfxkk/20690",
      "user": "djfxkk/20690"
    },
    {
      "name": "🎬 💃 Odetta — doubancom/321111",
      "user": "doubancom/321111"
    },
    {
      "name": "🎬 💃 Odetta — Kaiyan/3591",
      "user": "Kaiyan/3591"
    },
    {
      "name": "🎬 💃 Odetta — cctv0/477",
      "user": "cctv0/477"
    },
    {
      "name": "🎬 💃 Odetta — SLFMJ4661/43420",
      "user": "SLFMJ4661/43420"
    },
    {
      "name": "🎬 💃 Odetta — hyR18/17001",
      "user": "hyR18/17001"
    },
    {
      "name": "🎬 💃 Odetta — koubaowang388/1746",
      "user": "koubaowang388/1746"
    },
    {
      "name": "🎬 💃 Odetta — omei08/7457",
      "user": "omei08/7457"
    },
    {
      "name": "🎬 💃 Odetta — vailovevv/3217",
      "user": "vailovevv/3217"
    },
    {
      "name": "🎬 💃 Odetta — rk898/11410",
      "user": "rk898/11410"
    }
  ],
  "socialite": [
    {
      "name": "🎬 👑 Socialite — cqwhzb",
      "user": "cqwhzb"
    },
    {
      "name": "🎬 👑 Socialite — mingyuan55",
      "user": "mingyuan55"
    },
    {
      "name": "🎬 👑 Socialite — maqtan_time",
      "user": "maqtan_time"
    },
    {
      "name": "🎬 👑 Socialite — NDkXFH",
      "user": "NDkXFH"
    },
    {
      "name": "🎬 👑 Socialite — taotaojiang2",
      "user": "taotaojiang2"
    },
    {
      "name": "🎬 👑 Socialite — fhxyspa",
      "user": "fhxyspa"
    },
    {
      "name": "🎬 👑 Socialite — pkkjmg/2647",
      "user": "pkkjmg/2647"
    },
    {
      "name": "🎬 👑 Socialite — pofdjhvnid/2488",
      "user": "pofdjhvnid/2488"
    },
    {
      "name": "🎬 👑 Socialite — nffl5/288",
      "user": "nffl5/288"
    },
    {
      "name": "🎬 👑 Socialite — dqhi85v5_2/903",
      "user": "dqhi85v5_2/903"
    },
    {
      "name": "🎬 👑 Socialite — MoJingR_S1/5140",
      "user": "MoJingR_S1/5140"
    },
    {
      "name": "🎬 👑 Socialite — otrketoer/2906",
      "user": "otrketoer/2906"
    },
    {
      "name": "🎬 👑 Socialite — goddnessaichannelzeta/2571",
      "user": "goddnessaichannelzeta/2571"
    },
    {
      "name": "🎬 👑 Socialite — Alangtuijjan121/4453",
      "user": "Alangtuijjan121/4453"
    },
    {
      "name": "🎬 👑 Socialite — rednote_ob/369",
      "user": "rednote_ob/369"
    },
    {
      "name": "🎬 👑 Socialite — En715/2569",
      "user": "En715/2569"
    },
    {
      "name": "🎬 👑 Socialite — papasqlm/15616",
      "user": "papasqlm/15616"
    },
    {
      "name": "🎬 👑 Socialite — lmrqfcjx/2969",
      "user": "lmrqfcjx/2969"
    },
    {
      "name": "🎬 👑 Socialite — gghjghvnbvjlm4/1916",
      "user": "gghjghvnbvjlm4/1916"
    },
    {
      "name": "🎬 👑 Socialite — hrxxoo31/8897",
      "user": "hrxxoo31/8897"
    },
    {
      "name": "🎬 👑 Socialite — tian_kong00/3944",
      "user": "tian_kong00/3944"
    }
  ],
  "nine_gates": [
    {
      "name": "🎬 ⛩️ Nine Gates — HanTang8/11215",
      "user": "HanTang8/11215"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — bdwpzhpd/19654",
      "user": "bdwpzhpd/19654"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — yingshi9999/806",
      "user": "yingshi9999/806"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — yunpanx/136643",
      "user": "yunpanx/136643"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — tgzhuiju/6147",
      "user": "tgzhuiju/6147"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — cctv1/48192",
      "user": "cctv1/48192"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — game8500/5578",
      "user": "game8500/5578"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — yp123pan/3190",
      "user": "yp123pan/3190"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — BaiduCloudDiskchat/275141",
      "user": "BaiduCloudDiskchat/275141"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — cctv0/48192",
      "user": "cctv0/48192"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — XBL0420/815",
      "user": "XBL0420/815"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — dsju123/13325",
      "user": "dsju123/13325"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — dxxbdxxb/709",
      "user": "dxxbdxxb/709"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — pan_guangya/1721",
      "user": "pan_guangya/1721"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — viph66666/1413",
      "user": "viph66666/1413"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — fuhao35700/159",
      "user": "fuhao35700/159"
    },
    {
      "name": "🎬 ⛩️ Nine Gates — Remux4KFilm/31608",
      "user": "Remux4KFilm/31608"
    }
  ],
  "ssaimi": [
    {
      "name": "🎬 ✨ Ssaimi — daoten/3211",
      "user": "daoten/3211"
    },
    {
      "name": "🎬 ✨ Ssaimi — stbb66/2450",
      "user": "stbb66/2450"
    },
    {
      "name": "🎬 ✨ Ssaimi — m1m9w/5851",
      "user": "m1m9w/5851"
    },
    {
      "name": "🎬 ✨ Ssaimi — fjl15/4961",
      "user": "fjl15/4961"
    },
    {
      "name": "🎬 ✨ Ssaimi — wangxi1818/3420",
      "user": "wangxi1818/3420"
    },
    {
      "name": "🎬 ✨ Ssaimi — pa8884/72055",
      "user": "pa8884/72055"
    },
    {
      "name": "🎬 ✨ Ssaimi — comicamg/5305",
      "user": "comicamg/5305"
    },
    {
      "name": "🎬 ✨ Ssaimi — haijiaomei/11153",
      "user": "haijiaomei/11153"
    },
    {
      "name": "🎬 ✨ Ssaimi — laochijialubo/4227",
      "user": "laochijialubo/4227"
    },
    {
      "name": "🎬 ✨ Ssaimi — flj657/3778",
      "user": "flj657/3778"
    },
    {
      "name": "🎬 ✨ Ssaimi — gyzst/4026",
      "user": "gyzst/4026"
    },
    {
      "name": "🎬 ✨ Ssaimi — blac315/18689",
      "user": "blac315/18689"
    },
    {
      "name": "🎬 ✨ Ssaimi — m1m9w3324/1321",
      "user": "m1m9w3324/1321"
    },
    {
      "name": "🎬 ✨ Ssaimi — YS011B/10674",
      "user": "YS011B/10674"
    },
    {
      "name": "🎬 ✨ Ssaimi — duolaxiazi1/4507",
      "user": "duolaxiazi1/4507"
    },
    {
      "name": "🎬 ✨ Ssaimi — chengseyouxuan/932",
      "user": "chengseyouxuan/932"
    },
    {
      "name": "🎬 ✨ Ssaimi — stpfgp/9848",
      "user": "stpfgp/9848"
    },
    {
      "name": "🎬 ✨ Ssaimi — AA404AV/2396",
      "user": "AA404AV/2396"
    }
  ],
  "dragon_restaurant": [
    {
      "name": "▶️ [Aug 13 at 11:33] DNYQWCG/234390",
      "user": "DNYQWCG/234390",
      "url": "https://t.me/DNYQWCG/234390"
    },
    {
      "name": "▶️ [Aug 12 at 15:44] chigua_e/191253",
      "user": "chigua_e/191253",
      "url": "https://t.me/chigua_e/191253"
    },
    {
      "name": "🎬 chiguagxzx/130251",
      "user": "chiguagxzx/130251",
      "url": "https://t.me/chiguagxzx/130251"
    },
    {
      "name": "🎬 chiguazhongxin/111301",
      "user": "chiguazhongxin/111301",
      "url": "https://t.me/chiguazhongxin/111301"
    },
    {
      "name": "▶️ [2:13] bgcgw/2761",
      "user": "bgcgw/2761",
      "url": "https://t.me/bgcgw/2761"
    },
    {
      "name": "▶️ [Aug 13 at 11:40] dycgr/16888",
      "user": "dycgr/16888",
      "url": "https://t.me/dycgr/16888"
    },
    {
      "name": "▶️ [Aug 12 at 10:00] chiguaou/190655",
      "user": "chiguaou/190655",
      "url": "https://t.me/chiguaou/190655"
    },
    {
      "name": "▶️ [0:09] bgcgw1/2761",
      "user": "bgcgw1/2761",
      "url": "https://t.me/bgcgw1/2761"
    },
    {
      "name": "▶️ [0:00] dianying4K/1347",
      "user": "dianying4K/1347",
      "url": "https://t.me/dianying4K/1347"
    },
    {
      "name": "▶️ [0:22] yixian8/6201",
      "user": "yixian8/6201",
      "url": "https://t.me/yixian8/6201"
    },
    {
      "name": "▶️ [Aug 12 at 11:33] XLABdxb/8812",
      "user": "XLABdxb/8812",
      "url": "https://t.me/XLABdxb/8812"
    },
    {
      "name": "▶️ [Dec 15, 2025 at 08:04] ithome_full/517679",
      "user": "ithome_full/517679",
      "url": "https://t.me/ithome_full/517679"
    },
    {
      "name": "▶️ [6:05] aadf034/1699",
      "user": "aadf034/1699",
      "url": "https://t.me/aadf034/1699"
    },
    {
      "name": "▶️ [0:09] FundNewsDaily/2431",
      "user": "FundNewsDaily/2431",
      "url": "https://t.me/FundNewsDaily/2431"
    },
    {
      "name": "▶️ [Aug 10 at 02:22] ScienceMagazineeee/3064",
      "user": "ScienceMagazineeee/3064",
      "url": "https://t.me/ScienceMagazineeee/3064"
    },
    {
      "name": "▶️ [Aug 11 at 05:06] doudouhug/413",
      "user": "doudouhug/413",
      "url": "https://t.me/doudouhug/413"
    }
  ],
  "shoko_shouko": [
    {
      "name": "🎬 lmxpd/1994",
      "user": "lmxpd/1994",
      "url": "https://t.me/lmxpd/1994"
    },
    {
      "name": "▶️ [0:00] HOTA015/4356",
      "user": "HOTA015/4356",
      "url": "https://t.me/HOTA015/4356"
    },
    {
      "name": "🎬 gayboyvideo00/3883",
      "user": "gayboyvideo00/3883",
      "url": "https://t.me/gayboyvideo00/3883"
    },
    {
      "name": "🎬 cctv_madou/4621",
      "user": "cctv_madou/4621",
      "url": "https://t.me/cctv_madou/4621"
    },
    {
      "name": "🎬 fancha103/5291",
      "user": "fancha103/5291",
      "url": "https://t.me/fancha103/5291"
    },
    {
      "name": "🎬 zhubo6688/59779",
      "user": "zhubo6688/59779",
      "url": "https://t.me/zhubo6688/59779"
    },
    {
      "name": "🎬 ir_cosplay/2047",
      "user": "ir_cosplay/2047",
      "url": "https://t.me/ir_cosplay/2047"
    },
    {
      "name": "▶️ [0:21] mz6mz6/4504",
      "user": "mz6mz6/4504",
      "url": "https://t.me/mz6mz6/4504"
    },
    {
      "name": "▶️ [May 14 at 11:31] SanYaQZ888/18",
      "user": "SanYaQZ888/18",
      "url": "https://t.me/SanYaQZ888/18"
    },
    {
      "name": "▶️ [May 5 at 09:51] chiguaxd/2636",
      "user": "chiguaxd/2636",
      "url": "https://t.me/chiguaxd/2636"
    },
    {
      "name": "▶️ [Jun 16 at 01:30] boafwh/88",
      "user": "boafwh/88",
      "url": "https://t.me/boafwh/88"
    },
    {
      "name": "🎬 CYnbSVSD/3915",
      "user": "CYnbSVSD/3915",
      "url": "https://t.me/CYnbSVSD/3915"
    },
    {
      "name": "▶️ [May 5 at 15:06] heiliaobaoguanshe/1483",
      "user": "heiliaobaoguanshe/1483",
      "url": "https://t.me/heiliaobaoguanshe/1483"
    },
    {
      "name": "▶️ [May 7 at 01:31] chiguadage/12194",
      "user": "chiguadage/12194",
      "url": "https://t.me/chiguadage/12194"
    },
    {
      "name": "🎬 fcmgtgbg3/3171",
      "user": "fcmgtgbg3/3171",
      "url": "https://t.me/fcmgtgbg3/3171"
    }
  ]
};

// ============================
// 📹 VIDEO FILE_ID CACHE & HISTORY TRACKING
// ============================
const VIDEO_CACHE_FILE = dataPath("video_cache.json");
let videoFileIdCache = {};
const userMessageHistory = new Map();

function loadVideoCache() {
  try {
    if (fs.existsSync(VIDEO_CACHE_FILE)) {
      videoFileIdCache = JSON.parse(fs.readFileSync(VIDEO_CACHE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error reading video_cache.json:", err.message);
    videoFileIdCache = {};
  }
}

function saveVideoCache(resId, fileId) {
  try {
    videoFileIdCache[String(resId)] = fileId;
    writeJsonAtomicSync(VIDEO_CACHE_FILE, videoFileIdCache);
  } catch (err) {
    console.error("Error writing video_cache.json:", err.message);
  }
}

function getCachedFileId(resId) {
  return videoFileIdCache[String(resId)] || null;
}

loadVideoCache();

function trackMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  if (!userMessageHistory.has(chatId)) {
    userMessageHistory.set(chatId, new Set());
  }
  userMessageHistory.get(chatId).add(messageId);
}

async function clearUserHistory(chatId) {
  if (!userMessageHistory.has(chatId)) return 0;
  const msgIds = Array.from(userMessageHistory.get(chatId));
  let deletedCount = 0;
  for (const msgId of msgIds) {
    try {
      await bot.deleteMessage(chatId, msgId);
      deletedCount++;
    } catch (e) {
      // Ignore if already deleted or > 48h
    }
  }
  userMessageHistory.delete(chatId);
  return deletedCount;
}

// ============================
// 📜 USER SEARCH HISTORY TRACKING
// ============================
const userSearchHistoryMap = new Map();

function recordUserSearch(chatId, query) {
  if (!chatId || !query || typeof query !== "string") return;
  const cleanQuery = query.trim();
  if (!cleanQuery || cleanQuery.startsWith("/")) return;

  if (!userSearchHistoryMap.has(chatId)) {
    userSearchHistoryMap.set(chatId, []);
  }
  const history = userSearchHistoryMap.get(chatId);
  const filtered = history.filter(q => q.toLowerCase() !== cleanQuery.toLowerCase());
  filtered.unshift(cleanQuery);
  if (filtered.length > 5) filtered.length = 5;
  userSearchHistoryMap.set(chatId, filtered);
}

function getUserSearchHistory(chatId) {
  return userSearchHistoryMap.get(chatId) || [];
}

function clearUserSearchHistory(chatId) {
  userSearchHistoryMap.delete(chatId);
}

// ============================
// ⌨️ PERSISTENT NAVIGATION KEYBOARD
// ============================
function getPersistentNavigationKeyboard() {
  return {
    keyboard: [
      [
        { text: "🏠 홈" },
        { text: "🔒 VIP 접근 상태 확인" },
        { text: "🗑️ 기록" }
      ]
    ],
    resize_keyboard: true,
    persistent: true,
    is_persistent: true
  };
}

const getPersistentKeyboard = getPersistentNavigationKeyboard;

// ============================
// 🔧 HELPER FUNCTIONS & API WRAPPERS
// ============================
function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeTelegramPayload(obj) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return sanitizeUTF8(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeTelegramPayload(item));
  }

  if (typeof obj === "object") {
    const sanitized = {};
    for (const key of Object.keys(obj)) {
      if (key === "url" || key === "callback_data") {
        sanitized[key] = obj[key];
      } else {
        sanitized[key] = sanitizeTelegramPayload(obj[key]);
      }
    }
    return sanitized;
  }

  return obj;
}

function auditTelegramError(funcName, chatId, err, text, options) {
  const errCode = err.code || (err.response && err.response.body ? err.response.body.error_code : "UNKNOWN");
  const errDesc = err.message || (err.response && err.response.body ? err.response.body.description : String(err));

  // Ignore harmless Telegram API non-errors
  if (errDesc.includes("message is not modified")) {
    return;
  }

  // Handle file ID recovery and no-text-in-message notices quietly
  const isFileIdErr = /wrong remote file identifier|can't unserialize it|Wrong padding|Wrong last symbol|invalid file identifier|file_id_invalid/i.test(errDesc);
  const isNoTextErr = /there is no text in the message to edit|message to edit has no text/i.test(errDesc);

  if (isFileIdErr) {
    if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
      console.log(`⚠️ [FILE_ID RECOVERY TRIGGERED] Func:${funcName} | ChatID:${chatId} | ${errDesc}`);
    }
    return;
  }

  if (isNoTextErr) {
    if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
      console.log(`ℹ️ [EDIT_TEXT NOTICE] Func:${funcName} | ChatID:${chatId} | ${errDesc}`);
    }
    return;
  }

  console.error(`❌ [TELEGRAM API ERROR] Func:${funcName} | ChatID:${chatId} | Code:${errCode} | Error:${errDesc}`);

  if (options && options.reply_markup && Array.isArray(options.reply_markup.inline_keyboard)) {
    if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
      console.log(`📋 [KEYBOARD AUDIT] Rows:${options.reply_markup.inline_keyboard.length}`);
    }
    options.reply_markup.inline_keyboard.forEach((row, rIdx) => {
      if (!Array.isArray(row)) return;
      row.forEach((btn, cIdx) => {
        if (btn && typeof btn.text === "string") {
          const btnText = btn.text;
          const jsonText = JSON.stringify(btnText);
          const hasUnpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(btnText);
          const codePoints = Array.from(btnText).map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
          if (hasUnpaired || errDesc.includes("UTF-8")) {
            console.error(`🚨 [BAD BUTTON DETECTED] Row ${rIdx} Col ${cIdx} | Text:"${btnText}" | JSON:${jsonText} | Unpaired:${hasUnpaired} | CodePoints:${codePoints}`);
          }
        }
      });
    });
  }
}

async function sendMessageSafe(chatId, text, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  const cleanText = sanitizeUTF8(text);
  try {
    const res = await bot.sendMessage(chatId, cleanText, cleanOpts);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    auditTelegramError("sendMessageSafe", chatId, err, cleanText, cleanOpts);
  }
}

async function sendPhotoSafe(chatId, photo, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  try {
    const res = await bot.sendPhoto(chatId, photo, cleanOpts);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    auditTelegramError("sendPhotoSafe", chatId, err, photo, cleanOpts);
  }
}

async function sendVideoSafe(chatId, video, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  try {
    const res = await bot.sendVideo(chatId, video, cleanOpts);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    auditTelegramError("sendVideoSafe", chatId, err, video, cleanOpts);
  }
}

async function copyMessageSafe(chatId, fromChatId, messageId, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  try {
    const res = await bot.copyMessage(chatId, fromChatId, messageId, cleanOpts);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    auditTelegramError("copyMessageSafe", chatId, err, `from:${fromChatId}:${messageId}`, cleanOpts);
  }
}

async function forwardMessageSafe(chatId, fromChatId, messageId, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  try {
    const res = await bot.forwardMessage(chatId, fromChatId, messageId, cleanOpts);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    auditTelegramError("forwardMessageSafe", chatId, err, `from:${fromChatId}:${messageId}`, cleanOpts);
  }
}

async function answerCallbackQuerySafe(queryId, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  try {
    return await bot.answerCallbackQuery(queryId, cleanOpts);
  } catch (err) {
    console.error(`❌ Error answering callback query ${queryId}:`, err.message);
  }
}

async function editMessageTextSafe(chatId, messageId, text, options = {}) {
  const cleanOpts = sanitizeTelegramPayload(options);
  const cleanText = sanitizeUTF8(text);
  try {
    const opts = {
      chat_id: chatId,
      message_id: messageId,
      ...cleanOpts
    };
    return await bot.editMessageText(cleanText, opts);
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) {
      return true;
    }
    auditTelegramError("editMessageTextSafe", chatId, err, cleanText, cleanOpts);
    return await sendMessageSafe(chatId, cleanText, cleanOpts);
  }
}

// ============================
// 📹 DATASET FEATURED POSTS RESOLVER & RENDERER
// ============================
let FEATURED_DATASET = {};
try {
  const featuredDatasetFile = path.join(__dirname, "featured_dataset.json");
  if (fs.existsSync(featuredDatasetFile)) {
    FEATURED_DATASET = JSON.parse(fs.readFileSync(featuredDatasetFile, "utf8"));
  }
} catch (err) {
  console.error("Error reading featured_dataset.json:", err.message);
}

function getFeaturedPosts(cardId) {
  const cardData = FEATURED_DATASET[String(cardId)];
  if (!cardData || !Array.isArray(cardData.posts)) {
    return [];
  }
  return cardData.posts;
}

// ============================
// 📁 CONTENT HUB DATASET & LOADER
// ============================
function getContentHubCategories() {
  return contentHubScraper.getCategories();
}

function getContentHubCategoryById(catId) {
  return contentHubScraper.getCategoryById(catId);
}

function getContentHubItemById(catId, itemId) {
  return contentHubScraper.getItemById(catId, itemId);
}

function extractChannelInfo(url, title) {
  if (!url || typeof url !== "string") {
    return { key: "unknown", name: "Unknown Channel", type: "other" };
  }

  // Private invite link t.me/+hash
  if (url.includes("/+") || url.includes("joinchat")) {
    const inviteHash = url.split("/+")[1] ? url.split("/+")[1].split("?")[0] : "private";
    return {
      key: `invite_${inviteHash}`,
      name: `🔒 Private Group (+${inviteHash.slice(0, 8)}...)`,
      type: "private"
    };
  }

  // Standard username t.me/username/123 or t.me/username
  const match = url.match(/t\.me\/([^/?#]+)(?:\/(\d+))?/);
  if (match) {
    const username = match[1];
    return {
      key: `user_${username.toLowerCase()}`,
      name: `@${username}`,
      username: username,
      type: "channel"
    };
  }

  return { key: "other", name: "Other Resource", type: "other" };
}

function getFeaturedChannels(cardId) {
  const posts = getFeaturedPosts(cardId);
  if (!posts || posts.length === 0) return [];

  const channelMap = {};
  posts.forEach(post => {
    const ch = extractChannelInfo(post.url, post.title);
    if (!channelMap[ch.key]) {
      channelMap[ch.key] = {
        key: ch.key,
        name: ch.name,
        type: ch.type,
        posts: []
      };
    }
    channelMap[ch.key].posts.push(post);
  });

  return Object.values(channelMap);
}


function localizeDisplayTitle(rawTitle, categoryName = "") {
  if (!rawTitle || typeof rawTitle !== "string") {
    return categoryName ? `${categoryName} 추천 영상` : "추천 영상";
  }

  let t = rawTitle.trim();

  // Strip leading icons and duration tags
  t = t
    .replace(/^▶️\s*/g, "")
    .replace(/^▶\s*/g, "")
    .replace(/^🎬\s*/g, "")
    .replace(/\[\d+:\d+\]\s*/g, "")
    .trim();

  // Strip prefix category tags like [Romantic Vibe], [Dating], [Romance], etc.
  t = t.replace(/^\[(Romantic Vibe|Dating|Romance|Crotch|Mosa|Bunny Girl Cosplay Date|Lustful Hostess|Concubine|Saki Mizumi|A Muse)\]\s*/i, '');

  // Specific high-frequency English/Chinese studio & series patterns
  const PATTERN_REPLACEMENTS = [
    { regex: /\[Uncle Kangaroo - VIP Preview\]/gi, replace: "캥거루 아저씨 VIP 프리뷰:" },
    { regex: /\[Uncle Kangaroo - Resource Sharing\]/gi, replace: "캥거루 아저씨 자원공유:" },
    { regex: /\[袋鼠大叔-VIP预览\]/gi, replace: "캥거루 아저씨 VIP 프리뷰:" },
    { regex: /\[袋鼠大叔-资源分享\]/gi, replace: "캥거루 아저씨 자원공유:" },
    { regex: /\[MyGirlfriendsBustyFriend\]/gi, replace: "내 여자친구의 글래머 친구" },
    { regex: /\[FilthyFamily\]/gi, replace: "패밀리 시크릿" },
    { regex: /Big tit Latina/gi, replace: "글래머 라티나" },
    { regex: /91 Great God Series/gi, replace: "91 대작 컬렉션" },
    { regex: /91大神/gi, replace: "91 대작" },
    { regex: /One Bed Two Couple/gi, replace: "원 베드 투 커플" },
    { regex: /Hungry Sisters/gi, replace: "배고픈 자매들" },
    { regex: /Love Lesson/gi, replace: "러브 레슨 (화려한 외출)" },
    { regex: /Daughter-in-law's First Love/gi, replace: "며느리의 첫사랑" },
    { regex: /My Sister's Friend/gi, replace: "내 여동생의 친구" },
    { regex: /My Father's Wife/gi, replace: "아버지의 여자" },
    { regex: /My Daughter's Tutor/gi, replace: "딸의 과외 선생님" },
    { regex: /My Best Friend's Wife/gi, replace: "내 절친의 아내" },
    { regex: /Mother and Daughter/gi, replace: "엄마와 딸" },
    { regex: /Lonely Sister/gi, replace: "외로운 누나" },
    { regex: /Kind Daughter-in-Law/gi, replace: "친절한 며느리" },
    { regex: /In-Law's Seduction/gi, replace: "사돈의 유혹" },
    { regex: /Housekeeper Wife/gi, replace: "가정부 아내" },
    { regex: /Hard Working Good Daughter-in-Law/gi, replace: "착하고 열심인 며느리" },
    { regex: /Free Sex/gi, replace: "자유로운 사랑" },
    { regex: /Adult Sport/gi, replace: "성인 스포츠" },
    { regex: /I Lend You My Wife/gi, replace: "내 아내를 빌려드립니다" },
    { regex: /First Person Forbidden Ejaculation/gi, replace: "1인칭 시점 금지된 유혹" },
    { regex: /Exchange Wife/gi, replace: "스와핑 아내" },
    { regex: /Award-winning Housekeeper/gi, replace: "최우수 가정부의 비밀" },
    { regex: /A Wet Flower, A Blooming Wife/gi, replace: "젖은 꽃 피어나는 아내" },
    { regex: /Delicious Sister Rice Bowl/gi, replace: "맛있는 자매 덮밥" },
    { regex: /A New Female Employee Who is Made Fun Of By A Perverted Boss/gi, replace: "변태 상사에게 놀림당하는 신입 여직원" },
    { regex: /Erotic Tutoring/gi, replace: "비밀 과외" },
    { regex: /Erotic Actor!! I Won't!/gi, replace: "에로 배우는 사절이야!" },
    { regex: /Disciple of Deokjin Yuk/gi, replace: "덕진육의 수제자" },
    { regex: /Delivery Massage/gi, replace: "출장 힐링 마사지" },
    { regex: /Advanced Prostitute/gi, replace: "고급 콜걸" },
    { regex: /A Friends Wife Sold In Debt/gi, replace: "빚 대신 팔려간 친구의 아내" },
    { regex: /Young Older Sister in Law/gi, replace: "젊은 형수의 비밀스런 사랑 이야기" },
    { regex: /Good Mother/gi, replace: "착한 엄마" },
    { regex: /Between Her Legs Drunk/gi, replace: "취중 밀회: 그녀의 다리 사이" },
    { regex: /Can I Eat Your Sausage!?/gi, replace: "맛있는 소시지 먹어도 될까요!" },
    { regex: /Girl next Door/gi, replace: "옆집 소녀의 은밀한 비밀" },
    { regex: /Bitch Wife Squirting/gi, replace: "매혹적인 아내의 짜릿한 하이라이트" },
    { regex: /Friends Manet/gi, replace: "친구의 은밀한 비밀 화보" },
    { regex: /台湾福利姬小母狗【优咪 lewdyumi】/gi, replace: "대만 인기 코스플레이어 유미 최신작" },
    { regex: /Mutual Relations/gi, replace: "상호 관계: 세 남녀의 은밀한 사랑 이야기" },
    { regex: /Intimacy/gi, replace: "정사" },
    { regex: /Dirty Bandit Aggregation/gi, replace: "더티 밴딧 컬렉션 스페셜" }
  ];

  for (const item of PATTERN_REPLACEMENTS) {
    if (item.regex.test(t)) {
      t = t.replace(item.regex, item.replace).trim();
    }
  }

  // Strip prefix category tags like [Romantic Vibe], [Dating], [Romance], etc.
  t = t.replace(/^\[(Romantic Vibe|Dating|Romance|Crotch|Mosa|Bunny Girl Cosplay Date|Lustful Hostess|Concubine|Saki Mizumi|A Muse)\]\s*/i, '');

  // Strip spam channel noise
  t = t
    .replace(/HD\s*»\s*▰.*$/i, 'HD')
    .replace(/🔰BACK UP CHANNEL🔰/gi, '')
    .replace(/🔰BACK UP.*?$/gi, '')
    .replace(/- 91porn.*$/gi, '')
    .trim();

  // Check language of title
  const lang = detectSourceLanguage(t);
  const hasHangul = /[\uac00-\ud7af]/.test(t);

  // If title is non-Korean, check if translated version exists in memory cache
  if (lang !== "ko" || !hasHangul) {
    const cacheKey = `ko:${t}`;
    if (captionTranslationCache && captionTranslationCache.has(cacheKey)) {
      const cached = captionTranslationCache.get(cacheKey);
      if (cached && /[\uac00-\ud7af]/.test(cached)) {
        t = cached;
      }
    } else if (typeof translateToKorean === "function") {
      // Trigger background translation so upcoming views resolve immediately
      translateToKorean(t).catch(() => {});
    }
  }

  // Clean trailing punctuation and symbols
  t = t.replace(/^[-\s:]+/, '').replace(/[-\s:]+$/, '').trim();

  // If no title after cleaning, fallback to category recommendation
  if (!t || t === "제목 없음") {
    t = categoryName ? `${categoryName} 추천 영상` : "신규 영상";
  }

  return t.length > 80 ? t.substring(0, 77) + "..." : t;
}

/**
 * Asynchronously localizes display title using translateToKorean
 * @param {string} rawTitle
 * @param {string} [categoryName]
 * @returns {Promise<string>}
 */
async function localizeDisplayTitleAsync(rawTitle, categoryName = "") {
  if (!rawTitle || typeof rawTitle !== "string") {
    return categoryName ? `${categoryName} 추천 영상` : "추천 영상";
  }

  let t = rawTitle.trim();

  // Strip leading icons and duration tags
  t = t
    .replace(/^▶️\s*/g, "")
    .replace(/^▶\s*/g, "")
    .replace(/^🎬\s*/g, "")
    .replace(/\[\d+:\d+\]\s*/g, "")
    .trim();

  // Strip prefix category tags
  t = t.replace(/^\[(Romantic Vibe|Dating|Romance|Crotch|Mosa|Bunny Girl Cosplay Date|Lustful Hostess|Concubine|Saki Mizumi|A Muse)\]\s*/i, '');

  // Specific high-frequency English/Chinese studio & series patterns
  const PATTERN_REPLACEMENTS = [
    { regex: /\[Uncle Kangaroo - VIP Preview\]/gi, replace: "캥거루 아저씨 VIP 프리뷰:" },
    { regex: /\[Uncle Kangaroo - Resource Sharing\]/gi, replace: "캥거루 아저씨 자원공유:" },
    { regex: /\[袋鼠大叔-VIP预览\]/gi, replace: "캥거루 아저씨 VIP 프리뷰:" },
    { regex: /\[袋鼠大叔-资源分享\]/gi, replace: "캥거루 아저씨 자원공유:" },
    { regex: /\[MyGirlfriendsBustyFriend\]/gi, replace: "내 여자친구의 글래머 친구" },
    { regex: /\[FilthyFamily\]/gi, replace: "패밀리 시크릿" },
    { regex: /Big tit Latina/gi, replace: "글래머 라티나" },
    { regex: /91 Great God Series/gi, replace: "91 대작 컬렉션" },
    { regex: /91大神/gi, replace: "91 대작" },
    { regex: /One Bed Two Couple/gi, replace: "원 베드 투 커플" },
    { regex: /Hungry Sisters/gi, replace: "배고픈 자매들" },
    { regex: /Love Lesson/gi, replace: "러브 레슨 (화려한 외출)" },
    { regex: /Daughter-in-law's First Love/gi, replace: "며느리의 첫사랑" },
    { regex: /My Sister's Friend/gi, replace: "내 여동생의 친구" },
    { regex: /My Father's Wife/gi, replace: "아버지의 여자" },
    { regex: /My Daughter's Tutor/gi, replace: "딸의 과외 선생님" },
    { regex: /My Best Friend's Wife/gi, replace: "내 절친의 아내" },
    { regex: /Mother and Daughter/gi, replace: "엄마와 딸" },
    { regex: /Lonely Sister/gi, replace: "외로운 누나" },
    { regex: /Kind Daughter-in-Law/gi, replace: "친절한 며느리" },
    { regex: /In-Law's Seduction/gi, replace: "사돈의 유혹" },
    { regex: /Housekeeper Wife/gi, replace: "가정부 아내" },
    { regex: /Hard Working Good Daughter-in-Law/gi, replace: "착하고 열심인 며느리" },
    { regex: /Free Sex/gi, replace: "자유로운 사랑" },
    { regex: /Adult Sport/gi, replace: "성인 스포츠" },
    { regex: /I Lend You My Wife/gi, replace: "내 아내를 빌려드립니다" },
    { regex: /First Person Forbidden Ejaculation/gi, replace: "1인칭 시점 금지된 유혹" },
    { regex: /Exchange Wife/gi, replace: "스와핑 아내" },
    { regex: /Award-winning Housekeeper/gi, replace: "최우수 가정부의 비밀" },
    { regex: /A Wet Flower, A Blooming Wife/gi, replace: "젖은 꽃 피어나는 아내" },
    { regex: /Delicious Sister Rice Bowl/gi, replace: "맛있는 자매 덮밥" },
    { regex: /A New Female Employee Who is Made Fun Of By A Perverted Boss/gi, replace: "변태 상사에게 놀림당하는 신입 여직원" },
    { regex: /Erotic Tutoring/gi, replace: "비밀 과외" },
    { regex: /Erotic Actor!! I Won't!/gi, replace: "에로 배우는 사절이야!" },
    { regex: /Disciple of Deokjin Yuk/gi, replace: "덕진육의 수제자" },
    { regex: /Delivery Massage/gi, replace: "출장 힐링 마사지" },
    { regex: /Advanced Prostitute/gi, replace: "고급 콜걸" },
    { regex: /A Friends Wife Sold In Debt/gi, replace: "빚 대신 팔려간 친구의 아내" },
    { regex: /Young Older Sister in Law/gi, replace: "젊은 형수의 비밀스런 사랑 이야기" },
    { regex: /Good Mother/gi, replace: "착한 엄마" },
    { regex: /Between Her Legs Drunk/gi, replace: "취중 밀회: 그녀의 다리 사이" },
    { regex: /Can I Eat Your Sausage!?/gi, replace: "맛있는 소시지 먹어도 될까요!" },
    { regex: /Girl next Door/gi, replace: "옆집 소녀의 은밀한 비밀" },
    { regex: /Bitch Wife Squirting/gi, replace: "매혹적인 아내의 짜릿한 하이라이트" },
    { regex: /Friends Manet/gi, replace: "친구의 은밀한 비밀 화보" },
    { regex: /台湾福利姬小母狗【优咪 lewdyumi】/gi, replace: "대만 인기 코스플레이어 유미 최신작" },
    { regex: /Mutual Relations/gi, replace: "상호 관계: 세 남녀의 은밀한 사랑 이야기" },
    { regex: /Intimacy/gi, replace: "정사" },
    { regex: /Dirty Bandit Aggregation/gi, replace: "더티 밴딧 컬렉션 스페셜" }
  ];

  for (const item of PATTERN_REPLACEMENTS) {
    if (item.regex.test(t)) {
      t = t.replace(item.regex, item.replace).trim();
    }
  }

  // Strip prefix category tags
  t = t.replace(/^\[(Romantic Vibe|Dating|Romance|Crotch|Mosa|Bunny Girl Cosplay Date|Lustful Hostess|Concubine|Saki Mizumi|A Muse)\]\s*/i, '');

  // Strip spam channel noise
  t = t
    .replace(/HD\s*»\s*▰.*$/i, 'HD')
    .replace(/🔰BACK UP CHANNEL🔰/gi, '')
    .replace(/🔰BACK UP.*?$/gi, '')
    .replace(/- 91porn.*$/gi, '')
    .trim();

  const lang = detectSourceLanguage(t);
  const hasHangul = /[\uac00-\ud7af]/.test(t);

  if (lang !== "ko" || !hasHangul) {
    try {
      const translated = await translateToKorean(t);
      if (translated && /[\uac00-\ud7af]/.test(translated)) {
        t = translated;
      }
    } catch (err) {
      console.warn("⚠️ [TITLE_TRANSLATION_ERROR]", err.message);
    }
  }

  // Clean trailing punctuation and symbols
  t = t.replace(/^[-\s:]+/, '').replace(/[-\s:]+$/, '').trim();

  // If no title after cleaning, fallback to category recommendation
  if (!t || t === "제목 없음") {
    t = categoryName ? `${categoryName} 추천 영상` : "신규 영상";
  }

  return t.length > 80 ? t.substring(0, 77) + "..." : t;
}

const POPULAR_TOPIC_CARDS = [
  { name: "미얀마", topicKey: "Myanmar" },
  { name: "헝다 가무단", topicKey: "Evergrande Troupe" },
  { name: "미얀마 여성", topicKey: "Myanmar Women" },
  { name: "뱀 누나", topicKey: "Sister Snake" },
  { name: "일거리 있음", topicKey: "Has Work" },
  { name: "괴롭힘과 성관계", topicKey: "Bullying & Sex" },
  { name: "다츠거", topicKey: "Da Ci Ge" },
  { name: "고3 사랑 이야기", topicKey: "Senior Year Love Story" },
  { name: "쓰촨 모자", topicKey: "Sichuan Mother & Son" },
  { name: "후쓰위안", topicKey: "Hu Siyuan" },
  { name: "애인으로 부양", topicKey: "Kept Lover" },
  { name: "디디 대리운영", topicKey: "Didi Proxy Operation" }
];

const TOPIC_NAMES = {
  "Myanmar": "미얀마",
  "Evergrande Troupe": "헝다 가무단",
  "Myanmar Women": "미얀마 여성",
  "Sister Snake": "뱀 누나",
  "Has Work": "일거리 있음",
  "Bullying & Sex": "괴롭힘과 성관계",
  "Da Ci Ge": "다츠거",
  "Senior Year Love Story": "고3 사랑 이야기",
  "Sichuan Mother & Son": "쓰촨 모자",
  "Hu Siyuan": "후쓰위안",
  "Kept Lover": "애인으로 부양",
  "Didi Proxy Operation": "디디 대리운영",

  "미얀마": "미얀마",
  "헝다 가무단": "헝다 가무단",
  "미얀마 여성": "미얀마 여성",
  "뱀 누나": "뱀 누나",
  "일거리 있음": "일거리 있음",
  "괴롭힘과 성관계": "괴롭힘과 성관계",
  "다츠거": "다츠거",
  "고3 사랑 이야기": "고3 사랑 이야기",
  "쓰촨 모자": "쓰촨 모자",
  "후쓰위안": "후쓰위안",
  "애인으로 부양": "애인으로 부양",
  "디디 대리운영": "디디 대리운영",

  // Legacy/fallback mappings
  "Romantic Vibe": "미얀마",
  "Dating": "헝다 가무단",
  "Romance": "미얀마 여성",
  "Crotch": "뱀 누나",
  "Mosa": "일거리 있음",
  "Bunny Girl Cosplay Date": "괴롭힘과 성관계",
  "Lustful Hostess": "다츠거",
  "Concubine": "고3 사랑 이야기",
  "Saki Mizumi": "쓰촨 모자",
  "A Muse": "후쓰위안",
  "ai": "🤖 AI",
  "games": "🎮 게임 플레이",
  "stories": "📚 단편 소설",
  "papers": "🔬 학술 논문",
  "opening_up": "🔓 콘텐츠"
};

// ============================================================
// 🔗 UNIFIED HYPERLINK LIST VIEW RENDERER (WITH 2-STEP DETAIL NAVIGATION)
// ============================================================
async function renderHyperlinkListPostView(chatId, title, items, page = 1, callbackPrefix = "page", messageId = null) {
  if (!items || items.length === 0) {
    const emptyText = `📺 <b>${escapeHTML(title)}</b>\n\n이 채널에 이용 가능한 게시물이 없습니다.`;
    const emptyOpts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 메인 메뉴로 돌아가기", callback_data: "menu" }]
        ]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, emptyText, emptyOpts);
    } else {
      return await sendMessageSafe(chatId, emptyText, emptyOpts);
    }
  }

  const isTopicView = callbackPrefix.startsWith("topic_page:") || callbackPrefix.startsWith("topic:");
  const itemsPerPage = 8;
  const maxTotalPages = 5;
  const maxItemsCap = 40;

  const maxUiItems = (items || []).slice(0, maxItemsCap);
  const totalPages = Math.min(maxTotalPages, Math.ceil(maxUiItems.length / itemsPerPage));
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = maxUiItems.slice(startIndex, startIndex + itemsPerPage);

  const displayTitles = await Promise.all(
    pageItems.map(p => localizeDisplayTitleAsync(p.title || p.name || "", title))
  );

  const itemLines = [];

  pageItems.forEach((p, index) => {
    const itemNumber = startIndex + index + 1;
    let displayTitle = displayTitles[index];

    if (!displayTitle || (displayTitle.includes("Update") && !displayTitle.includes("#"))) {
      displayTitle = "제목 없음";
    }

    const escapedTitle = escapeHTML(displayTitle);

    const rawTarget = `${callbackPrefix}:${startIndex + index}:${currentPage}`;
    const b64 = Buffer.from(rawTarget).toString("base64url");
    const itemUrl = `https://t.me/${currentBotUsername}?start=d_${b64}`;
    const safeUrl = escapeHTML(itemUrl);

    itemLines.push(`${itemNumber}. <a href="${safeUrl}">${escapedTitle}</a>`);
  });

  let messageText = `📺 <b>${escapeHTML(title)}</b>\n\n`;
  messageText += `이 채널의 최신 동영상 목록입니다.\n\n`;
  messageText += itemLines.join("\n\n");
  if (totalPages > 1) {
    messageText += `\n\n<b>페이지 ${currentPage}/${totalPages}</b>`;
  }

  const inline_keyboard = [];

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: "⬅️ 이전", callback_data: `${callbackPrefix}:${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: "다음 ➡️", callback_data: `${callbackPrefix}:${currentPage + 1}` });
  }
  if (navRow.length > 0) {
    inline_keyboard.push(navRow);
  }
  inline_keyboard.push([{ text: "🏠 메인 메뉴로 돌아가기", callback_data: "menu" }]);

  const messageOptions = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, messageText, messageOptions);
  } else {
    return await sendMessageSafe(chatId, messageText, messageOptions);
  }
}

async function renderItemDetailPage(chatId, callbackPrefix, itemIndex, page = 1, messageId = null) {
  let items = [];
  let title = "상세 정보";

  if (callbackPrefix.startsWith("featured_page:") || callbackPrefix.startsWith("featured:")) {
    const cardId = parseInt(callbackPrefix.split(":")[1], 10);
    const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
    title = cardInfo ? cardInfo.name : `카드 ${cardId}`;
    items = getFeaturedPosts(cardId);
  } else if (callbackPrefix.startsWith("cat_page:") || callbackPrefix.startsWith("cat:")) {
    const catKey = callbackPrefix.split(":")[1];
    const category = CATEGORIES[catKey];
    title = category ? category.title : catKey;
    items = category ? category.items : [];
  } else if (callbackPrefix.startsWith("topic_page:") || callbackPrefix.startsWith("topic:")) {
    const topicKey = callbackPrefix.split(":")[1];
    items = sourceRegistry.getPostsForKeyword(topicKey, false);
    title = TOPIC_NAMES[topicKey] || topicKey;
  }

  let item = null;
  if (typeof itemIndex === "string" && itemIndex.length > 5) {
    item = sourceRegistry.getPostById(itemIndex);
  }
  if (!item) {
    item = items[itemIndex];
  }
  if (!item) {
    return await sendMessageSafe(chatId, "⚠️ 항목 상세 정보를 찾을 수 없습니다.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 홈", callback_data: "menu" }]] }
    });
  }

  let displayTitle = await localizeDisplayTitleAsync(item.title || item.name || "텔레그램 콘텐츠", title);

  // 1. Post URL for [ ▶️ WATCH VIDEO ]
  const src = sourceRegistry.getSourceByKeyword(item.keyword || item.channel_name);
  let postUrl = "";
  if (src && src.username) {
    postUrl = `https://t.me/${src.username}/${item.message_id || ""}`;
  } else if (item.username) {
    postUrl = `https://t.me/${item.username}/${item.message_id || ""}`;
  } else if (src && src.invite_url) {
    postUrl = src.invite_url;
  } else if (item.invite_url) {
    postUrl = item.invite_url;
  } else if (item.telegram_url && !item.telegram_url.includes("/c/")) {
    postUrl = item.telegram_url;
  } else if (item.url) {
    postUrl = item.url;
  } else if (item.chat_id && item.message_id) {
    let cleanChatId = String(item.chat_id).startsWith("-100") ? String(item.chat_id).substring(4) : String(item.chat_id).replace("-", "");
    postUrl = `https://t.me/c/${cleanChatId}/${item.message_id}`;
  }

  // 2. Channel/Group URL for [ 🔗 JOIN GROUP ]
  let groupUrl = "";
  if (src && src.username) {
    groupUrl = `https://t.me/${src.username}`;
  } else if (item.username) {
    groupUrl = `https://t.me/${item.username}`;
  } else if (src && src.invite_url) {
    groupUrl = src.invite_url;
  } else if (item.invite_url) {
    groupUrl = item.invite_url;
  } else if (src && src.public_url) {
    groupUrl = src.public_url;
  } else {
    groupUrl = postUrl;
  }

  let channelName = item.channel_name || item.user || (src ? src.name : title);
  let mediaType = item.media_type ? item.media_type.toUpperCase() : "VIDEO";
  let duration = item.duration ? `\n<b>재생 시간:</b> ${item.duration}` : "";
  let views = item.views ? `\n<b>조회수:</b> ${item.views}` : "";
  let caption = item.caption ? `\n\n<b>설명:</b>\n${escapeHTML(item.caption)}` : "";

  let videoBox = `┌────────────────────────────────────────┐\n`;
  videoBox += `│  🎬 <a href="${postUrl}"><b>[ 동영상 미리보기 ]</b></a>    │\n`;
  videoBox += `│  ▶️  화면이나 버튼을 누르면 동영상을 시청할 수 있습니다  │\n`;
  videoBox += `└────────────────────────────────────────┘\n\n`;

  let detailText = `🎬 <b>${escapeHTML(displayTitle)}</b>\n\n`;
  detailText += videoBox;
  detailText += `<b>채널:</b> ${escapeHTML(channelName)}\n`;
  detailText += `<b>유형:</b> ${mediaType}${views}${duration}${caption}`;

  const inline_keyboard = [
    [{ text: "🔗 채널 입장", url: groupUrl }],
    [
      { text: "◀️ 뒤로가기", callback_data: `${callbackPrefix}:${page}` },
      { text: "🏠 홈", callback_data: "menu" }
    ]
  ];

  const opts = {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard }
  };

  let cachedFileId = item.file_id || item.video_file_id || getCachedFileId(item.id || item.unique_hash);
  if (cachedFileId && (typeof cachedFileId !== "string" || /^\d+$/.test(cachedFileId) || cachedFileId.length < 25 || cachedFileId.includes("LIVE_TEST") || cachedFileId.includes("test_"))) {
    cachedFileId = null;
  }

  // No MTProto lookup here: resolveMediaForPost() never yields a Bot API
  // file_id, so calling it on every view only spent Telegram API quota
  // (getDialogs + getEntity) and invited FloodWaits.

  let fromChatId = item.chat_id || (item.username ? (item.username.startsWith("@") ? item.username : `@${item.username}`) : null);
  if (!fromChatId && (item.keyword || item.channel_name)) {
    const src = sourceRegistry.getSourceByKeyword(item.keyword || item.channel_name);
    if (src) {
      fromChatId = src.chat_id || (src.username ? (src.username.startsWith("@") ? src.username : `@${src.username}`) : null);
    }
  }

  // 1. Send via cached Telegram Bot API file_id if available
  if (cachedFileId) {
    if (item.media_type === "photo") {
      const res = await sendPhotoSafe(chatId, cachedFileId, {
        caption: detailText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
      if (res) return res;
    } else {
      const res = await sendVideoSafe(chatId, cachedFileId, {
        caption: detailText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
      if (res) return res;
    }

    // If cachedFileId failed (res is null), invalidate cached file_id and proceed to native Telegram channel recovery
    sourceRegistry.invalidateVideoFileId(item.id || item.unique_hash || item.message_id);
    clearVideoCache(item.id || item.unique_hash);
    cachedFileId = null;
  }

  if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
    console.log("[VIDEO_DETAIL]");
    console.log(`message_id=${item.message_id || "N/A"}`);
    console.log(`media_type=${item.media_type}`);
    console.log(`video_file_id=${cachedFileId || "N/A"}`);
    console.log(`telegram_url=${postUrl}`);
    console.log(`preview_result=${cachedFileId || fromChatId ? "SUCCESS" : "FALLBACK_TEXT"}`);
    console.log(`join_url=${groupUrl}`);
  }

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, detailText, opts);
  } else {
    return await sendMessageSafe(chatId, detailText, opts);
  }
}

async function renderFeaturedCardPosts(chatId, cardId, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const cardName = cardInfo ? cardInfo.name : `Card ${cardId}`;
  const posts = getFeaturedPosts(cardId);
  return await renderHyperlinkListPostView(chatId, cardName, posts, page, `featured_page:${cardId}`, messageId);
}

function getContentHubCategoryListText(categoryId, page = 1) {
  const category = getContentHubCategoryById(categoryId);
  if (!category) return `📁 <b>콘텐츠 허브</b>\n\n카테고리를 찾을 수 없습니다.`;
  const items = category.items || [];
  const itemsPerPage = 8;
  const totalPages = Math.ceil(items.length / itemsPerPage) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = items.slice(startIndex, startIndex + itemsPerPage);

  const header =
    `📁 <b>콘텐츠 허브 > ${escapeHTML(category.title)}</b>` +
    (totalPages > 1 ? ` (페이지 ${currentPage}/${totalPages})\n\n` : `\n\n`) +
    `원하는 사이트를 선택하세요. 👇\n\n`;

  const itemBlocks = pageItems.map(item => {
    const displayText = (item.description && item.description.trim()) ? item.description.trim() : item.name;
    return `<a href="${item.url}">${escapeHTML(displayText)}</a>`;
  });

  return header + itemBlocks.join("\n\n");
}

function getContentHubCategoryKeyboard(categoryId, page = 1) {
  const category = getContentHubCategoryById(categoryId);
  if (!category) {
    return {
      inline_keyboard: [[{ text: "📂 카테고리 목록", callback_data: "ch_hub" }]]
    };
  }

  const items = category.items || [];
  const itemsPerPage = 8;
  const totalPages = Math.ceil(items.length / itemsPerPage) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const rows = [];

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀️ 이전", callback_data: `ch_page:${categoryId}:${currentPage - 1}` });
    } else {
      navRow.push({ text: "◀️ 이전", callback_data: "none" });
    }
    navRow.push({ text: `[ ${currentPage} / ${totalPages} ]`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "다음 ▶️", callback_data: `ch_page:${categoryId}:${currentPage + 1}` });
    } else {
      navRow.push({ text: "다음 ▶️", callback_data: "none" });
    }
    rows.push(navRow);
  }

  rows.push([
    { text: "📂 카테고리 목록", callback_data: "ch_hub" },
    { text: "🏠 메인 메뉴", callback_data: "menu" }
  ]);

  return { inline_keyboard: rows };
}

function getContentHubItemDetailText(categoryId, itemId) {
  const category = getContentHubCategoryById(categoryId);
  const item = getContentHubItemById(categoryId, itemId);
  if (!category || !item) return `📁 <b>콘텐츠 허브</b>\n\n사이트 정보를 찾을 수 없습니다.`;

  const icon = category.icon || "📺";
  const desc = item.description ? `\n\n${escapeHTML(item.description)}` : "";
  const subItems = Array.isArray(item.sub_items) ? item.sub_items : [];

  if (subItems.length > 0) {
    const subList = subItems.map((sub) => `• ${escapeHTML(sub.name)}`).join("\n");
    return (
      `${icon} <b>${escapeHTML(item.name)}</b>\n\n` +
      `📁 <b>카테고리:</b> ${escapeHTML(category.title)}` +
      desc + `\n\n` +
      `📋 <b>주요 항목:</b>\n` +
      subList
    );
  }

  return (
    `${icon} <b>${escapeHTML(item.name)}</b>\n\n` +
    `📁 <b>카테고리:</b> ${escapeHTML(category.title)}` +
    desc + `\n\n` +
    `원본 사이트에서 콘텐츠를 확인할 수 있습니다.`
  );
}

function getContentHubItemDetailKeyboard(categoryId, itemId, page = 1) {
  const item = getContentHubItemById(categoryId, itemId);
  if (!item) {
    return {
      inline_keyboard: [[{ text: "📂 전체 카테고리", callback_data: "ch_hub" }]]
    };
  }

  const rows = [];
  rows.push([{ text: "🔗 사이트 바로가기 ↗", url: item.url }]);

  if (Array.isArray(item.sub_items) && item.sub_items.length > 0) {
    for (const sub of item.sub_items) {
      if (sub.name && sub.url && (sub.url.startsWith("http://") || sub.url.startsWith("https://"))) {
        rows.push([{ text: `🔗 ${sub.name} ↗`, url: sub.url }]);
      }
    }
  }

  rows.push([
    { text: "◀️ 목록으로", callback_data: `ch_page:${categoryId}:${page}` },
    { text: "📂 전체 카테고리", callback_data: "ch_hub" }
  ]);

  return { inline_keyboard: rows };
}

async function renderContentHubCategoryList(chatId, categoryId, page = 1, messageId = null) {
  const text = getContentHubCategoryListText(categoryId, page);
  const reply_markup = getContentHubCategoryKeyboard(categoryId, page);
  const opts = { parse_mode: "HTML", disable_web_page_preview: true, reply_markup };
  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  } else {
    return await sendMessageSafe(chatId, text, opts);
  }
}

async function renderContentHubItemDetail(chatId, categoryId, itemId, page = 1, messageId = null) {
  const text = getContentHubItemDetailText(categoryId, itemId);
  const reply_markup = getContentHubItemDetailKeyboard(categoryId, itemId, page);
  const opts = { parse_mode: "HTML", disable_web_page_preview: false, reply_markup };
  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  } else {
    return await sendMessageSafe(chatId, text, opts);
  }
}

async function renderCategoryResources(chatId, catKey, page = 1, messageId = null) {
  const catObj = getContentHubCategoryById(catKey);
  if (catObj) {
    return await renderContentHubCategoryList(chatId, catKey, page, messageId);
  }
  const category = CATEGORIES[catKey];
  if (!category) return;
  return await renderHyperlinkListPostView(chatId, category.title, category.items, page, `cat_page:${catKey}`, messageId);
}

async function renderTopicPosts(chatId, topicKey, page = 1, messageId = null) {
  const posts = sourceRegistry.getPostsForKeyword(topicKey, true);
  const allRegistryPosts = sourceRegistry.getPostsForKeyword(topicKey, false);
  const displayTopicName = TOPIC_NAMES[topicKey] || topicKey;
  const resolvedSourceObj = sourceRegistry.getSourceByKeyword(topicKey);
  const resolvedSourceName = resolvedSourceObj ? (resolvedSourceObj.name || resolvedSourceObj.keyword) : topicKey;

  if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
    console.log("[TOPIC_FLOW]");
    console.log(`requested_card=${topicKey}`);
    console.log(`resolved_channel=${resolvedSourceName}`);
    console.log(`real_video_count=${posts.length}`);
    console.log(`list_count=${Math.min(10, posts.length)}`);
  }

  return await renderHyperlinkListPostView(chatId, displayTopicName, posts, page, `topic_page:${topicKey}`, messageId);
}

async function renderFeaturedChannelPosts(chatId, cardId, channelIndex, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const channels = getFeaturedChannels(cardId);
  const channel = channels[channelIndex];

  if (!channel || !channel.posts || channel.posts.length === 0) {
    const text = `📺 <b>채널을 찾을 수 없습니다</b>\n\n등록된 게시물이 없습니다.`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "◀️ 채널 목록", callback_data: `featured:${cardId}:1` }],
          [{ text: "🏠 메인 메뉴", callback_data: "menu" }]
        ]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  }

  const posts = channel.posts;
  const itemsPerPage = 8;
  const totalPages = Math.ceil(posts.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pagePosts = posts.slice(startIndex, startIndex + itemsPerPage);

  const channelUrl = channel.username
    ? `https://t.me/${channel.username}`
    : (channel.posts[0] ? channel.posts[0].url.split("/").slice(0, 4).join("/") : null);

  const rows = pagePosts.map(p => {
    const titleText = truncateUTF8(p.title, 55);
    let icon = "🎬";
    if (p.url.includes("img") || p.title.toLowerCase().includes("photo") || p.title.includes("🖼️")) {
      icon = "🖼️";
    } else if (p.title.includes("▶️") || p.title.toLowerCase().includes("video")) {
      icon = "▶️";
    }
    return [{ text: `${icon} ${titleText}`, url: p.url }];
  });

  // Pagination row if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀️ 이전", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage - 1}` });
    }
    navRow.push({ text: `[ ${currentPage} / ${totalPages} ]`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "다음 ▶️", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  // Open Channel button if valid channelUrl exists
  if (channelUrl) {
    rows.push([{ text: `🔗 ${channel.name} 채널 바로가기`, url: channelUrl }]);
  }

  rows.push([
    { text: "◀️ 채널 목록", callback_data: `featured:${cardId}:1` },
    { text: "🏠 메인 메뉴", callback_data: "menu" }
  ]);
  const opts = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  } else {
    return await sendMessageSafe(chatId, text, opts);
  }
}

function truncateUTF8(str, maxLen = 50) {
  if (!str) return "";
  const cleanStr = sanitizeUTF8(str);
  const symbols = Array.from(cleanStr);
  if (symbols.length <= maxLen) {
    return cleanStr;
  }
  return symbols.slice(0, maxLen - 1).join("") + "…";
}

function makeSearchCallbackData(keyword) {
  const safeKw = truncateUTF8(keyword, 57);
  return `search:${safeKw}`;
}

function getTrendingKeywords() {
  try {
    const trendingFile = dataPath("trending.json");
    if (fs.existsSync(trendingFile)) {
      const data = JSON.parse(fs.readFileSync(trendingFile, "utf8"));
      return data.keywords || [];
    }
  } catch (err) {
    console.error("Error reading trending.json:", err.message);
  }
  return [];
}

function getBreakingNews() {
  try {
    const breakingFile = dataPath("breaking.json");
    if (fs.existsSync(breakingFile)) {
      const data = JSON.parse(fs.readFileSync(breakingFile, "utf8"));
      return data.news || [];
    }
  } catch (err) {
    console.error("Error reading breaking.json:", err.message);
  }
  return [];
}

function parseNewsItem(item) {
  if (!item) return { title: "", url: "" };
  if (typeof item === "object" && item !== null) {
    const title = typeof item.title === "string" ? item.title : (typeof item.name === "string" ? item.name : "");
    const url = typeof item.url === "string" ? item.url : (typeof item.link === "string" ? item.link : "");
    return { title, url };
  }
  if (typeof item === "string") {
    return { title: item, url: `https://www.google.com/search?q=${encodeURIComponent(item)}` };
  }
  return { title: String(item), url: "" };
}

const TARGET_CHANNELS = [
  "Romantic Vibe",
  "Dating",
  "Romance",
  "Crotch",
  "Mosa",
  "Bunny Girl Cosplay Date",
  "Lustful Hostess",
  "Concubine",
  "Saki Mizumi",
  "A Muse"
];

async function formatTrendingCardLabel(rawTitle, isVideoCard = false, cardIndex = 0, channelKeyword = "") {
  let titleText = rawTitle ? String(rawTitle).trim() : "";

  // 1. Translate title to Korean if not already in Korean
  if (titleText && !/[\uac00-\ud7af]/.test(titleText)) {
    try {
      titleText = await translateText(titleText, "ko");
    } catch (e) {}
  }

  // Clean title: remove existing leading emojis, brackets, CJK leftovers, special noise
  titleText = sanitizeUTF8(titleText)
    .replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s▶️🎬🖼️🔥⭐🎤👁️🖤⚽🎲💃👑📰🚨📈🌎🇰🇷🏙️💬🎵💻🤖💰❤️✨👀🌟🎯📱]+/gu, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/[^\w\s"-\uac00-\ud7af]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Video Cards specific (Cards 11-20): process actual raw source video title
  if (isVideoCard) {
    let lowerVideo = titleText.toLowerCase();
    let videoSubject = "";

    // Extract actual video subject / topic strictly from raw post title
    if (lowerVideo.includes("selena") || lowerVideo.includes("셀레나")) {
      videoSubject = "셀레나 고메즈";
    } else if (lowerVideo.includes("kaede") || lowerVideo.includes("카에데")) {
      videoSubject = "제니 카에데";
    } else if (lowerVideo.includes("jennie") || lowerVideo.includes("제니")) {
      videoSubject = "제니 영상";
    } else if (lowerVideo.includes("live") || lowerVideo.includes("라이브") || lowerVideo.includes("dating")) {
      videoSubject = "라이브 데이트";
    } else if (lowerVideo.includes("gangnam") || lowerVideo.includes("강남")) {
      videoSubject = "강남 188GB";
    } else if (lowerVideo.includes("book") || lowerVideo.includes("책") || lowerVideo.includes("소설")) {
      videoSubject = "커플 스토리";
    } else if (lowerVideo.includes("servant") || lowerVideo.includes("하녀")) {
      videoSubject = "하녀와 남편";
    } else if (lowerVideo.includes("husband") || lowerVideo.includes("wife") || lowerVideo.includes("커플")) {
      videoSubject = "커플 스페셜";
    } else if (lowerVideo.includes("muse") || lowerVideo.includes("뮤즈")) {
      videoSubject = "뮤즈 업데이트";
    } else if (lowerVideo.includes("high-profile") || lowerVideo.includes("화제")) {
      videoSubject = "화제의 영상";
    } else if (titleText.length >= 2 && !/^\d+$/.test(titleText) && /[\uac00-\ud7af]/.test(titleText)) {
      videoSubject = smartShortenTitle(titleText, 18);
    } else {
      videoSubject = "";
    }

    if (videoSubject && /[\uac00-\ud7af]/.test(videoSubject)) {
      let emoji = "🎬";
      const lowerSub = videoSubject.toLowerCase();
      if (lowerSub.includes("셀레나") || lowerSub.includes("음악")) emoji = "🎵";
      else if (lowerSub.includes("제니")) emoji = "✨";
      else if (lowerSub.includes("강남")) emoji = "🏙️";
      else if (lowerSub.includes("스토리") || lowerSub.includes("소설")) emoji = "📖";
      else if (lowerSub.includes("하녀") || lowerSub.includes("커플") || lowerSub.includes("남편")) emoji = "❤️";
      else if (lowerSub.includes("라이브")) emoji = "🔴";
      else if (lowerSub.includes("화제")) emoji = "🎬";
      else if (lowerSub.includes("뮤즈")) emoji = "🎨";
      else emoji = "🎥";

      return `${emoji} ${videoSubject}`;
    }
    return "";
  }

  const cleanLabel = smartShortenTitle(titleText, 18);
  return cleanLabel;
}

function smartShortenTitle(str, maxLen = 18) {
  if (!str) return "";
  let clean = str.trim();

  // Expand / preserve full meaningful terms where applicable
  const lower = clean.toLowerCase();
  if (lower === "son") return "Son Heung-min";
  if (lower === "bus") return "Bus Trends";
  if (lower === "flood") return "Flood Updates";
  if (lower === "missile") return "Missile News";
  if (lower === "migration") return "Migration Trends";
  if (lower.includes("diamondbac")) return "Diamondbacks";
  if (lower.includes("lg group") || lower === "lg") return "LG Group";
  if (lower.includes("lens vs")) return "Lens vs PSG";

  if (clean.length <= maxLen) return clean;

  const words = clean.split(" ");
  if (words.length > 1) {
    let result = words[0];
    for (let i = 1; i < words.length; i++) {
      if ((result + " " + words[i]).length <= maxLen) {
        result += " " + words[i];
      } else {
        break;
      }
    }
    return result;
  }

  const symbols = Array.from(clean);
  return symbols.slice(0, maxLen - 1).join("") + "…";
}

async function getMainKeyboard() {
  const buttons = POPULAR_TOPIC_CARDS.map(c => ({
    text: c.name,
    callback_data: `topic:${c.topicKey}`
  }));

  const gridRows = [];
  for (let i = 0; i < buttons.length; i += 3) {
    gridRows.push(buttons.slice(i, i + 3));
  }

  return { inline_keyboard: gridRows };
}

async function getBreakingNewsKeyboard() {
  const breaking = getBreakingNews();
  const rows = [];

  rows.push([{ text: "📰 속보", callback_data: "none" }]);

  if (breaking && breaking.length > 0) {
    for (let i = 0; i < breaking.length; i++) {
      const { title: rawTitle, url: originalUrl } = parseNewsItem(breaking[i]);
      if (!rawTitle) continue;

      const translatedTitle = await translateText(rawTitle, "ko");
      const cleanDisplay = (typeof translatedTitle === "string" && translatedTitle.length > 0 && !translatedTitle.includes("[object Object]"))
        ? translatedTitle
        : rawTitle;

      const targetUrl = originalUrl || `https://www.google.com/search?q=${encodeURIComponent(rawTitle)}`;

      rows.push([{
        text: `📰 ${cleanDisplay}`,
        url: targetUrl
      }]);
    }
  }

  // Action buttons at bottom of Breaking News screen
  rows.push([{ text: "🔄 새로고침", callback_data: "screen:breaking" }]);

  // Additional category cards section (8 cards from Content Hub)
  const cats = getContentHubCategories();
  const catButtons = cats.map(c => ({
    text: (c.icon && c.icon.trim().length > 0) ? `${c.icon} ${c.title}` : c.title,
    callback_data: `ch_cat:${c.id}`
  }));
  for (let i = 0; i < catButtons.length; i += 2) {
    rows.push(catButtons.slice(i, i + 2));
  }

  rows.push([{ text: "🏠 메인 메뉴", callback_data: "menu" }]);

  return { inline_keyboard: rows };
}

async function getCategoryHubKeyboard() {
  const cats = getContentHubCategories();
  const buttons = cats.map(c => ({
    text: (c.icon && c.icon.trim().length > 0) ? `${c.icon} ${c.title}` : c.title,
    callback_data: `ch_cat:${c.id}`
  }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([{ text: "🏠 메인 메뉴", callback_data: "menu" }]);

  return { inline_keyboard: rows };
}

function getVipLockedText() {
  return (
    `🔒 <b>VIP 접근 승인이 필요합니다.</b>\n\n` +
    `VIP 카드 상세 안내 및 전용 그룹에 접근하려면 관리자(@ooalw)의 승인이 필요합니다.\n\n` +
    `아래 버튼을 눌러 승인을 요청하세요. 👇`
  );
}

function getVipLockedKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📩 VIP 접근 요청", callback_data: "vip_request_access" }
      ],
      [
        { text: "🏠 메인 메뉴", callback_data: "menu" }
      ]
    ]
  };
}

function getVipInstructionText() {
  return (
    `🔐 <b>VIP 그룹입장</b>\n\n` +
    `VIP 그룹 이용을 위해 아래 절차를 진행해주세요.\n\n` +
    `① 오리온 회원가입\n` +
    `   <a href="https://orion5555.com">https://orion5555.com</a>\n\n` +
    `② 추천인\n` +
    `   red\n\n` +
    `③ 1만원 이상 플레이 후 인증\n\n` +
    `📸 인증샷을 @ooalw 로 보내주세요.\n\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `✅ 관리자 승인이 완료되었습니다!\n` +
    `아래 버튼을 눌러 VIP 그룹에 입장하세요. 👇`
  );
}

const getVipCardText = getVipInstructionText;

function getVipInstructionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔐 VIP 그룹 입장", url: vipAccessManager.getVipGroupLink() }
      ],
      [
        { text: "🔗 오리온 바로가기", url: "https://orion5555.com" },
        { text: "📸 인증샷 보내기 (@ooalw)", url: "https://t.me/ooalw" }
      ],
      [
        { text: "🏠 메인 메뉴", callback_data: "menu" }
      ]
    ]
  };
}

const getVipCardKeyboard = getVipInstructionKeyboard;
const getVipApprovedText = getVipInstructionText;
const getVipApprovedKeyboard = getVipInstructionKeyboard;

function getVipPendingText() {
  return (
    `⏳ <b>VIP 접근 승인 대기 중입니다.</b>\n\n` +
    `관리자(@ooalw) 확인 후 승인되면 VIP 카드 상세 정보 및 그룹 링크가 잠금 해제됩니다.`
  );
}

function getVipPendingKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔄 다시 확인", callback_data: "screen:vip" }
      ],
      [
        { text: "🏠 메인 메뉴", callback_data: "menu" }
      ]
    ]
  };
}

function getVipRejectedText() {
  return (
    `❌ <b>VIP 접근 권한이 거절되었습니다.</b>\n\n` +
    `관리자의 확인 결과 승인되지 않았습니다.\n` +
    `문의 사항은 관리자(@ooalw)에게 연락해주세요.`
  );
}

function getVipRejectedKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📩 VIP 재요청", callback_data: "vip_request_access" }
      ],
      [
        { text: "🏠 메인 메뉴", callback_data: "menu" }
      ]
    ]
  };
}

async function renderVipScreen(chatId, messageId = null, user = null) {
  const userId = user ? (user.id || user.userId) : chatId;
  const isApproved = vipAccessManager.isVipApproved(userId);

  let text, keyboard;
  if (isApproved) {
    text = getVipApprovedText();
    keyboard = getVipApprovedKeyboard();
  } else {
    const status = vipAccessManager.getVipStatus(userId);
    if (status === "PENDING") {
      text = getVipPendingText();
      keyboard = getVipPendingKeyboard();
    } else if (status === "REJECTED") {
      text = getVipRejectedText();
      keyboard = getVipRejectedKeyboard();
    } else {
      text = getVipLockedText();
      keyboard = getVipLockedKeyboard();
    }
  }

  const opts = {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: keyboard
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  }
  return await sendMessageSafe(chatId, text, opts);
}

async function renderVipStatusScreen(chatId, messageId = null, user = null) {
  return await renderVipScreen(chatId, messageId, user);
}

async function getTrendingKeyboard() {
  const rows = [];

  // 1. 🔥 실시간 검색어 상위 10 ⚡
  const rankingData = rankingScraper.getLocalRankings();
  const rankings = (rankingData && Array.isArray(rankingData.rankings)) ? rankingData.rankings : [];

  if (rankings.length > 0) {
    rows.push([{ text: "🔥 실시간 검색어 상위 10 ⚡", callback_data: "none" }]);
    const rankEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    const rankingButtons = [];
    for (let i = 0; i < Math.min(10, rankings.length); i++) {
      const item = rankings[i];
      if (!item || !item.keyword) continue;
      const emoji = rankEmojis[i] || `${i + 1}️⃣`;
      const targetUrl = item.url || `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(item.keyword)}`;

      rankingButtons.push({
        text: `${emoji} ${item.keyword}`,
        url: targetUrl
      });
    }

    // Pair ranking buttons: 2 per row (1 line = 2 ranking cards)
    for (let i = 0; i < rankingButtons.length; i += 2) {
      rows.push(rankingButtons.slice(i, i + 2));
    }

    rows.push([{ text: "🔄 순위 새로고침", callback_data: "refresh_rankings" }]);
  }

  // 2. 🔥 인기 주제 Section Header & 20 Cards (4 rows x 5 columns)
  rows.push([{ text: "🔥 인기 주제", callback_data: "none" }]);
  const mainKeys = (await getMainKeyboard()).inline_keyboard;
  rows.push(...mainKeys);

  // 3. 📰 속보 Header & Scraped Breaking News List (5) & 🔄 새로고침
  const breaking = getBreakingNews();
  rows.push([{ text: "📰 속보", callback_data: "none" }]);

  if (breaking && breaking.length > 0) {
    for (let i = 0; i < breaking.length; i++) {
      const { title: rawTitle, url: originalUrl } = parseNewsItem(breaking[i]);
      if (!rawTitle) continue;

      const translatedTitle = await translateText(rawTitle, "ko");
      const cleanDisplay = (typeof translatedTitle === "string" && translatedTitle.length > 0 && !translatedTitle.includes("[object Object]"))
        ? translatedTitle
        : rawTitle;

      const targetUrl = originalUrl || `https://www.google.com/search?q=${encodeURIComponent(rawTitle)}`;

      rows.push([{
        text: `📰 ${cleanDisplay}`,
        url: targetUrl
      }]);
    }
  }
  rows.push([{ text: "🔄 새로고침", callback_data: "refresh_trending" }]);

  // 4. VIP 그룹입장 Header & 8 Category Cards (4 rows x 2 columns)
  rows.push([{ text: "VIP 그룹입장", callback_data: "screen:vip" }]);
  const cats = getContentHubCategories();
  const catButtons = cats.map(c => ({
    text: (c.icon && c.icon.trim().length > 0) ? `${c.icon} ${c.title}` : c.title,
    callback_data: `ch_cat:${c.id}`
  }));
  for (let i = 0; i < catButtons.length; i += 2) {
    rows.push(catButtons.slice(i, i + 2));
  }

  // 5. 🏠 메인 메뉴
  rows.push([{ text: "🏠 메인 메뉴", callback_data: "menu" }]);

  return { inline_keyboard: rows };
}

async function renderSearchResults(chatId, query, page = 1, messageId = null) {
  recordUserSearch(chatId, query);
  const displayQuery = await translateText(query, "ko");

  // Search posts from our 10 managed Telegram channels
  let posts = sourceRegistry.searchPosts(query);
  if ((!posts || posts.length === 0) && displayQuery !== query) {
    posts = sourceRegistry.searchPosts(displayQuery);
  }

  const titleHeader = `🔍 실시간 검색어: ${displayQuery}`;
  const callbackPrefix = `search_page:${encodeURIComponent(query)}`;

  return await renderHyperlinkListPostView(chatId, titleHeader, posts, page, callbackPrefix, messageId);
}

function getChannelButtons(channels) {
  const rows = channels.map(ch => ([
    { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
  ]));
  rows.push([{ text: "🏠 메인 메뉴로 돌아가기", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function formatChannelList(channels, topicName) {
  const displayTopicName = TOPIC_NAMES[topicName] || topicName;
  return `📢 <b>${escapeHTML(displayTopicName)}</b>\n\n👇 아래 항목을 누르세요:`;
}

async function renderNewsArticlePage(chatId, articleIndex = 0, messageId = null) {
  const breaking = getBreakingNews();
  if (!breaking || breaking.length === 0) {
    const text = "📰 <b>속보 뉴스</b>\n\n현재 표시할 최신 뉴스 속보가 없습니다.";
    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 메인 메뉴로 돌아가기", callback_data: "menu" }]]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    }
    return await sendMessageSafe(chatId, text, opts);
  }

  const idx = Math.max(0, Math.min(articleIndex, breaking.length - 1));
  const { title: rawTitle, url: originalUrl } = parseNewsItem(breaking[idx]);
  const translatedTitle = await translateText(rawTitle, "ko");
  const displayTitle = (typeof translatedTitle === "string" && translatedTitle.length > 0 && !translatedTitle.includes("[object Object]"))
    ? translatedTitle
    : rawTitle;

  const text =
    `📰 <b>속보 상세 뉴스 [ ${idx + 1} / ${breaking.length} ]</b>\n\n` +
    `📌 <b>${escapeHTML(displayTitle)}</b>\n\n` +
    `💡 아래 버튼을 클릭하여 번역된 원문 기사를 확인하거나 다른 속보를 둘러보세요.`;

  const googleTranslateUrl = originalUrl
    ? `https://translate.google.com/translate?sl=auto&tl=ko&u=${encodeURIComponent(originalUrl)}`
    : `https://www.google.com/search?q=${encodeURIComponent(rawTitle)}`;

  const inline_keyboard = [];
  inline_keyboard.push([{ text: "🔗 원문 보기 (한국어 번역)", url: googleTranslateUrl }]);

  const navRow = [];
  if (idx > 0) {
    navRow.push({ text: "⬅️ 이전 속보", callback_data: `news_art:${idx - 1}` });
  }
  if (idx < breaking.length - 1) {
    navRow.push({ text: "다음 속보 ➡️", callback_data: `news_art:${idx + 1}` });
  }
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🏠 메인 메뉴로 돌아가기", callback_data: "menu" }]);

  const opts = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard }
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  }
  return await sendMessageSafe(chatId, text, opts);
}


// ============================
// 📁 8 PERMANENT CONTENT HUB CATEGORIES (DYNAMIC PROXY FROM DATASET)
// ============================
const CATEGORIES = new Proxy({}, {
  get(target, prop) {
    if (typeof prop === "symbol") return target[prop];
    const cat = contentHubScraper.getCategoryById(prop);
    if (!cat) return undefined;
    return {
      id: cat.id,
      title: `${cat.icon} ${cat.title}`,
      icon: cat.icon,
      name: cat.title,
      items: (cat.items || []).map(it => ({
        id: it.id,
        name: `${cat.icon} ${it.name}`,
        title: it.name,
        url: it.url,
        description: it.description
      }))
    };
  },
  ownKeys() {
    return contentHubScraper.getCategories().map(c => c.id);
  },
  getOwnPropertyDescriptor(target, prop) {
    const cat = contentHubScraper.getCategoryById(prop);
    if (cat) {
      return {
        enumerable: true,
        configurable: true,
        value: this.get(target, prop)
      };
    }
    return undefined;
  },
  has(target, prop) {
    return !!contentHubScraper.getCategoryById(prop);
  }
});

// ============================
// 🚀 /start COMMAND
// ============================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const payload = match ? match[1] : null;

    if (msg.from) {
      vipAccessManager.registerAdminIfMatched(msg.from);
    }

    if (payload && (payload.startsWith("d_") || payload.startsWith("det_") || payload.startsWith("det~") || payload.startsWith("video_") || payload.startsWith("v_"))) {
      let callbackPrefix = "";
      let itemIdx = 0;
      let page = 1;

      if (payload.startsWith("d_")) {
        const b64 = payload.slice(2);
        const raw = Buffer.from(b64, "base64url").toString("utf8");
        const parts = raw.split(":");
        page = parseInt(parts.pop(), 10) || 1;
        itemIdx = parseInt(parts.pop(), 10) || 0;
        callbackPrefix = parts.join(":");
      } else if (payload.startsWith("det~")) {
        const parts = payload.split("~");
        callbackPrefix = decodeURIComponent(parts[1] || "");
        itemIdx = parseInt(parts[2], 10) || 0;
        page = parseInt(parts[3], 10) || 1;
      } else if (payload.startsWith("video_") || payload.startsWith("v_")) {
        const videoId = payload.startsWith("v_") ? payload.slice(2) : payload.replace("video_", "");
        const post = sourceRegistry.getPostById(videoId);
        if (post) {
          callbackPrefix = `topic_page:${post.keyword}`;
          const posts = sourceRegistry.getPostsForKeyword(post.keyword, false);
          const foundIdx = posts.findIndex(p => p.id === post.id || p.unique_hash === post.unique_hash);
          itemIdx = foundIdx !== -1 ? foundIdx : 0;
          page = Math.floor(itemIdx / 8) + 1;
        } else {
          callbackPrefix = "topic_page:Romance";
          itemIdx = 0;
          page = 1;
        }
      } else if (payload.startsWith("det_")) {
        try {
          const raw = Buffer.from(payload.slice(4), "base64url").toString("utf8");
          if (raw.includes(":")) {
            const parts = raw.split(":");
            page = parseInt(parts.pop(), 10) || 1;
            itemIdx = parseInt(parts.pop(), 10) || 0;
            callbackPrefix = parts.join(":");
          } else {
            const parts = payload.split("_");
            page = parseInt(parts.pop(), 10) || 1;
            itemIdx = parseInt(parts.pop(), 10) || 0;
            callbackPrefix = parts.slice(1).join(":");
          }
        } catch (_) {
          const parts = payload.split("_");
          page = parseInt(parts.pop(), 10) || 1;
          itemIdx = parseInt(parts.pop(), 10) || 0;
          callbackPrefix = parts.slice(1).join(":");
        }
      }

      await renderItemDetailPage(chatId, callbackPrefix, itemIdx, page, null);
      return;
    }

    const firstName = msg.from.first_name || "there";

    // 1. Send welcome message registering persistent bottom ReplyKeyboardMarkup
    await sendMessageSafe(chatId,
      `📡 <b>NexaHub에 오신 것을 환영합니다, ${escapeHTML(firstName)}님!</b>\n\n` +
      `🔍 텔레그램 리소스 검색 엔진입니다. 키워드를 전송하여 그룹, 채널, 동영상, 음악을 검색하세요.\n\n` +
      `한국어 및 영어를 지원합니다.`,
      {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      }
    );

    // 2. Send 12 Popular Topic cards & Trending keywords with InlineKeyboardMarkup
    const combinedKeyboard = await getTrendingKeyboard();

    await sendMessageSafe(chatId,
      `🔥 <b>핫 토픽</b>\n\n탐색할 주제를 선택하세요 👇`,
      {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      }
    );
  } catch (err) {
    console.error("❌ Error handling /start:", err.message);
  }
}); 

// Command: /19guide
bot.onText(/\/19guide/, async (msg) => {
  try {
    const chatId = msg.chat.id;

    const message = `<b>텔레그램 제한/민감한 콘텐츠 해제 가이드 (iOS)</b>\n\n` +
      `그룹이나 채널에 가입할 때 다음 메시지가 표시되는 경우:\n\n` +
      `<i>"포르노 콘텐츠 유포에 사용되었기 때문에 이 채널을 표시할 수 없습니다."</i>\n\n` +
      `<b>원인:</b>\n` +
      `해당 채널 또는 그룹이 민감한 콘텐츠로 인해 텔레그램에서 제한되었습니다.\n\n` +
      `<b>✅ 해제 방법:</b>\n\n` +
      `모바일 또는 데스크톱 브라우저에서 텔레그램 웹 접속: https://web.telegram.org\n\n` +
      `다음 순서대로 설정하세요:\n` +
      `➊ 설정 (Settings) 이동\n` +
      `➋ 개인 정보 및 보안 (Privacy and Security) 선택\n` +
      `➌ 민감한 콘텐츠 (Sensitive Content) 항목으로 스크롤\n` +
      `➍ "필터링 안 함" (Disable filtering) 활성화\n\n` +
      `iOS 기기에서 텔레그램 앱을 재시작하면 모든 콘텐츠에 정상적으로 접근할 수 있습니다.`;

    await sendMessageSafe(chatId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("❌ Error handling /19guide:", err.message);
  }
});

// ============================
// 🔒 PER-USER CONCURRENCY LOCK
// ============================
const activeUserLocks = new Set();

function acquireUserLock(chatId) {
  const key = String(chatId);
  if (activeUserLocks.has(key)) {
    return false;
  }
  activeUserLocks.add(key);
  return true;
}

function releaseUserLock(chatId) {
  const key = String(chatId);
  activeUserLocks.delete(key);
}

// ============================
// 🔘 BUTTON CALLBACKS
// ============================
bot.on("callback_query", async (query) => {
  try {
    const chatId = query.message ? query.message.chat.id : query.from.id;
    const data = query.data;

    if (query.from) {
      vipAccessManager.registerAdminIfMatched(query.from);
      console.log(`🔘 [CALLBACK_QUERY] data="${data}", from=${query.from.id} (@${query.from.username || "no_user"})`);
    }

    const isMediaMsg = query.message && (query.message.video || query.message.photo || query.message.document || query.message.animation);
    const messageId = (query.message && !isMediaMsg) ? query.message.message_id : null;

    if (data === "none") {
      return await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith("vip_card:")) {
      const parts = data.split(":");
      const category = parts[1] || "ALL";
      const page = parseInt(parts[2], 10) || 1;
      const { VipTopicRouter } = require("./video_pipeline/vip_topic_router");
      const vipRouter = new VipTopicRouter();

      // Auto-bind topic thread if clicked inside a thread!
      const tId = (query.message && query.message.message_thread_id) || (query.message && query.message.reply_to_message && query.message.reply_to_message.message_thread_id);
      if (tId && category !== "ALL") {
        vipRouter.registerThreadMapping(tId, category);
      }

      const { text, keyboard } = vipRouter.formatCategoryCard(category, page);
      if (query.message) {
        await bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_web_page_preview: true
        }).catch(() => {});
      }
      return await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith("vip_bind:")) {
      const parts = data.split(":");
      const category = parts[1] || "ALL";
      const threadId = parts[2] ? parseInt(parts[2], 10) : null;
      const { VipTopicRouter } = require("./video_pipeline/vip_topic_router");
      const vipRouter = new VipTopicRouter();

      if (threadId && category !== "ALL") {
        vipRouter.registerThreadMapping(threadId, category);
      }

      const { text, keyboard } = vipRouter.formatCategoryCard(category, 1);
      if (query.message) {
        await bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_web_page_preview: true
        }).catch(() => {});
      }
      return await bot.answerCallbackQuery(query.id, { text: `✅ [${category}] 채널로 연결되었습니다!` }).catch(() => {});
    }

    if (data === "vip_card_main") {
      const { VipTopicRouter } = require("./video_pipeline/vip_topic_router");
      const vipRouter = new VipTopicRouter();
      const { text, keyboard } = vipRouter.formatCategoryCard("ALL", 1);
      if (query.message) {
        await bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_web_page_preview: true
        }).catch(() => {});
      }
      return await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith("det:")) {
      // det:<callbackPrefix>:<itemIndex>:<page>
      const firstColon = data.indexOf(":");
      const secondColon = data.indexOf(":", firstColon + 1);
      const lastColon = data.lastIndexOf(":");
      const callbackPrefix = data.substring(firstColon + 1, lastColon - (lastColon > secondColon ? (data.length - lastColon) : 0));
      // Split by colon: det, prefixType, key, itemIdx, page
      const parts = data.split(":");
      const page = parseInt(parts.pop(), 10) || 1;
      const itemIdx = parseInt(parts.pop(), 10) || 0;
      const prefix = parts.slice(1).join(":");
      await renderItemDetailPage(chatId, prefix, itemIdx, page, messageId);
    } else if (data.startsWith("featured_page:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const page = parseInt(parts[2], 10);
      await renderFeaturedCardPosts(chatId, cardId, page, messageId);
    } else if (data.startsWith("featured_ch:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const chIndex = parseInt(parts[2], 10);
      const page = parseInt(parts[3] || "1", 10);
      await renderFeaturedChannelPosts(chatId, cardId, chIndex, page, messageId);
    } else if (data.startsWith("featured:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const page = parseInt(parts[2] || "1", 10);
      await renderFeaturedCardPosts(chatId, cardId, page, messageId);
    } else if (data.startsWith("search_page:")) {
      const parts = data.split(":");
      const query = decodeURIComponent(parts[1] || "");
      const page = parseInt(parts[2] || "1", 10);
      await renderSearchResults(chatId, query, page, messageId);
    } else if (data.startsWith("search:")) {
      const keyword = data.replace("search:", "");
      await renderSearchResults(chatId, keyword, 1, messageId);
    } else if (data.startsWith("ch_item:")) {
      const parts = data.split(":");
      const catId = parts[1];
      const itemId = parts[2];
      const page = parseInt(parts[3], 10) || 1;
      await renderContentHubItemDetail(chatId, catId, itemId, page, messageId);
    } else if (data.startsWith("ch_page:")) {
      const parts = data.split(":");
      const catId = parts[1];
      const page = parseInt(parts[2], 10) || 1;
      await renderContentHubCategoryList(chatId, catId, page, messageId);
    } else if (data.startsWith("ch_back_category:")) {
      const parts = data.split(":");
      const catId = parts[1];
      const page = parseInt(parts[2], 10) || 1;
      await renderContentHubCategoryList(chatId, catId, page, messageId);
    } else if (data.startsWith("ch_cat:")) {
      const catId = data.substring("ch_cat:".length);
      await renderContentHubCategoryList(chatId, catId, 1, messageId);
    } else if (data === "ch_hub" || data === "screen:categories") {
      const keyboard = await getCategoryHubKeyboard();
      const text = `🌐 <b>콘텐츠 허브</b>\n\n원하시는 카테고리를 선택하세요. 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: keyboard,
      };
    } else if (data === "screen:vip" || data === "vip_group" || data === "vip") {
      await renderVipScreen(chatId, messageId, query.from);
    } else if (data === "screen:vip_status" || data === "vip_status") {
      await renderVipStatusScreen(chatId, messageId, query.from);
    } else if (data === "vip_request_access") {
      const res = await vipAccessManager.requestVipAccess(query.from, bot);
      if (res.alreadyApproved) {
        await renderVipScreen(chatId, messageId, query.from);
      } else {
        const pendingText =
          `⏳ <b>VIP 접근 승인 대기 중입니다.</b>\n\n` +
          `관리자 확인 후 이용할 수 있습니다.`;
        const pendingKeyboard = getVipPendingKeyboard();
        const opts = {
          parse_mode: "HTML",
          reply_markup: pendingKeyboard
        };
        if (messageId) {
          await editMessageTextSafe(chatId, messageId, pendingText, opts);
        } else {
          await sendMessageSafe(chatId, pendingText, opts);
        }
      }
    } else if (data === "vip_admin:approve_all") {
      if (!vipAccessManager.isAuthorizedAdmin(query.from)) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "⛔ 관리자 권한이 없습니다.", show_alert: true });
        } catch (e) {}
        return;
      }
      const bulkRes = vipAccessManager.approveAllPending(query.from);
      try {
        await bot.answerCallbackQuery(query.id, { text: `${bulkRes.count}명 일괄 승인 완료!` });
      } catch (e) {}

      // Notify approved users
      for (const targetId of bulkRes.approvedIds) {
        try {
          await bot.sendMessage(targetId,
            `✅ <b>VIP 접근 승인 완료</b>\n\n` +
            `VIP 그룹에 입장할 수 있습니다. 아래 버튼을 눌러 입장하세요. 👇`,
            {
              parse_mode: "HTML",
              reply_markup: getVipApprovedKeyboard()
            }
          );
          console.log(`✅ [VIP_ACCESS] Sent bulk approval notification to user ${targetId}`);
        } catch (notifyErr) {
          console.error(`❌ [VIP_ACCESS] Failed to send bulk approval notification to user ${targetId}:`, notifyErr.message);
        }
      }

      const { text: panelText, keyboard: panelKeyboard } = vipAccessManager.formatAdminPanel("PENDING");
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, panelText, {
          parse_mode: "HTML",
          reply_markup: panelKeyboard
        });
      }
    } else if (data.startsWith("vip_admin:")) {
      const parts = data.split(":");
      const action = parts[1];
      const targetUserId = parts[2];
      if (!vipAccessManager.isAuthorizedAdmin(query.from)) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "⛔ 관리자 권한이 없습니다.", show_alert: true });
        } catch (e) {}
        return;
      }
      const result = vipAccessManager.processAdminDecision(query.from, targetUserId, action);
      const targetRecord = result.record;
      const applicantName = targetRecord ? escapeHTML(targetRecord.displayName) : targetUserId;
      const applicantUsername = targetRecord && targetRecord.username ? escapeHTML(targetRecord.username) : "없음";

      try {
        await bot.answerCallbackQuery(query.id, {
          text: `처리 완료: ${result.newStatus === "APPROVED" ? "승인 완료" : "거절 완료"}`
        });
      } catch (e) {}

      const isFromPanel = query.message && query.message.text && query.message.text.includes("VIP 관리자 패널");
      if (isFromPanel) {
        const { text: panelText, keyboard: panelKeyboard } = vipAccessManager.formatAdminPanel("PENDING");
        if (messageId) {
          await editMessageTextSafe(chatId, messageId, panelText, {
            parse_mode: "HTML",
            reply_markup: panelKeyboard
          });
        }
      } else {
        const adminResultText =
          `🔔 <b>[VIP 접근 요청 처리 완료]</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `👤 <b>이름:</b> ${applicantName}\n` +
          `🏷️ <b>Username:</b> ${applicantUsername}\n` +
          `🆔 <b>Telegram ID:</b> <code>${targetUserId}</code>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `결과: <b>${action === "approve" ? "✅ 승인 완료" : "❌ 거절 완료"}</b>\n` +
          `처리 관리자: <b>${result.adminName || "@ooalw"}</b>`;

        if (messageId) {
          await editMessageTextSafe(chatId, messageId, adminResultText, { parse_mode: "HTML" });
        }
      }

      if (result.newStatus === "APPROVED") {
        try {
          await bot.sendMessage(targetUserId,
            `✅ <b>VIP 접근 승인 완료</b>\n\n` +
            `VIP 그룹에 입장할 수 있습니다. 아래 버튼을 눌러 입장하세요. 👇`,
            {
              parse_mode: "HTML",
              reply_markup: getVipApprovedKeyboard()
            }
          );
          console.log(`✅ [VIP_ACCESS] Sent approval notification to user ${targetUserId}`);
        } catch (notifyErr) {
          console.error(`❌ [VIP_ACCESS] Failed to send approval notification to user ${targetUserId}:`, notifyErr.message);
        }
      } else if (result.newStatus === "REJECTED") {
        try {
          await bot.sendMessage(targetUserId,
            `❌ <b>VIP 접근 요청이 거절되었습니다.</b>\n\n` +
            `자세한 문의는 관리자(@ooalw)에게 연락해주세요.`,
            {
              parse_mode: "HTML",
              reply_markup: getVipRejectedKeyboard()
            }
          );
          console.log(`ℹ️ [VIP_ACCESS] Sent rejection notification to user ${targetUserId}`);
        } catch (notifyErr) {
          console.error(`❌ [VIP_ACCESS] Failed to send rejection notification to user ${targetUserId}:`, notifyErr.message);
        }
      }
    } else if (data.startsWith("admin_view:")) {
      if (!vipAccessManager.isAuthorizedAdmin(query.from)) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "⛔ 관리자 권한이 없습니다.", show_alert: true });
        } catch (e) {}
        return;
      }
      const statusFilter = data.split(":")[1] || "APPROVED";
      const { text: panelText, keyboard: panelKeyboard } = vipAccessManager.formatAdminPanel(statusFilter);
      try {
        await bot.answerCallbackQuery(query.id);
      } catch (e) {}
      const panelOpts = {
        parse_mode: "HTML",
        reply_markup: panelKeyboard
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, panelText, panelOpts);
      } else {
        await sendMessageSafe(chatId, panelText, panelOpts);
      }
    } else if (data === "admin_daily_report") {
      const isAuth = vipAccessManager.isAuthorizedAdmin(query.from) ||
        (query.from && String(query.from.id) === "8781836301") ||
        (query.from && String(query.from.id) === String(process.env.ADMIN_USER_ID));
      if (!isAuth) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "⛔ 관리자 권한이 없습니다.", show_alert: true });
        } catch (e) {}
        return;
      }
      try {
        await bot.answerCallbackQuery(query.id, { text: "📊 24시간 보고서 생성 중..." });
      } catch (e) {}
      const report = dailyAdminReporter.generateReport(24);
      await sendMessageSafe(chatId, report.htmlText, { parse_mode: "HTML" });
    } else if (data.startsWith("cat_page:")) {
      const parts = data.split(":");
      const catKey = parts[1];
      const page = parseInt(parts[2], 10) || 1;
      await renderCategoryResources(chatId, catKey, page, messageId);
    } else if (data.startsWith("cat:")) {
      const parts = data.split(":");
      const catKey = parts[1];
      await renderCategoryResources(chatId, catKey, 1, messageId);
    } else if (data.startsWith("topic_page:")) {
      const parts = data.split(":");
      const topicKey = parts[1];
      const page = parseInt(parts[2], 10);
      await renderTopicPosts(chatId, topicKey, page, messageId);
    } else if (data.startsWith("topic:")) {
      const parts = data.split(":");
      const topicKey = parts[1];
      const page = parseInt(parts[2] || "1", 10);
      await renderTopicPosts(chatId, topicKey, page, messageId);
    } else if (data.startsWith("news_art:")) {
      const newsIdx = parseInt(data.split(":")[1], 10) || 0;
      await renderNewsArticlePage(chatId, newsIdx, messageId);
    } else if (data === "refresh_rankings") {
      try {
        await rankingScraper.scrapeRealtimeRankings();
      } catch (e) {
        console.error("Refresh rankings error:", e.message);
      }
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>실시간 검색어 상위 10 & 핫 토픽</b>\n\n실시간 이슈 키워드와 인기 주제를 탐색하세요 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "screen:breaking") {
      const keyboard = await getBreakingNewsKeyboard();
      const text = `📰 <b>속보</b>\n\n최신 속보 뉴스를 빠르게 확인하세요. 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: keyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "refresh_trending") {
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>핫 토픽</b>\n\n탐색할 주제를 선택하세요 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "menu") {
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>핫 토픽</b>\n\n탐색할 주제를 선택하세요 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "confirm_clear_history") {
        if (query.message && query.message.message_id) {
          trackMessage(chatId, query.message.message_id);
        }
        clearUserSearchHistory(chatId);
        await clearUserHistory(chatId);

        const combinedKeyboard = await getTrendingKeyboard();
        await sendMessageSafe(chatId,
          `🔥 <b>핫 토픽</b>\n\n탐색할 주제를 선택하세요 👇`,
          {
            parse_mode: "HTML",
            reply_markup: combinedKeyboard,
          }
        );
        await sendMessageSafe(chatId,
          `✨ <b>새로운 세션이 시작되었습니다!</b>`,
          {
            parse_mode: "HTML",
            reply_markup: getPersistentNavigationKeyboard()
          }
        );
      } else if (data === "cancel_clear_history") {
        if (query.message && query.message.message_id) {
          try {
            await bot.deleteMessage(chatId, query.message.message_id);
          } catch (e) {}
        }
        await sendMessageSafe(chatId,
          `❌ 기록 삭제가 취소되었습니다.`,
          {
            parse_mode: "HTML",
            reply_markup: getPersistentNavigationKeyboard()
          }
        );
      }
  } catch (err) {
    console.error("❌ Error handling callback_query:", err.message);
  }
});

// ============================
// 💬 MESSAGES & NAVIGATION KEYBOARD
// ============================
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    if (msg.from) {
      vipAccessManager.registerAdminIfMatched(msg.from);
      console.log(`💬 [MESSAGE] text="${text}", from=${msg.from.id} (@${msg.from.username || "no_user"})`);
    }

    // ==========================================
    // 👑 VIP SUPERGROUP TOPIC MESSAGE AUTO-RESPONDER
    // ==========================================
    if (String(chatId) === "-1003983458986" || (msg.chat && msg.chat.type === "supergroup" && String(chatId).includes("3983458986"))) {
      const threadId = msg.message_thread_id || null;
      console.log(`👑 [VIP_GROUP_MSG] text="${text}", threadId=${threadId}, from=${msg.from ? msg.from.id : 'unknown'}`);
      
      const { VipTopicRouter, TOPIC_THREAD_IDS } = require("./video_pipeline/vip_topic_router");
      const vipRouter = new VipTopicRouter();
      
      let category = null;
      const cleanText = (text || "").toLowerCase().trim();

      // Explicit category mapping command: /map <category> or /set <category> or /topic <category>
      if (cleanText.startsWith("/map ") || cleanText.startsWith("/set ") || cleanText.startsWith("/topic ") || cleanText.startsWith("!map ") || cleanText.startsWith("!set ")) {
        const targetCat = cleanText.split(" ")[1]?.toUpperCase();
        if (["BJ", "KR", "JP", "CN", "18", "AV", "ALL"].includes(targetCat)) {
          if (threadId && targetCat !== "ALL") {
            vipRouter.registerThreadMapping(threadId, targetCat);
          }
          category = targetCat;
        }
      }

      // Explicit category shortcuts
      if (!category) {
        if (cleanText === "bj" || cleanText === "/bj" || cleanText === "!bj" || cleanText === "bj." || cleanText.includes("토끼") || cleanText.startsWith("bj ")) category = "BJ";
        else if (cleanText === "kr" || cleanText === "/kr" || cleanText === "!kr" || cleanText.includes("로맨틱") || cleanText.startsWith("kr ")) category = "KR";
        else if (cleanText === "jp" || cleanText === "/jp" || cleanText === "!jp" || cleanText.includes("모사") || cleanText.includes("vsdxda") || cleanText.startsWith("jp ")) category = "JP";
        else if (cleanText === "cn" || cleanText === "/cn" || cleanText === "!cn" || cleanText.includes("가랑이") || cleanText.includes("ccdjxc") || cleanText.startsWith("cn ")) category = "CN";
        else if (cleanText === "18" || cleanText === "18.." || cleanText === "/18" || cleanText === "..." || cleanText.includes("첩") || cleanText.startsWith("18 ")) category = "18";
        else if (cleanText === "av" || cleanText === "/av" || cleanText === "!av" || cleanText.includes("사키") || cleanText.startsWith("av ")) category = "AV";
        else if (cleanText === "all" || cleanText === "/all" || cleanText === "!all" || cleanText === "전체") category = "ALL";
      }

      // Inspect Telegram topic name in service messages or replies
      if (!category && msg.reply_to_message) {
        const topicName = (
          (msg.reply_to_message.forum_topic_created && msg.reply_to_message.forum_topic_created.name) ||
          (msg.reply_to_message.forum_topic_edited && msg.reply_to_message.forum_topic_edited.name) ||
          ""
        ).toUpperCase();
        if (topicName.includes("JP") || topicName.includes("모사") || topicName.includes("VSDXDA")) category = "JP";
        else if (topicName.includes("CN") || topicName.includes("가랑이") || topicName.includes("CCDJXC")) category = "CN";
        else if (topicName.includes("BJ") || topicName.includes("토끼") || topicName.includes("TFCCDET")) category = "BJ";
        else if (topicName.includes("KR") || topicName.includes("로맨틱") || topicName.includes("CCSFVK")) category = "KR";
        else if (topicName.includes("18") || topicName.includes("첩") || topicName.includes("DDKICR")) category = "18";
        else if (topicName.includes("AV") || topicName.includes("사키") || topicName.includes("CCCDDGHHGF")) category = "AV";
      }

      if (!category && (msg.forum_topic_created || msg.forum_topic_edited)) {
        const topicName = ((msg.forum_topic_created && msg.forum_topic_created.name) || (msg.forum_topic_edited && msg.forum_topic_edited.name) || "").toUpperCase();
        if (topicName.includes("JP")) category = "JP";
        else if (topicName.includes("CN")) category = "CN";
        else if (topicName.includes("BJ")) category = "BJ";
        else if (topicName.includes("KR")) category = "KR";
        else if (topicName.includes("18")) category = "18";
        else if (topicName.includes("AV")) category = "AV";
      }

      // Persistent dynamic thread lookup
      if (!category && threadId) {
        category = vipRouter.getCategoryForThread(threadId);
      }

      // Static fallback thread mapping
      if (!category && threadId) {
        if (threadId === TOPIC_THREAD_IDS.BJ || threadId === 23) category = "BJ";
        else if (threadId === TOPIC_THREAD_IDS.KR || threadId === 20) category = "KR";
        else if (threadId === TOPIC_THREAD_IDS.JP || threadId === 14) category = "JP";
        else if (threadId === TOPIC_THREAD_IDS.CN || threadId === 17) category = "CN";
        else if (threadId === TOPIC_THREAD_IDS['18'] || threadId === 8) category = "18";
        else if (threadId === TOPIC_THREAD_IDS.AV || threadId === 12) category = "AV";
      }

      // Auto-save learned mapping
      if (category && category !== "ALL" && threadId) {
        vipRouter.registerThreadMapping(threadId, category);
      }

      let cardText, cardKeyboard;
      if (category) {
        const card = vipRouter.formatCategoryCard(category, 1);
        cardText = card.text;
        cardKeyboard = card.keyboard;
      } else if (threadId) {
        // Unknown topic thread - ask user to select topic category once
        const chooser = vipRouter.formatTopicChooser(threadId);
        cardText = chooser.text;
        cardKeyboard = chooser.keyboard;
      } else {
        // Main group chat without thread
        const card = vipRouter.formatCategoryCard("ALL", 1);
        cardText = card.text;
        cardKeyboard = card.keyboard;
      }

      const sendPayload = {
        parse_mode: "HTML",
        reply_markup: cardKeyboard,
        disable_web_page_preview: true
      };
      if (threadId) {
        sendPayload.message_thread_id = threadId;
      }
      
      return await bot.sendMessage(chatId, cardText, sendPayload).catch(e => console.warn("VIP group send error:", e.message));
    }

    if (text === "/admin" || text === "/vip_admin" || text === "/register_admin" || text === "/vip_list" || text === "/list") {
      if (msg.from && vipAccessManager.isAuthorizedAdmin(msg.from)) {
        vipAccessManager.registerAdminIfMatched(msg.from);
        const { text: panelText, keyboard: panelKeyboard } = vipAccessManager.formatAdminPanel("APPROVED");
        return await sendMessageSafe(chatId, panelText, {
          parse_mode: "HTML",
          reply_markup: panelKeyboard
        });
      } else {
        console.warn(`⚠️ [UNAUTHORIZED_ADMIN_ATTEMPT] User ID: ${msg.from ? msg.from.id : "none"}, Username: @${msg.from ? msg.from.username : "none"}`);
        return await sendMessageSafe(chatId, `⛔ <b>관리자 권한이 없습니다.</b> (Username: @${msg.from ? msg.from.username : "none"}, ID: <code>${msg.from ? msg.from.id : ""}</code>)`, { parse_mode: "HTML" });
      }
    }

    if (text === "/waiting" || text === "/pending" || text === "/wait" || text === "/승인대기" || text === "/대기") {
      if (msg.from && vipAccessManager.isAuthorizedAdmin(msg.from)) {
        vipAccessManager.registerAdminIfMatched(msg.from);
        const { text: panelText, keyboard: panelKeyboard } = vipAccessManager.formatAdminPanel("PENDING");
        return await sendMessageSafe(chatId, panelText, {
          parse_mode: "HTML",
          reply_markup: panelKeyboard
        });
      } else {
        return await sendMessageSafe(chatId, `⛔ <b>관리자 권한이 없습니다.</b> (Username: @${msg.from ? msg.from.username : "none"}, ID: <code>${msg.from ? msg.from.id : ""}</code>)`, { parse_mode: "HTML" });
      }
    }

    if (text === "/report" || text === "/daily_report" || text === "/pipeline_stats" || text === "/stats" || text === "/pipeline" || text === "/보고서" || text === "/일일보고서") {
      const isAuth = (msg.from && vipAccessManager.isAuthorizedAdmin(msg.from)) ||
        (msg.from && String(msg.from.id) === "8781836301") ||
        (msg.from && String(msg.from.id) === String(process.env.ADMIN_USER_ID)) ||
        (msg.from && String(msg.from.id) === String(process.env.TELEGRAM_ADMIN_ID));

      if (isAuth) {
        if (msg.from) vipAccessManager.registerAdminIfMatched(msg.from);
        const report = dailyAdminReporter.generateReport(24);
        return await sendMessageSafe(chatId, report.htmlText, { parse_mode: "HTML" });
      } else {
        return await sendMessageSafe(chatId, `⛔ <b>관리자 권한이 없습니다.</b> (Username: @${msg.from ? msg.from.username : "none"}, ID: <code>${msg.from ? msg.from.id : ""}</code>)`, { parse_mode: "HTML" });
      }
    }

    if (text.startsWith("/inspect_videos")) {
      const adminIdStr = String(process.env.ADMIN_USER_ID || process.env.TELEGRAM_ADMIN_ID || "").trim();
      const senderIdStr = String(msg.from ? msg.from.id : (msg.chat ? msg.chat.id : "")).trim();

      if (!adminIdStr || !senderIdStr || senderIdStr !== adminIdStr) {
        return await sendMessageSafe(chatId, "⛔ Unauthorized access.");
      }

      const allPosts = sourceRegistry.getPostsForKeyword("Dating", false) || [];
      const videoPosts = sourceRegistry.getPostsForKeyword("Dating", true) || [];

      const totalPosts = allPosts.length;
      const totalVideos = videoPosts.length;
      const totalPhotos = allPosts.filter(p => p.media_type === "photo").length;
      const totalText = allPosts.filter(p => p.media_type === "text" && !p.duration && !p.video_file_id).length;
      const totalDocs = allPosts.filter(p => p.media_type === "file").length;

      const first60VideoIds = videoPosts.slice(0, 60).map(p => p.message_id);

      const p1 = videoPosts.slice(0, 10);
      const p2 = videoPosts.slice(10, 20);
      const p3 = videoPosts.slice(20, 30);
      const p4 = videoPosts.slice(30, 40);
      const p5 = videoPosts.slice(40, 50);

      const all50Ids = videoPosts.slice(0, 50).map(p => p.message_id);
      const unique50Ids = new Set(all50Ids);
      const dups = all50Ids.length - unique50Ids.size;

      const wrongChannelCount = videoPosts.slice(0, 50).filter(p => p.channel_username && p.channel_username.toLowerCase() !== "cccsefk" && p.keyword !== "Dating").length;
      const syntheticTitles = videoPosts.slice(0, 50).filter(p => p.title && (p.title.includes("Update") || p.title.includes("Post #")) && !p.title.includes("제목 없음"));

      // Chunk 1: Overview Summary
      const summaryMsg =
        `📊 <b>PRODUCTION VIDEO INGESTION AUDIT SUMMARY</b>\n` +
        `Target: <b>@cccsefk (Dating)</b>\n\n` +
        `1. Total Stored Posts: <b>${totalPosts}</b>\n` +
        `2. Total Real Videos (media_type === "video"): <b>${totalVideos}</b>\n` +
        `3. Total Photos: <b>${totalPhotos}</b>\n` +
        `4. Total Text-Only Posts: <b>${totalText}</b>\n` +
        `5. Total Non-Video Documents: <b>${totalDocs}</b>\n\n` +
        `6. First 60 Real Video Message IDs:\n` +
        `<code>${first60VideoIds.join(", ") || "None"}</code>\n\n` +
        `7. Audit Checks:\n` +
        `• Duplicates Count (0..49): <b>${dups}</b> (Must be 0)\n` +
        `• Wrong Channel Leaks: <b>${wrongChannelCount}</b> (Must be 0)\n` +
        `• Synthetic Title Leaks: <b>${syntheticTitles.length}</b> (Must be 0)`;

      await sendMessageSafe(chatId, summaryMsg, { parse_mode: "HTML" });

      // Chunk 2: Pages 1 & 2 Breakdown
      const chunk2Msg =
        `📑 <b>PAGES 1 & 2 BREAKDOWN (Indexes 0..19)</b>\n\n` +
        `<b>Page 1 (0..9) Message IDs:</b>\n<code>${p1.map(p => p.message_id).join(", ") || "None"}</code>\n\n` +
        `<b>Page 2 (10..19) Message IDs:</b>\n<code>${p2.map(p => p.message_id).join(", ") || "None"}</code>\n\n` +
        `<b>Page 1 Details:</b>\n` + (p1.map((p, idx) => `• #${idx + 1} | MsgID: ${p.message_id} | ${escapeHTML(p.title)} | ${p.duration || "N/A"}`).join("\n") || "None") +
        `\n\n<b>Page 2 Details:</b>\n` + (p2.map((p, idx) => `• #${idx + 11} | MsgID: ${p.message_id} | ${escapeHTML(p.title)} | ${p.duration || "N/A"}`).join("\n") || "None");

      await sendMessageSafe(chatId, chunk2Msg, { parse_mode: "HTML" });

      // Chunk 3: Pages 3, 4 & 5 Breakdown
      const chunk3Msg =
        `📑 <b>PAGES 3, 4 & 5 BREAKDOWN (Indexes 20..49)</b>\n\n` +
        `<b>Page 3 (20..29) Message IDs:</b>\n<code>${p3.map(p => p.message_id).join(", ") || "None"}</code>\n\n` +
        `<b>Page 4 (30..39) Message IDs:</b>\n<code>${p4.map(p => p.message_id).join(", ") || "None"}</code>\n\n` +
        `<b>Page 5 (40..49) Message IDs:</b>\n<code>${p5.map(p => p.message_id).join(", ") || "None"}</code>\n\n` +
        `<b>Page 3 Details:</b>\n` + (p3.map((p, idx) => `• #${idx + 21} | MsgID: ${p.message_id} | ${escapeHTML(p.title)} | ${p.duration || "N/A"}`).join("\n") || "None") +
        `\n\n<b>Page 4 Details:</b>\n` + (p4.map((p, idx) => `• #${idx + 31} | MsgID: ${p.message_id} | ${escapeHTML(p.title)} | ${p.duration || "N/A"}`).join("\n") || "None") +
        `\n\n<b>Page 5 Details:</b>\n` + (p5.map((p, idx) => `• #${idx + 41} | MsgID: ${p.message_id} | ${escapeHTML(p.title)} | ${p.duration || "N/A"}`).join("\n") || "None");

      await sendMessageSafe(chatId, chunk3Msg, { parse_mode: "HTML" });
      return;
    }

    if (text === "🏠 Home" || text === "🏠 홈") {
      const combinedKeyboard = await getTrendingKeyboard();

      await sendMessageSafe(chatId,
        `🔥 <b>핫 토픽</b>\n\n탐색할 주제를 선택하세요 👇`,
        {
          parse_mode: "HTML",
          reply_markup: combinedKeyboard,
        }
      );
      return;
    }

    if (text === "🔒 VIP 접근 상태 확인" || text === "VIP 접근 상태 확인") {
      await renderVipStatusScreen(chatId, null, msg.from);
      return;
    }

    if (text === "ℹ️ About" || text === "ℹ️ 정보") {
      await renderVipStatusScreen(chatId, null, msg.from);
      return;
    }

    if (text === "🗑️ History" || text === "🗑️ Clear History" || text === "🗑️ 기록") {
      const confirmText =
        `⚠️ <b>대화 기록을 삭제하시겠습니까?</b>\n\n` +
        `최근 NexaHub 메시지를 삭제하고 새 세션을 시작합니다.\n\n` +
        `진행하시겠습니까?`;

      await sendMessageSafe(chatId, confirmText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ 예, 삭제합니다", callback_data: "confirm_clear_history" },
              { text: "❌ 취소", callback_data: "cancel_clear_history" }
            ]
          ]
        }
      });
      return;
    }

    if (text === "/vip" || text === "VIP 그룹입장" || text === "vip" || text === "VIP" || text === "🔐 VIP 그룹입장") {
      await renderVipScreen(chatId, null, msg.from);
      return;
    }

    if (text === "📁 콘텐츠 허브" || text === "📂 콘텐츠 허브" || text === "콘텐츠 허브" || text === "🌐 콘텐츠 허브") {
      const keyboard = await getCategoryHubKeyboard();
      const hubText = `🌐 <b>콘텐츠 허브</b>\n\n원하시는 카테고리를 선택하세요. 👇`;
      await sendMessageSafe(chatId, hubText, {
        parse_mode: "HTML",
        reply_markup: keyboard
      });
      return;
    }

    if (text.startsWith("/")) return;

    await renderSearchResults(chatId, text);
  } catch (err) {
    console.error("❌ Error handling message:", err.message);
  }
});

// ============================
// 🚀 SINGLE-PROCESS INIT
// ============================
if (isMainModule) {
  startScraperScheduler();
  rankingScraper.startRankingScheduler();
  startPipelineScheduler();
  contentHubScraper.startContentHubScheduler();

  // 📡 Isolated External Source Pipeline Scheduler
  try {
    getPipelineInstance().startScheduler();
  } catch (extErr) {
    console.error("[EXTERNAL_SOURCE] scheduler startup failed:", extErr.message);
  }

  // 🎬 Legacy Video Pipeline Runtime (Disabled in favor of Unified 10-Channel Scraper Pipeline)
  if (process.env.LEGACY_VIDEO_PIPELINE_ENABLED === 'true') {
    try {
      const { getVideoPipelineRuntime } = require("./video_pipeline/video_pipeline_runtime");
      const videoRuntime = getVideoPipelineRuntime({ telegramClient: bot });
      videoRuntime.start();
    } catch (videoErr) {
      console.error("❌ [LEGACY_VIDEO_PIPELINE] Runtime startup failed:", videoErr.message);
    }
  }

  // 🚀 Unified 10-Channel Scraper Pipeline (10 Channels, 5 vids/day, 2 parallel download workers)
  try {
    if (process.env.MODULAR_PIPELINE_ENABLED !== 'false') {
      const { getModularPipelineInstance } = require("./video_pipeline/modular_scraper_pipeline");
      const modularPipeline = getModularPipelineInstance({
        telegramClient: bot,
        workers: Number(process.env.MODULAR_PIPELINE_WORKERS) || 2,
        dailyQuota: Number(process.env.MODULAR_PIPELINE_DAILY_QUOTA) || 5
      });
      const intervalMs = Number(process.env.MODULAR_PIPELINE_INTERVAL_MS) || (2 * 60 * 60 * 1000);
      modularPipeline.startScheduler(intervalMs);
      console.log("✅ [MODULAR_PIPELINE] Unified 10-Channel Pipeline active (every 2h, 5 videos/day per channel, 50 total/day, 2 parallel download workers).");
    }
  } catch (modErr) {
    console.error("❌ [MODULAR_PIPELINE] Startup failed:", modErr.message);
  }

  // 📊 Daily Admin Reporter (24-Hour Automated Report to @ooalw / @CSE_006)
  try {
    dailyAdminReporter.startDailyReportScheduler(bot, 24 * 60 * 60 * 1000);
  } catch (repErr) {
    console.error("❌ [DAILY_REPORTER] Scheduler startup failed:", repErr.message);
  }

  console.log("✅ NewsSearch Main Bot is running...");
  console.log("🔗 Channels shown directly in main bot!");
}

module.exports = {
  renderSearchResults,
  renderTopicPosts,
  renderItemDetailPage,
  renderContentHubCategoryList,
  renderContentHubItemDetail,
  renderCategoryResources,
  contentHubScraper,
  get CONTENT_HUB_DATASET() {
    return contentHubScraper.getDataset();
  },
  getContentHubCategories,
  getContentHubCategoryById,
  getContentHubItemById,
  getContentHubCategoryKeyboard,
  getContentHubCategoryListText,
  getContentHubItemDetailKeyboard,
  getContentHubItemDetailText,
  sendVideoSafe,
  sendPhotoSafe,
  sendMessageSafe,
  editMessageTextSafe,
  CHANNELS,
  CATEGORIES,
  truncateUTF8,
  makeSearchCallbackData,
  escapeHTML,
  translateText,
  getMainKeyboard,
  getTrendingKeyboard,
  getBreakingNewsKeyboard,
  getCategoryHubKeyboard,
  getVipCardText,
  getVipCardKeyboard,
  getVipInstructionText,
  getVipInstructionKeyboard,
  getVipApprovedText,
  getVipApprovedKeyboard,
  getVipPendingText,
  getVipPendingKeyboard,
  getVipRejectedText,
  getVipRejectedKeyboard,
  getVipLockedText,
  getVipLockedKeyboard,
  renderVipScreen,
  renderVipStatusScreen,
  vipAccessManager,
  getPersistentKeyboard,
  getPersistentNavigationKeyboard,
  clearUserHistory,
  videoFileIdCache,
  saveVideoCache,
  getCachedFileId,
  acquireUserLock,
  releaseUserLock,
};

