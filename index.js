try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const https = require("https");
const { startScraperScheduler } = require("./scraper");
const rankingScraper = require("./ranking_scraper");
const sourceRegistry = require("./source_registry");




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

console.log(`🤖 [PID:${APP_PID}] [Host:${APP_HOST}] Main module initialized. isMainModule=${isMainModule}`);

const bot = new TelegramBot(TOKEN, {
  polling: isMainModule ? {
    params: {
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"]
    }
  } : false
});



bot.on("polling_error", (error) => {
  const errMsg = String(error.message || error);
  const errCode = error.code || "";
  console.error(`⚠️ [PID:${APP_PID}] Telegram Bot Polling Error: ${errCode} - ${errMsg}`);
});

let isShuttingDown = false;

// Process signal listeners for Railway container rolling updates
async function handleProcessExit(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`🛑 [PID:${APP_PID}] Received ${signal}. Closing bot polling connection...`);
  try {
    if (bot.isPolling()) {
      await bot.stopPolling();
      console.log(`✅ [PID:${APP_PID}] Bot polling stopped cleanly for ${signal}.`);
    }
  } catch (err) {
    console.error(`⚠️ [PID:${APP_PID}] Error stopping polling on ${signal}:`, err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => handleProcessExit("SIGTERM"));
process.on("SIGINT", () => handleProcessExit("SIGINT"));

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
    });

    if (translated && translated !== text) {
      translationCache.set(cacheKey, translated);
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
    });

    if (fallbackTranslated && fallbackTranslated !== text && !fallbackTranslated.includes("MYMEMORY WARNING") && !fallbackTranslated.includes("INVALID") && !fallbackTranslated.includes("QUOTA")) {
      translationCache.set(cacheKey, fallbackTranslated);
      return fallbackTranslated;
    }
  } catch (err) {
    // Fall through to safety
  }

  // Tier 3: Return original text safely
  translationCache.set(cacheKey, text);
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
const VIDEO_CACHE_FILE = "video_cache.json";
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
    fs.writeFileSync(VIDEO_CACHE_FILE, JSON.stringify(videoFileIdCache, null, 2), "utf8");
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
        { text: "ℹ️ 정보" },
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

  console.error(`❌ [TELEGRAM API ERROR] Func:${funcName} | ChatID:${chatId} | Code:${errCode} | Error:${errDesc}`);

  if (options && options.reply_markup && Array.isArray(options.reply_markup.inline_keyboard)) {
    console.error(`📋 [KEYBOARD AUDIT] Rows:${options.reply_markup.inline_keyboard.length}`);
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
  if (fs.existsSync("featured_dataset.json")) {
    FEATURED_DATASET = JSON.parse(fs.readFileSync("featured_dataset.json", "utf8"));
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
  const itemsPerPage = 10;
  const maxTotalPages = isTopicView ? 2 : 3;
  const maxItemsCap = isTopicView ? 20 : 30;

  const maxUiItems = (items || []).slice(0, maxItemsCap);
  const totalPages = Math.min(maxTotalPages, Math.ceil(maxUiItems.length / itemsPerPage));
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = maxUiItems.slice(startIndex, startIndex + itemsPerPage);

  const itemLines = [];

  pageItems.forEach((p, index) => {
    const itemNumber = startIndex + index + 1;
    let displayTitle = String(p.title || p.name || "").trim();
    if (!displayTitle) {
      displayTitle = "텔레그램 리소스";
    }

    let icon = "";
    if (displayTitle.includes("▶") || displayTitle.includes("🎬") || displayTitle.includes("🖼️") || displayTitle.includes("📄") || displayTitle.includes("📹") || displayTitle.includes("🔘")) {
      icon = "";
    } else if (p.url && p.url.includes("img")) {
      icon = "🖼️ ";
    } else if (displayTitle.startsWith("[")) {
      icon = "▶️ ";
    } else {
      icon = "🎬 ";
    }

    const fullTitle = `${icon}${displayTitle}`.trim();
    const escapedTitle = escapeHTML(fullTitle);

    let itemUrl = p.telegram_url || p.url;
    if (isTopicView) {
      const vidId = p.id || p.unique_hash;
      if (vidId) {
        itemUrl = `https://t.me/santhosh_learning_2026_bot?start=video_${vidId}`;
      } else {
        const cleanPrefix = encodeURIComponent(callbackPrefix);
        const itemIdx = startIndex + index;
        itemUrl = `https://t.me/santhosh_learning_2026_bot?start=det~${cleanPrefix}~${itemIdx}~${currentPage}`;
      }
    } else if (!itemUrl) {
      const src = sourceRegistry.getSourceByKeyword(p.keyword || p.channel_name);
      if (src && src.username) {
        itemUrl = `https://t.me/${src.username}/${p.message_id || ""}`;
      } else if (p.username) {
        itemUrl = `https://t.me/${p.username}/${p.message_id || ""}`;
      } else if (src && src.invite_url) {
        itemUrl = src.invite_url;
      } else if (p.invite_url) {
        itemUrl = p.invite_url;
      } else if (p.chat_id && p.message_id) {
        let cleanChatId = String(p.chat_id).startsWith("-100") ? String(p.chat_id).substring(4) : String(p.chat_id).replace("-", "");
        itemUrl = `https://t.me/c/${cleanChatId}/${p.message_id}`;
      }
    }
    const safeUrl = escapeHTML(itemUrl);

    itemLines.push(`${itemNumber}. <a href="${safeUrl}">${escapedTitle}</a>`);
  });

  let messageText = `📺 <b>${escapeHTML(title)}</b>\n\n`;
  messageText += `이 채널의 최신 동영상 목록입니다.\n\n`;
  messageText += itemLines.join("\n\n");
  if (totalPages > 1) {
    messageText += `\n\n<b>페이지 ${currentPage}/${totalPages}</b>`;
  }

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: "⬅️ 이전", callback_data: `${callbackPrefix}:${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: "다음 ➡️", callback_data: `${callbackPrefix}:${currentPage + 1}` });
  }

  const inline_keyboard = [];
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
    items = sourceRegistry.getPostsForKeyword(topicKey);
    title = TOPIC_NAMES[topicKey] || topicKey;
  }

  const item = items[itemIndex];
  if (!item) {
    return await sendMessageSafe(chatId, "⚠️ 항목 상세 정보를 찾을 수 없습니다.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 홈", callback_data: "menu" }]] }
    });
  }

  let displayTitle = String(item.title || item.name || "텔레그램 콘텐츠").trim();

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
    [{ text: "🔗 그룹 가입", url: groupUrl }],
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

  // If file_id is missing, attempt MTProto media resolution
  if (!cachedFileId && process.env.TELEGRAM_SESSION_STRING && (item.chat_id || item.username) && item.message_id) {
    try {
      const MTProtoChannelReader = require("./mtproto_reader");
      const reader = new MTProtoChannelReader();
      const resolved = await reader.resolveMediaForPost(item);
      if (resolved && resolved.file_id) {
        cachedFileId = resolved.file_id;
        saveVideoCache(item.id || item.unique_hash, cachedFileId);
      }
    } catch (err) {
      console.warn("⚠️ MTProto media resolution fallback warning:", err.message);
    }
  }

  // If file_id or direct media is available, send actual video/photo via sendVideoSafe / sendPhotoSafe
  if (cachedFileId) {
    if (item.media_type === "photo") {
      return await sendPhotoSafe(chatId, cachedFileId, {
        caption: detailText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
    } else {
      return await sendVideoSafe(chatId, cachedFileId, {
        caption: detailText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
    }
  }

  // For public video posts with direct post URL, attempt sendVideoSafe with postUrl
  if (item.media_type === "video" && postUrl) {
    try {
      const res = await sendVideoSafe(chatId, postUrl, {
        caption: detailText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
      if (res && res.video && res.video.file_id) {
        saveVideoCache(item.id || item.unique_hash, res.video.file_id);
      }
      if (res) return res;
    } catch (e) {}
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

async function renderCategoryResources(chatId, catKey, page = 1, messageId = null) {
  const category = CATEGORIES[catKey];
  if (!category) return;
  return await renderHyperlinkListPostView(chatId, category.title, category.items, page, `cat_page:${catKey}`, messageId);
}

async function renderTopicPosts(chatId, topicKey, page = 1, messageId = null) {
  const posts = sourceRegistry.getPostsForKeyword(topicKey);
  const displayTopicName = TOPIC_NAMES[topicKey] || topicKey;
  return await renderHyperlinkListPostView(chatId, displayTopicName, posts, page, `topic_page:${topicKey}`, messageId);
}

async function renderFeaturedChannelPosts(chatId, cardId, channelIndex, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const channels = getFeaturedChannels(cardId);
  const channel = channels[channelIndex];

  if (!channel || !channel.posts || channel.posts.length === 0) {
    const text = `📺 <b>Channel Not Found</b>\n\nNo posts available.`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "◀ Back to Channels", callback_data: `featured:${cardId}:1` }],
          [{ text: "🏠 Back to Main Menu", callback_data: "menu" }]
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
  const itemsPerPage = 10;
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
      navRow.push({ text: "◀ Previous", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  // Open Channel button if valid channelUrl exists
  if (channelUrl) {
    rows.push([{ text: `🔗 Open ${channel.name} Channel`, url: channelUrl }]);
  }

  rows.push([
    { text: "◀ Back to Channels", callback_data: `featured:${cardId}:1` },
    { text: "🏠 Back to Main Menu", callback_data: "menu" }
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
    if (fs.existsSync("trending.json")) {
      const data = JSON.parse(fs.readFileSync("trending.json", "utf8"));
      return data.keywords || [];
    }
  } catch (err) {
    console.error("Error reading trending.json:", err.message);
  }
  return [];
}

function getBreakingNews() {
  try {
    if (fs.existsSync("breaking.json")) {
      const data = JSON.parse(fs.readFileSync("breaking.json", "utf8"));
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

const CARD_1_TO_10_LABELS = [
  "🔥 K-Pop 열애설",
  "💋 비밀 연애",
  "👀 아이돌 열애 루머",
  "💔 연예인 결별",
  "🚨 열애 논란",
  "❤️ 비밀 커플",
  "😳 바이럴 로맨스",
  "🔥 럽스타그램",
  "💍 결혼 루머",
  "👀 연예계 스캔들"
];

const CARD_11_TO_20_LABELS = [
  "🎬 로맨스 VOD",
  "💖 연애 클립",
  "🌸 심쿵 로맨스",
  "🔥 바이럴 영상",
  "🚨 모자이크 이슈",
  "🐰 코스프레 데이트",
  "🍸 호스테스 이슈",
  "👑 후궁 이야기",
  "🌸 사키 미즈미",
  "🎨 뮤즈 컬렉션"
];

async function getMainKeyboard() {
  // 1. CARDS 1–10: Live Trending Keywords (VISUAL DISPLAY LABELS ONLY -> Direct Fixed Channel Callback)
  const card1to10Buttons = [];
  
  for (let i = 0; i < 10; i++) {
    const label = CARD_1_TO_10_LABELS[i];
    const channelKeyword = TARGET_CHANNELS[i] || "Dating";
    card1to10Buttons.push({
      text: label,
      callback_data: `topic:${channelKeyword}`
    });
  }

  // 2. CARDS 11–20: TRENDING VIDEOS (Korean Display Labels -> Direct Fixed Channel Callback)
  const card11to20Buttons = [];
  const usedVideoSignatures = new Set();
  const rawEnglishNames = ["romantic vibe", "dating", "romance", "crotch", "mosa", "bunny girl cosplay date", "lustful hostess", "concubine", "saki mizumi", "a muse", "jun ko"];

  for (let i = 0; i < 10; i++) {
    const channelKeyword = TARGET_CHANNELS[i] || "Dating";
    const channelPosts = sourceRegistry.getPostsForKeyword(channelKeyword);

    let selectedPost = null;
    for (const p of channelPosts) {
      if (!p || !p.title) continue;
      const cleanTitleSig = sanitizeUTF8(p.title)
        .replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s▶️🎬🖼️🔥⭐🎤👁️🖤⚽🎲💃👑📰🚨📈🌎🇰🇷🏙️💬🎵💻🤖💰❤️✨👀🌟🎯📱]+/gu, "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .trim().toLowerCase().substring(0, 35);

      if (!usedVideoSignatures.has(cleanTitleSig)) {
        selectedPost = p;
        usedVideoSignatures.add(cleanTitleSig);
        break;
      }
    }

    if (!selectedPost && channelPosts.length > 0) {
      selectedPost = channelPosts[0];
    }

    let textToFormat = channelKeyword;
    if (selectedPost && selectedPost.title) {
      textToFormat = selectedPost.title;
    }
    
    let label = await formatTrendingCardLabel(textToFormat, true, i, channelKeyword);
    const cleanLabelLower = label ? label.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s▶️🎬🖼️🔥⭐🎤👁️🖤⚽🎲💃👑📰🚨📈🌎🇰🇷🏙️💬🎵💻🤖💰❤️✨👀🌟🎯📱🎨🍸👑🐰💖]+/gu, "").trim().toLowerCase() : "";

    if (!label || !/[\uac00-\ud7af]/.test(label) || rawEnglishNames.some(name => cleanLabelLower.includes(name))) {
      label = CARD_11_TO_20_LABELS[i] || "🎬 트렌딩 동영상";
    }

    card11to20Buttons.push({
      text: label,
      callback_data: `topic:${channelKeyword}`
    });
  }

  // Assemble into 4 rows x 5 columns grid (Cards 1–20)
  const allButtons = [...card1to10Buttons, ...card11to20Buttons];
  const gridRows = [];
  for (let i = 0; i < allButtons.length; i += 5) {
    gridRows.push(allButtons.slice(i, i + 5));
  }

  return { inline_keyboard: gridRows };
}

async function getBreakingNewsKeyboard() {
  const breaking = getBreakingNews();
  const rows = [];

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
  rows.push([{ text: "🏠 홈으로 돌아가기", callback_data: "menu" }]);

  return { inline_keyboard: rows };
}

async function getCategoryHubKeyboard() {
  const rows = [
    [
      { text: "🎮 게임 플레이", callback_data: "cat:games" },
      { text: "🤖 AI", callback_data: "cat:ai_tools" }
    ],
    [
      { text: "📚 단편 소설", callback_data: "cat:stories" },
      { text: "🔬 학술 논문", callback_data: "cat:papers" }
    ],
    [
      { text: "🔓 콘텐츠", callback_data: "cat:opening_up" },
      { text: "🍴 미식 레시피", callback_data: "cat:food_source" }
    ],
    [
      { text: "💰 재테크 & 투자", callback_data: "cat:finance" },
      { text: "🔞 성인 콘텐츠", callback_data: "cat:adult" }
    ],
    [
      { text: "🔙 뒤로", callback_data: "menu" },
      { text: "🏠 홈으로 돌아가기", callback_data: "menu" }
    ]
  ];

  return { inline_keyboard: rows };
}

async function getTrendingKeyboard() {
  const rows = [];

  // 1. 🔥 실시간 검색어 TOP 10 (UNTOUCHED SEPARATE RANKING SECTION)
  const rankingData = rankingScraper.getLocalRankings();
  const rankings = (rankingData && Array.isArray(rankingData.rankings)) ? rankingData.rankings : [];

  if (rankings.length > 0) {
    rows.push([{ text: "🔥 실시간 검색어 TOP 10", callback_data: "none" }]);
    const rankEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    for (let i = 0; i < Math.min(10, rankings.length); i++) {
      const item = rankings[i];
      if (!item || !item.keyword) continue;
      const emoji = rankEmojis[i] || `${i + 1}️⃣`;
      const targetUrl = item.url || `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(item.keyword)}`;

      rows.push([{
        text: `${emoji} ${item.keyword}`,
        url: targetUrl
      }]);
    }
    rows.push([{ text: "🔄 순위 새로고침", callback_data: "refresh_rankings" }]);
  }

  // 2. Navigation Buttons: Breaking News & Content Hub
  rows.push([{ text: "📰 속보", callback_data: "screen:breaking" }]);
  rows.push([{ text: "📂 콘텐츠 허브", callback_data: "screen:categories" }]);

  // 3. 20 HOT TOPICS Cards (4 rows x 5 columns) directly on Home screen
  const mainKeys = (await getMainKeyboard()).inline_keyboard;
  rows.push(...mainKeys);

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
// 🎮 4 PERMANENT CATEGORY DATASETS & RENDERER
// ============================
const CATEGORIES = {
  games: {
    title: "🎮 게임 플레이",
    items: [
      { name: "🎮 게임 플레이 — @newgames", url: "https://t.me/newgames" },
      { name: "🎮 게임 플레이 — @GameMartzOfficial", url: "https://t.me/GameMartzOfficial" },
      { name: "🎮 게임 플레이 — @TGGames_official", url: "https://t.me/TGGames_official" },
      { name: "🎮 게임 플레이 — @thenotgames", url: "https://t.me/thenotgames" },
      { name: "🎮 게임 플레이 — @FreeGamesNews", url: "https://t.me/FreeGamesNews" },
      { name: "🎮 게임 플레이 — @swag912", url: "https://t.me/swag912?start=xbiso" },
      { name: "🎮 게임 플레이 — @xi_8888888", url: "https://t.me/xi_8888888?start=xbiso" },
      { name: "🎮 게임 플레이 — @lifanhuangyouxi", url: "https://t.me/lifanhuangyouxi?start=xbiso" },
      { name: "🎮 게임 플레이 — @zest110", url: "https://t.me/zest110?start=xbiso" },
      { name: "🎮 게임 플레이 — @Ebpay", url: "https://t.me/Ebpay?start=xbiso" },
      { name: "🎮 게임 플레이 — @dohnaduona", url: "https://t.me/dohnaduona?start=xbiso" },
      { name: "🎮 게임 플레이 — @farrslgrpg", url: "https://t.me/farrslgrpg?start=xbiso" },
      { name: "🎮 게임 플레이 — @MTXFXS", url: "https://t.me/MTXFXS?start=xbiso" },
      { name: "🎮 게임 플레이 — @huangyou_A", url: "https://t.me/huangyou_A?start=xbiso" },
      { name: "🎮 게임 플레이 — @dailikaixian", url: "https://t.me/dailikaixian?start=xbiso" }
    ]
  },
  ai_tools: {
    title: "🤖 AI",
    items: [
      { name: "🤖 AI — @aipost", url: "https://t.me/aipost" },
      { name: "🤖 AI — @Artificial_intelligence_in", url: "https://t.me/Artificial_intelligence_in" },
      { name: "🤖 AI — @DeepLearning_ai", url: "https://t.me/DeepLearning_ai" },
      { name: "🤖 AI — @DataScienceM", url: "https://t.me/DataScienceM" },
      { name: "🤖 AI — @ai_news_world", url: "https://t.me/ai_news_world" },
      { name: "🤖 AI — @toncoin", url: "https://t.me/toncoin?start=xbiso" },
      { name: "🤖 AI — @AIJueSeKa", url: "https://t.me/AIJueSeKa?start=xbiso" },
      { name: "🤖 AI — @toncoin_es", url: "https://t.me/toncoin_es?start=xbiso" },
      { name: "🤖 AI — @toncoin_cn", url: "https://t.me/toncoin_cn?start=xbiso" },
      { name: "🤖 AI — @cabianduanjuheji", url: "https://t.me/cabianduanjuheji?start=xbiso" },
      { name: "🤖 AI — @xiaoshuwu", url: "https://t.me/xiaoshuwu?start=xbiso" },
      { name: "🤖 AI — @asmr_one_chan", url: "https://t.me/asmr_one_chan?start=xbiso" },
      { name: "🤖 AI — @inshdjk", url: "https://t.me/inshdjk?start=xbiso" },
      { name: "🤖 AI — @DNSPODT", url: "https://t.me/DNSPODT?start=xbiso" },
      { name: "🤖 AI — @clbfxs", url: "https://t.me/clbfxs?start=xbiso" },
      { name: "🤖 AI — @yumengai", url: "https://t.me/yumengai?start=xbiso" },
      { name: "🤖 AI — @ph_dcgroup", url: "https://t.me/ph_dcgroup?start=xbiso" }
    ]
  },
  stories: {
    title: "📚 단편 소설",
    items: [
      { name: "📚 단편 소설 — @shortstoriesmm", url: "https://t.me/shortstoriesmm" },
      { name: "📚 단편 소설 — @tellshorttales", url: "https://t.me/tellshorttales" },
      { name: "📚 단편 소설 — @english_storyBook", url: "https://t.me/english_storyBook" },
      { name: "📚 단편 소설 — @book_lists", url: "https://t.me/book_lists" },
      { name: "📚 단편 소설 — @booksmania", url: "https://t.me/booksmania" },
      { name: "📚 단편 소설 — @happylibrary", url: "https://t.me/happylibrary?start=xbiso" },
      { name: "📚 단편 소설 — @WANJSW", url: "https://t.me/WANJSW?start=xbiso" },
      { name: "📚 단편 소설 — @JJSW125689", url: "https://t.me/JJSW125689?start=xbiso" },
      { name: "📚 단편 소설 — @JinPingMeiold", url: "https://t.me/JinPingMeiold?start=xbiso" },
      { name: "📚 단편 소설 — @JGshuoshu", url: "https://t.me/JGshuoshu?start=xbiso" },
      { name: "📚 단편 소설 — @sharebooks4you", url: "https://t.me/sharebooks4you?start=xbiso" },
      { name: "📚 단편 소설 — @soundxiaoshuo", url: "https://t.me/soundxiaoshuo?start=xbiso" },
      { name: "📚 단편 소설 — @yellownovel", url: "https://t.me/yellownovel?start=xbiso" },
      { name: "📚 단편 소설 — @gayui", url: "https://t.me/gayui?start=xbiso" },
      { name: "📚 단편 소설 — @GuyBuok", url: "https://t.me/GuyBuok?start=xbiso" },
      { name: "📚 단편 소설 — @BookLogChannel", url: "https://t.me/BookLogChannel?start=xbiso" },
      { name: "📚 단편 소설 — @novel_174", url: "https://t.me/novel_174?start=xbiso" },
      { name: "📚 단편 소설 — @ysxs8", url: "https://t.me/ysxs8?start=xbiso" }
    ]
  },
  papers: {
    title: "🔬 학술 논문",
    items: [
      { name: "🔬 학술 논문 — @science", url: "https://t.me/science" },
      { name: "🔬 학술 논문 — @scientific", url: "https://t.me/scientific" },
      { name: "🔬 학술 논문 — @science_talk", url: "https://t.me/science_talk" },
      { name: "🔬 학술 논문 — @research_publications", url: "https://t.me/research_publications" },
      { name: "🔬 학술 논문 — @assignmentandthesis", url: "https://t.me/assignmentandthesis" },
      { name: "🔬 학술 논문 — @VPNqn", url: "https://t.me/VPNqn?start=xbiso" },
      { name: "🔬 학술 논문 — @xiaohuojianvpnvpn", url: "https://t.me/xiaohuojianvpnvpn?start=xbiso" },
      { name: "🔬 학술 논문 — @BJxinyu", url: "https://t.me/BJxinyu?start=xbiso" },
      { name: "🔬 학술 논문 — @fun_apk", url: "https://t.me/fun_apk?start=xbiso" },
      { name: "🔬 학술 논문 — @XQFXS", url: "https://t.me/XQFXS?start=xbiso" },
      { name: "🔬 학술 논문 — @PJAPKVPN", url: "https://t.me/PJAPKVPN?start=xbiso" },
      { name: "🔬 학술 논문 — @qiuyue2", url: "https://t.me/qiuyue2?start=xbiso" },
      { name: "🔬 학술 논문 — @pjrjzy", url: "https://t.me/pjrjzy?start=xbiso" },
      { name: "🔬 학술 논문 — @feiyangdigital", url: "https://t.me/feiyangdigital?start=xbiso" },
      { name: "🔬 학술 논문 — @hkfwq111", url: "https://t.me/hkfwq111?start=xbiso" },
      { name: "🔬 학술 논문 — @LCGFX", url: "https://t.me/LCGFX?start=xbiso" },
      { name: "🔬 학술 논문 — @xiaoshuwu", url: "https://t.me/xiaoshuwu?start=xbiso" }
    ]
  },
  opening_up: {
    title: "🔓 콘텐츠",
    items: [
      { name: "🔓 콘텐츠 — @ASMREmily", url: "https://t.me/ASMREmily" },
      { name: "🔓 콘텐츠 — @asmrselena", url: "https://t.me/asmrselena" },
      { name: "🔓 콘텐츠 — @videosasmr", url: "https://t.me/videosasmr" },
      { name: "🔓 콘텐츠 — @ASMR_Relaxing_Sound", url: "https://t.me/ASMR_Relaxing_Sound" },
      { name: "🔓 콘텐츠 — @relaxwithasmr", url: "https://t.me/relaxwithasmr" },
      { name: "🔓 콘텐츠 — @QianMogc_asmr1", url: "https://t.me/QianMogc_asmr1?start=xbiso" },
      { name: "🔓 콘텐츠 — @R_E_STUDIO", url: "https://t.me/R_E_STUDIO?start=xbiso" },
      { name: "🔓 콘텐츠 — @jingluoasmr", url: "https://t.me/jingluoasmr?start=xbiso" },
      { name: "🔓 콘텐츠 — @ASMRLNGC", url: "https://t.me/ASMRLNGC?start=xbiso" },
      { name: "🔓 콘텐츠 — @huach12", url: "https://t.me/huach12?start=xbiso" },
      { name: "🔓 콘텐츠 — @PMV8888", url: "https://t.me/PMV8888?start=xbiso" },
      { name: "🔓 콘텐츠 — @OUEMEI", url: "https://t.me/OUEMEI?start=xbiso" },
      { name: "🔓 콘텐츠 — @PMVMOI", url: "https://t.me/PMVMOI?start=xbiso" },
      { name: "🔓 콘텐츠 — @FC2PPVcom", url: "https://t.me/FC2PPVcom?start=xbiso" },
      { name: "🔓 콘텐츠 — @asmreggaudios", url: "https://t.me/asmreggaudios?start=xbiso" },
      { name: "🔓 콘텐츠 — @asmr_one_chan", url: "https://t.me/asmr_one_chan?start=xbiso" }
    ]
  },
  food_source: {
    title: "🍴 미식 레시피",
    items: [
      { name: "🍴 미식 레시피 — @culinaryD", url: "https://t.me/culinaryD" },
      { name: "🍴 미식 레시피 — @cookingandcooking", url: "https://t.me/cookingandcooking" },
      { name: "🍴 미식 레시피 — @cookingdish", url: "https://t.me/cookingdish" },
      { name: "🍴 미식 레시피 — @thevideorecipes", url: "https://t.me/thevideorecipes" },
      { name: "🍴 미식 레시피 — @JiyasKitchenIndianVegFood", url: "https://t.me/JiyasKitchenIndianVegFood" },
      { name: "🍴 미식 레시피 — @zhenmeiyisi", url: "https://t.me/zhenmeiyisi?start=xbiso" },
      { name: "🍴 미식 레시피 — @NudefilmsTV", url: "https://t.me/NudefilmsTV?start=xbiso" },
      { name: "🍴 미식 레시피 — @gchtdpymfljrg", url: "https://t.me/gchtdpymfljrg?start=xbiso" },
      { name: "🍴 미식 레시피 — @av0000000001", url: "https://t.me/av0000000001?start=xbiso" },
      { name: "🍴 미식 레시피 — @AV_cao", url: "https://t.me/AV_cao?start=xbiso" },
      { name: "🍴 미식 레시피 — @wumingzhidao123", url: "https://t.me/wumingzhidao123?start=xbiso" },
      { name: "🍴 미식 레시피 — @FC2PPV4K", url: "https://t.me/FC2PPV4K?start=xbiso" },
      { name: "🍴 미식 레시피 — @fuqibacc", url: "https://t.me/fuqibacc?start=xbiso" },
      { name: "🍴 미식 레시피 — @fulicangku0", url: "https://t.me/fulicangku0?start=xbiso" },
      { name: "🍴 미식 레시피 — @cili8888", url: "https://t.me/cili8888?start=xbiso" },
      { name: "🍴 미식 레시피 — @shunvguan4", url: "https://t.me/shunvguan4?start=xbiso" },
      { name: "🍴 미식 레시피 — @mingxingtu5", url: "https://t.me/mingxingtu5?start=xbiso" },
      { name: "🍴 미식 레시피 — @Gay123TV", url: "https://t.me/Gay123TV?start=xbiso" },
      { name: "🍴 미식 레시피 — @Aliyun_4K_Movies", url: "https://t.me/Aliyun_4K_Movies?start=xbiso" },
      { name: "🍴 미식 레시피 — @ZYFLS66", url: "https://t.me/ZYFLS66?start=xbiso" }
    ]
  },
  finance: {
    title: "💰 재테크 & 투자",
    items: [
      { name: "💰 재테크 & 투자 — @finance", url: "https://t.me/finance" },
      { name: "💰 재테크 & 투자 — @crypto_finance", url: "https://t.me/crypto_finance" },
      { name: "💰 재테크 & 투자 — @stockstudy", url: "https://t.me/stockstudy" },
      { name: "💰 재테크 & 투자 — @financially_free_in", url: "https://t.me/financially_free_in" },
      { name: "💰 재테크 & 투자 — @token", url: "https://t.me/token" },
      { name: "💰 재테크 & 투자 — @biquanqu", url: "https://t.me/biquanqu?start=xbiso" },
      { name: "💰 재테크 & 투자 — @China77", url: "https://t.me/China77?start=xbiso" },
      { name: "💰 재테크 & 투자 — @tonkeeper_news", url: "https://t.me/tonkeeper_news?start=xbiso" },
      { name: "💰 재테크 & 투자 — @toncoin", url: "https://t.me/toncoin?start=xbiso" },
      { name: "💰 재테크 & 투자 — @bbxx6666", url: "https://t.me/bbxx6666?start=xbiso" },
      { name: "💰 재테크 & 투자 — @sssvip4", url: "https://t.me/sssvip4?start=xbiso" },
      { name: "💰 재테크 & 투자 — @toncoin_es", url: "https://t.me/toncoin_es?start=xbiso" },
      { name: "💰 재테크 & 투자 — @bx600", url: "https://t.me/bx600?start=xbiso" },
      { name: "💰 재테크 & 투자 — @vhhhh", url: "https://t.me/vhhhh?start=xbiso" },
      { name: "💰 재테크 & 투자 — @dailikaixian", url: "https://t.me/dailikaixian?start=xbiso" },
      { name: "💰 재테크 & 투자 — @xinwenrd", url: "https://t.me/xinwenrd?start=xbiso" },
      { name: "💰 재테크 & 투자 — @shuzibaike", url: "https://t.me/shuzibaike?start=xbiso" }
    ]
  },
  adult: {
    title: "🔞 성인 콘텐츠",
    items: [
      { name: "🔞 성인 콘텐츠 — @bgcgw1", url: "https://t.me/bgcgw1/2773" },
      { name: "🔞 성인 콘텐츠 — @weme_downIoad", url: "https://t.me/weme_downIoad/1031730" },
      { name: "🔞 성인 콘텐츠 — @xahvh", url: "https://t.me/xahvh/1286" },
      { name: "🔞 성인 콘텐츠 — @Daoyusmlie", url: "https://t.me/Daoyusmlie/93889" },
      { name: "🔞 성인 콘텐츠 — @tianjin2023", url: "https://t.me/tianjin2023/6939" },
      { name: "🔞 성인 콘텐츠 — @XOTANHUA", url: "https://t.me/XOTANHUA?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @diyisec", url: "https://t.me/diyisec?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @SGPAVCN", url: "https://t.me/SGPAVCN?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @flapxz3", url: "https://t.me/flapxz3?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @biaojie128", url: "https://t.me/biaojie128?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @dongman98", url: "https://t.me/dongman98?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @v131312", url: "https://t.me/v131312?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @tunjing66666", url: "https://t.me/tunjing66666?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @minixue", url: "https://t.me/minixue?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @baiyisizu", url: "https://t.me/baiyisizu?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @daydayACG", url: "https://t.me/daydayACG?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @OFOSSS", url: "https://t.me/OFOSSS?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @happylibrary", url: "https://t.me/happylibrary?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @wumingzhidao123", url: "https://t.me/wumingzhidao123?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @avav131", url: "https://t.me/avav131?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @skkt888", url: "https://t.me/skkt888?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @r18cg", url: "https://t.me/r18cg?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @cosywdj", url: "https://t.me/cosywdj?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @cutexf1v1", url: "https://t.me/cutexf1v1?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @chigua1618", url: "https://t.me/chigua1618?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @ddddffxxr", url: "https://t.me/ddddffxxr?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @ahegobymt", url: "https://t.me/ahegobymt?start=xbiso" },
      { name: "🔞 성인 콘텐츠 — @AVDSTV", url: "https://t.me/AVDSTV?start=xbiso" }
    ]
  }
};

const TOPIC_NAMES = {
  "Romantic Vibe": "🔥 K-Pop 열애설",
  "Dating": "💋 비밀 연애",
  "Romance": "👀 아이돌 열애 루머",
  "Crotch": "💔 연예인 결별",
  "Mosa": "🚨 열애 논란",
  "Bunny Girl Cosplay Date": "❤️ 비밀 커플",
  "Lustful Hostess": "😳 바이럴 로맨스",
  "Concubine": "🔥 럽스타그램",
  "Saki Mizumi": "💍 결혼 루머",
  "A Muse": "👀 연예계 스캔들",
  "ai": "🤖 AI",
  "games": "🎮 게임 플레이",
  "stories": "📚 단편 소설",
  "papers": "🔬 학술 논문",
  "opening_up": "🔓 콘텐츠",
  "food_source": "🍴 미식 레시피",
  "finance": "💰 재테크 & 투자",
  "adult": "🔞 성인 콘텐츠"
};

// ============================
// 🚀 /start COMMAND
// ============================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const payload = match ? match[1] : null;

    if (payload && (payload.startsWith("det_") || payload.startsWith("det~") || payload.startsWith("video_"))) {
      let callbackPrefix = "";
      let itemIdx = 0;
      let page = 1;

      if (payload.startsWith("det~")) {
        const parts = payload.split("~");
        callbackPrefix = decodeURIComponent(parts[1] || "");
        itemIdx = parseInt(parts[2], 10) || 0;
        page = parseInt(parts[3], 10) || 1;
      } else if (payload.startsWith("video_")) {
        const videoId = payload.replace("video_", "");
        const post = sourceRegistry.getPostById(videoId);
        if (post) {
          callbackPrefix = `topic_page:${post.keyword}`;
          const posts = sourceRegistry.getPostsForKeyword(post.keyword);
          const foundIdx = posts.findIndex(p => p.id === post.id || p.unique_hash === post.unique_hash);
          itemIdx = foundIdx !== -1 ? foundIdx : 0;
          page = Math.floor(itemIdx / 10) + 1;
        } else {
          callbackPrefix = "topic_page:Romance";
          itemIdx = 0;
          page = 1;
        }
      } else if (payload.startsWith("det_")) {
        const parts = payload.split("_");
        page = parseInt(parts.pop(), 10) || 1;
        itemIdx = parseInt(parts.pop(), 10) || 0;
        callbackPrefix = parts.slice(1).join(":");
      }

      await renderItemDetailPage(chatId, callbackPrefix, itemIdx, page, null);
      return;
    }

    const firstName = msg.from.first_name || "there";

    // Welcome image + text
    await sendPhotoSafe(chatId, WELCOME_IMAGE, {
      caption:
        `📡 <b>NexaHub에 오신 것을 환영합니다, ${escapeHTML(firstName)}님!</b>\n\n` +
        `🔍 텔레그램 리소스 검색 엔진입니다. 키워드를 전송하여 그룹, 채널, 동영상, 음악을 검색하세요.\n\n` +
        `한국어 및 영어를 지원합니다.\n\n` +
        `👇 탐색할 주제를 선택하세요!`,
      parse_mode: "HTML",
      reply_markup: getPersistentNavigationKeyboard()
    });

    // Topic buttons + Trending combined
    await new Promise(r => setTimeout(r, 800));
    
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
    const chatId = query.message.chat.id;
    const data = query.data;

    const messageId = query.message ? query.message.message_id : null;

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
        } else if (data.startsWith("cat_page:")) {
      const parts = data.split(":");
      const catKey = parts[1];
      const page = parseInt(parts[2], 10);
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
      const text = `🔥 <b>실시간 검색어 TOP 10 & 핫 토픽</b>\n\n실시간 이슈 키워드와 인기 주제를 탐색하세요 👇`;
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
    } else if (data === "screen:categories") {
      const keyboard = await getCategoryHubKeyboard();
      const text = `📂 <b>콘텐츠 허브</b>\n\n다양한 콘텐츠를 카테고리별로 확인하세요. 👇`;
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
    if (msg.message_id) trackMessage(chatId, msg.message_id);
    if (!text) return;

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

    if (text === "ℹ️ About" || text === "ℹ️ 정보") {
      const aboutText =
        `ℹ️ <b>NexaHub 정보</b>\n\n` +
        `NexaHub는 빠르고 지능적인 텔레그램 리소스 검색 엔진입니다.\n\n` +
        `• 키워드를 전송하여 그룹, 채널, 동영상을 검색할 수 있습니다.\n` +
        `• 핫 토픽, 실시간 검색어, 속보를 탐색할 수 있습니다.\n` +
        `• 추천 미디어 및 채널 링크를 즉시 이용할 수 있습니다.`;

      await sendMessageSafe(chatId, aboutText, {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      });
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
  console.log("✅ NewsSearch Main Bot is running...");
  console.log("🔗 Channels shown directly in main bot!");
}

module.exports = {
  renderSearchResults,
  renderTopicPosts,
  renderItemDetailPage,
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
  getPersistentKeyboard,
  getPersistentNavigationKeyboard,
  clearUserHistory,
  videoFileIdCache,
  saveVideoCache,
  getCachedFileId,
  acquireUserLock,
  releaseUserLock,
};

