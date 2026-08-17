try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const https = require("https");
const { startScraperScheduler } = require("./scraper");
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

async function translateText(text, targetLang = "en") {
  if (!text || typeof text !== "string") {
    return text || "";
  }

  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const translated = await new Promise((resolve) => {
      const req = https.get(url, { timeout: 3000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed[0] && parsed[0][0] && parsed[0][0][0]) {
              const fullText = parsed[0].map((item) => item[0]).filter(Boolean).join("");
              resolve(fullText);
            } else {
              resolve(text);
            }
          } catch (e) {
            resolve(text);
          }
        });
      });
      req.on("error", () => resolve(text));
      req.on("timeout", () => {
        req.destroy();
        resolve(text);
      });
    });

    translationCache.set(cacheKey, translated);
    return translated;
  } catch (err) {
    return text;
  }
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
        { text: "🏠 Home" },
        { text: "ℹ️ About" },
        { text: "🗑️ History" }
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

async function sendMessageSafe(chatId, text, options = {}) {
  try {
    const res = await bot.sendMessage(chatId, text, options);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    console.error(`❌ Error sending message to chat ${chatId}:`, err.message);
  }
}

async function sendPhotoSafe(chatId, photo, options = {}) {
  try {
    const res = await bot.sendPhoto(chatId, photo, options);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    console.error(`❌ Error sending photo to chat ${chatId}:`, err.message);
  }
}

async function answerCallbackQuerySafe(queryId, options = {}) {
  try {
    return await bot.answerCallbackQuery(queryId, options);
  } catch (err) {
    console.error(`❌ Error answering callback query ${queryId}:`, err.message);
  }
}

async function editMessageTextSafe(chatId, messageId, text, options = {}) {
  try {
    const opts = {
      chat_id: chatId,
      message_id: messageId,
      ...options
    };
    return await bot.editMessageText(text, opts);
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) {
      return true;
    }
    console.warn(`⚠️ Error editing message ${messageId} in chat ${chatId}:`, err.message);
    return await sendMessageSafe(chatId, text, options);
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
    const emptyText = `📺 <b>${escapeHTML(title)}</b>\n\nNo posts available in this channel yet.`;
    const emptyOpts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Back to Main Menu", callback_data: "menu" }]
        ]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, emptyText, emptyOpts);
    } else {
      return await sendMessageSafe(chatId, emptyText, emptyOpts);
    }
  }

  // Strictly enforce 3-page UI data limit (7 items/page * 3 pages = max 21 items)
  const maxUiItems = (items || []).slice(0, 21);
  const itemsPerPage = 7;
  const totalPages = Math.min(3, Math.ceil(maxUiItems.length / itemsPerPage));
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = maxUiItems.slice(startIndex, startIndex + itemsPerPage);

  const itemLines = [];
  const itemButtons = [];

  pageItems.forEach((p, index) => {
    const itemNumber = startIndex + index + 1;
    let displayTitle = String(p.title || p.name || "").trim();
    if (!displayTitle) {
      displayTitle = "Telegram Resource";
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

    const cleanPrefix = callbackPrefix.replace(/:/g, "_");
    const itemIdx = startIndex + index;
    const internalBotUrl = `https://t.me/santhosh_learning_2026_bot?start=det_${cleanPrefix}_${itemIdx}_${currentPage}`;
    const safeUrl = escapeHTML(internalBotUrl);

    itemLines.push(`${itemNumber}. <a href="${safeUrl}">${escapedTitle}</a>`);

    const btnLabel = `${itemNumber}. ${fullTitle}`.trim();
    const truncatedBtnLabel = truncateUTF8(btnLabel, 55);

    itemButtons.push([{
      text: truncatedBtnLabel,
      callback_data: `det:${callbackPrefix}:${itemIdx}:${currentPage}`
    }]);
  });

  let messageText = `📺 <b>${escapeHTML(title)}</b>\n\n`;
  messageText += `Below are the latest videos from this channel.\n\n`;
  messageText += itemLines.join("\n\n");
  if (totalPages > 1) {
    messageText += `\n\n<b>Page ${currentPage}/${totalPages}</b>`;
  }

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: "⬅️ Previous", callback_data: `${callbackPrefix}:${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: "Next ➡️", callback_data: `${callbackPrefix}:${currentPage + 1}` });
  }

  const inline_keyboard = [];
  if (itemButtons.length > 0) {
    inline_keyboard.push(...itemButtons);
  }
  if (navRow.length > 0) {
    inline_keyboard.push(navRow);
  }
  inline_keyboard.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

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
  let title = "Resource Detail";

  if (callbackPrefix.startsWith("featured_page:") || callbackPrefix.startsWith("featured:")) {
    const cardId = parseInt(callbackPrefix.split(":")[1], 10);
    const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
    title = cardInfo ? cardInfo.name : `Card ${cardId}`;
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
    return await sendMessageSafe(chatId, "⚠️ Item detail not found.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 HOME", callback_data: "menu" }]] }
    });
  }

  let displayTitle = String(item.title || item.name || "Telegram Content").trim();

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
  let duration = item.duration ? `\n<b>Duration:</b> ${item.duration}` : "";
  let views = item.views ? `\n<b>Views:</b> ${item.views}` : "";
  let caption = item.caption ? `\n\n<b>Description:</b>\n${escapeHTML(item.caption)}` : "";

  let videoBox = `┌────────────────────────────────────────┐\n`;
  videoBox += `│  🎬 <a href="${postUrl}"><b>[ WATCH VIDEO PREVIEW ]</b></a>    │\n`;
  videoBox += `│  ▶️  Tap frame or button to watch video  │\n`;
  videoBox += `└────────────────────────────────────────┘\n\n`;

  let detailText = `🎬 <b>${escapeHTML(displayTitle)}</b>\n\n`;
  detailText += videoBox;
  detailText += `<b>Channel:</b> ${escapeHTML(channelName)}\n`;
  detailText += `<b>Type:</b> ${mediaType}${views}${duration}${caption}`;

  const inline_keyboard = [
    [{ text: "▶️ WATCH VIDEO", url: postUrl }],
    [{ text: "🔗 JOIN GROUP", url: groupUrl }],
    [{ text: "◀️ BACK", callback_data: `${callbackPrefix}:${page}` }],
    [{ text: "🏠 HOME", callback_data: "menu" }]
  ];

  const opts = {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard }
  };

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

function formatCompactHotTopicLabel(emoji, rawText) {
  if (!rawText) return `${emoji} Topic`;
  let text = sanitizeUTF8(rawText).trim()
    .replace(/^[▶️🎬🖼️🔥⭐🎤👁️🖤⚽🎲💃👑\s]+/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim();
  
  if (!text) return `${emoji} Topic`;

  const MAX_TEXT_LEN = 11;
  const symbols = Array.from(text);

  if (symbols.length <= MAX_TEXT_LEN) {
    return `${emoji} ${text}`;
  }

  const words = text.split(/\s+/);
  if (words.length > 1) {
    let firstWord = words[0];
    const firstWordSymbols = Array.from(firstWord);
    if (firstWordSymbols.length <= MAX_TEXT_LEN - 1) {
      return `${emoji} ${firstWord}…`;
    }
  }

  return `${emoji} ${symbols.slice(0, MAX_TEXT_LEN - 1).join('')}…`;
}

async function getMainKeyboard() {
  // 1. CARDS 1–10: Live Korean Trending Searches (VISUAL DISPLAY LABELS ONLY -> Direct Fixed Channel Callback)
  const krKeywords = getTrendingKeywords();
  const card1to10Buttons = [];
  
  for (let i = 0; i < 10; i++) {
    const rawKw = krKeywords[i] || `Trend ${i + 1}`;
    const displayKw = await translateText(rawKw, "en");
    const label = formatCompactHotTopicLabel("🔥", displayKw);
    const channelKeyword = TARGET_CHANNELS[i] || "Dating";
    card1to10Buttons.push({
      text: label,
      callback_data: `topic:${channelKeyword}` // Direct fixed channel connection (NO keyword searching)
    });
  }

  // 2. CARDS 11–20: OUR 10 MANAGED TELEGRAM CHANNELS (Fixed Channel Mapping -> Latest Post / Channel Name)
  const card11to20Buttons = [];

  for (let i = 0; i < 10; i++) {
    const channelKeyword = TARGET_CHANNELS[i] || "Dating";
    const channelPosts = sourceRegistry.getPostsForKeyword(channelKeyword);
    const latestPost = channelPosts[0] || null;

    let textToFormat = channelKeyword;
    if (latestPost && latestPost.title) {
      textToFormat = latestPost.title;
    }
    const label = formatCompactHotTopicLabel("▶️", textToFormat);

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

async function getTrendingKeyboard() {
  const mainKeys = (await getMainKeyboard()).inline_keyboard;
  const breaking = getBreakingNews();
  const rows = [...mainKeys];

  // 1. Breaking News (if any)
  if (breaking.length > 0) {
    rows.push([{ text: "📰 BREAKING NEWS", callback_data: "none" }]);
    for (const news of breaking) {
      const displayNews = await translateText(news, "en");
      rows.push([{ text: `📰 ${displayNews}`, url: `https://www.google.com/search?q=${encodeURIComponent(news)}` }]);
    }
  }

  // 2. Refresh Trending button (full width)
  rows.push([{ text: "🔄 REFRESH TRENDING", callback_data: "refresh_trending" }]);

  // 3. 8 Permanent Category Buttons (2 per row) directly below REFRESH TRENDING
  rows.push([
    { text: "🎮 Play Games", callback_data: "cat:games" },
    { text: "🤖 AI", callback_data: "cat:ai_tools" }
  ]);
  rows.push([
    { text: "📚 Short Stories", callback_data: "cat:stories" },
    { text: "🔬 Scientific Paper", callback_data: "cat:papers" }
  ]);
  rows.push([
    { text: "🔓 Opening Up", callback_data: "cat:opening_up" },
    { text: "🍴 Source of Food", callback_data: "cat:food_source" }
  ]);
  rows.push([
    { text: "💰 Financial Investment", callback_data: "cat:finance" },
    { text: "🔞 Adult Content", callback_data: "cat:adult" }
  ]);

  return { inline_keyboard: rows };
}

async function renderSearchResults(chatId, query, page = 1, messageId = null) {
  recordUserSearch(chatId, query);
  const displayQuery = await translateText(query, "en");

  // Search posts from our 10 managed Telegram channels
  let posts = sourceRegistry.searchPosts(query);
  if ((!posts || posts.length === 0) && displayQuery !== query) {
    posts = sourceRegistry.searchPosts(displayQuery);
  }

  const titleHeader = `🔍 Live Trending Keyword: ${displayQuery}`;
  const callbackPrefix = `search_page:${encodeURIComponent(query)}`;

  return await renderHyperlinkListPostView(chatId, titleHeader, posts, page, callbackPrefix, messageId);
}

function getChannelButtons(channels) {
  const rows = channels.map(ch => ([
    { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
  ]));
  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function formatChannelList(channels, topicName) {
  const displayTopicName = TOPIC_NAMES[topicName] || topicName;
  return `📢 <b>${escapeHTML(displayTopicName)}</b>\n\n👇 Tap any post below:`;
}


// ============================
// 🎮 4 PERMANENT CATEGORY DATASETS & RENDERER
// ============================
const CATEGORIES = {
  games: {
    title: "🎮 Play Games",
    items: [
      { name: "🎮 Play Games — @newgames", url: "https://t.me/newgames" },
      { name: "🎮 Play Games — @GameMartzOfficial", url: "https://t.me/GameMartzOfficial" },
      { name: "🎮 Play Games — @TGGames_official", url: "https://t.me/TGGames_official" },
      { name: "🎮 Play Games — @thenotgames", url: "https://t.me/thenotgames" },
      { name: "🎮 Play Games — @FreeGamesNews", url: "https://t.me/FreeGamesNews" },
      { name: "🎮 Play Games — @swag912", url: "https://t.me/swag912?start=xbiso" },
      { name: "🎮 Play Games — @xi_8888888", url: "https://t.me/xi_8888888?start=xbiso" },
      { name: "🎮 Play Games — @lifanhuangyouxi", url: "https://t.me/lifanhuangyouxi?start=xbiso" },
      { name: "🎮 Play Games — @zest110", url: "https://t.me/zest110?start=xbiso" },
      { name: "🎮 Play Games — @Ebpay", url: "https://t.me/Ebpay?start=xbiso" },
      { name: "🎮 Play Games — @dohnaduona", url: "https://t.me/dohnaduona?start=xbiso" },
      { name: "🎮 Play Games — @farrslgrpg", url: "https://t.me/farrslgrpg?start=xbiso" },
      { name: "🎮 Play Games — @MTXFXS", url: "https://t.me/MTXFXS?start=xbiso" },
      { name: "🎮 Play Games — @huangyou_A", url: "https://t.me/huangyou_A?start=xbiso" },
      { name: "🎮 Play Games — @dailikaixian", url: "https://t.me/dailikaixian?start=xbiso" }
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
    title: "📚 Short Stories",
    items: [
      { name: "📚 Short Stories — @shortstoriesmm", url: "https://t.me/shortstoriesmm" },
      { name: "📚 Short Stories — @tellshorttales", url: "https://t.me/tellshorttales" },
      { name: "📚 Short Stories — @english_storyBook", url: "https://t.me/english_storyBook" },
      { name: "📚 Short Stories — @book_lists", url: "https://t.me/book_lists" },
      { name: "📚 Short Stories — @booksmania", url: "https://t.me/booksmania" },
      { name: "📚 Short Stories — @happylibrary", url: "https://t.me/happylibrary?start=xbiso" },
      { name: "📚 Short Stories — @WANJSW", url: "https://t.me/WANJSW?start=xbiso" },
      { name: "📚 Short Stories — @JJSW125689", url: "https://t.me/JJSW125689?start=xbiso" },
      { name: "📚 Short Stories — @JinPingMeiold", url: "https://t.me/JinPingMeiold?start=xbiso" },
      { name: "📚 Short Stories — @JGshuoshu", url: "https://t.me/JGshuoshu?start=xbiso" },
      { name: "📚 Short Stories — @sharebooks4you", url: "https://t.me/sharebooks4you?start=xbiso" },
      { name: "📚 Short Stories — @soundxiaoshuo", url: "https://t.me/soundxiaoshuo?start=xbiso" },
      { name: "📚 Short Stories — @yellownovel", url: "https://t.me/yellownovel?start=xbiso" },
      { name: "📚 Short Stories — @gayui", url: "https://t.me/gayui?start=xbiso" },
      { name: "📚 Short Stories — @GuyBuok", url: "https://t.me/GuyBuok?start=xbiso" },
      { name: "📚 Short Stories — @BookLogChannel", url: "https://t.me/BookLogChannel?start=xbiso" },
      { name: "📚 Short Stories — @novel_174", url: "https://t.me/novel_174?start=xbiso" },
      { name: "📚 Short Stories — @ysxs8", url: "https://t.me/ysxs8?start=xbiso" }
    ]
  },
  papers: {
    title: "🔬 Scientific Paper",
    items: [
      { name: "🔬 Scientific Paper — @science", url: "https://t.me/science" },
      { name: "🔬 Scientific Paper — @scientific", url: "https://t.me/scientific" },
      { name: "🔬 Scientific Paper — @science_talk", url: "https://t.me/science_talk" },
      { name: "🔬 Scientific Paper — @research_publications", url: "https://t.me/research_publications" },
      { name: "🔬 Scientific Paper — @assignmentandthesis", url: "https://t.me/assignmentandthesis" },
      { name: "🔬 Scientific Paper — @VPNqn", url: "https://t.me/VPNqn?start=xbiso" },
      { name: "🔬 Scientific Paper — @xiaohuojianvpnvpn", url: "https://t.me/xiaohuojianvpnvpn?start=xbiso" },
      { name: "🔬 Scientific Paper — @BJxinyu", url: "https://t.me/BJxinyu?start=xbiso" },
      { name: "🔬 Scientific Paper — @fun_apk", url: "https://t.me/fun_apk?start=xbiso" },
      { name: "🔬 Scientific Paper — @XQFXS", url: "https://t.me/XQFXS?start=xbiso" },
      { name: "🔬 Scientific Paper — @PJAPKVPN", url: "https://t.me/PJAPKVPN?start=xbiso" },
      { name: "🔬 Scientific Paper — @qiuyue2", url: "https://t.me/qiuyue2?start=xbiso" },
      { name: "🔬 Scientific Paper — @pjrjzy", url: "https://t.me/pjrjzy?start=xbiso" },
      { name: "🔬 Scientific Paper — @feiyangdigital", url: "https://t.me/feiyangdigital?start=xbiso" },
      { name: "🔬 Scientific Paper — @hkfwq111", url: "https://t.me/hkfwq111?start=xbiso" },
      { name: "🔬 Scientific Paper — @LCGFX", url: "https://t.me/LCGFX?start=xbiso" },
      { name: "🔬 Scientific Paper — @xiaoshuwu", url: "https://t.me/xiaoshuwu?start=xbiso" }
    ]
  },
  opening_up: {
    title: "🔓 Opening Up",
    items: [
      { name: "🔓 Opening Up — @ASMREmily", url: "https://t.me/ASMREmily" },
      { name: "🔓 Opening Up — @asmrselena", url: "https://t.me/asmrselena" },
      { name: "🔓 Opening Up — @videosasmr", url: "https://t.me/videosasmr" },
      { name: "🔓 Opening Up — @ASMR_Relaxing_Sound", url: "https://t.me/ASMR_Relaxing_Sound" },
      { name: "🔓 Opening Up — @relaxwithasmr", url: "https://t.me/relaxwithasmr" },
      { name: "🔓 Opening Up — @QianMogc_asmr1", url: "https://t.me/QianMogc_asmr1?start=xbiso" },
      { name: "🔓 Opening Up — @R_E_STUDIO", url: "https://t.me/R_E_STUDIO?start=xbiso" },
      { name: "🔓 Opening Up — @jingluoasmr", url: "https://t.me/jingluoasmr?start=xbiso" },
      { name: "🔓 Opening Up — @ASMRLNGC", url: "https://t.me/ASMRLNGC?start=xbiso" },
      { name: "🔓 Opening Up — @huach12", url: "https://t.me/huach12?start=xbiso" },
      { name: "🔓 Opening Up — @PMV8888", url: "https://t.me/PMV8888?start=xbiso" },
      { name: "🔓 Opening Up — @OUEMEI", url: "https://t.me/OUEMEI?start=xbiso" },
      { name: "🔓 Opening Up — @PMVMOI", url: "https://t.me/PMVMOI?start=xbiso" },
      { name: "🔓 Opening Up — @FC2PPVcom", url: "https://t.me/FC2PPVcom?start=xbiso" },
      { name: "🔓 Opening Up — @asmreggaudios", url: "https://t.me/asmreggaudios?start=xbiso" },
      { name: "🔓 Opening Up — @asmr_one_chan", url: "https://t.me/asmr_one_chan?start=xbiso" }
    ]
  },
  food_source: {
    title: "🍴 Source of Food",
    items: [
      { name: "🍴 Source of Food — @culinaryD", url: "https://t.me/culinaryD" },
      { name: "🍴 Source of Food — @cookingandcooking", url: "https://t.me/cookingandcooking" },
      { name: "🍴 Source of Food — @cookingdish", url: "https://t.me/cookingdish" },
      { name: "🍴 Source of Food — @thevideorecipes", url: "https://t.me/thevideorecipes" },
      { name: "🍴 Source of Food — @JiyasKitchenIndianVegFood", url: "https://t.me/JiyasKitchenIndianVegFood" },
      { name: "🍴 Source of Food — @zhenmeiyisi", url: "https://t.me/zhenmeiyisi?start=xbiso" },
      { name: "🍴 Source of Food — @NudefilmsTV", url: "https://t.me/NudefilmsTV?start=xbiso" },
      { name: "🍴 Source of Food — @gchtdpymfljrg", url: "https://t.me/gchtdpymfljrg?start=xbiso" },
      { name: "🍴 Source of Food — @av0000000001", url: "https://t.me/av0000000001?start=xbiso" },
      { name: "🍴 Source of Food — @AV_cao", url: "https://t.me/AV_cao?start=xbiso" },
      { name: "🍴 Source of Food — @wumingzhidao123", url: "https://t.me/wumingzhidao123?start=xbiso" },
      { name: "🍴 Source of Food — @FC2PPV4K", url: "https://t.me/FC2PPV4K?start=xbiso" },
      { name: "🍴 Source of Food — @fuqibacc", url: "https://t.me/fuqibacc?start=xbiso" },
      { name: "🍴 Source of Food — @fulicangku0", url: "https://t.me/fulicangku0?start=xbiso" },
      { name: "🍴 Source of Food — @cili8888", url: "https://t.me/cili8888?start=xbiso" },
      { name: "🍴 Source of Food — @shunvguan4", url: "https://t.me/shunvguan4?start=xbiso" },
      { name: "🍴 Source of Food — @mingxingtu5", url: "https://t.me/mingxingtu5?start=xbiso" },
      { name: "🍴 Source of Food — @Gay123TV", url: "https://t.me/Gay123TV?start=xbiso" },
      { name: "🍴 Source of Food — @Aliyun_4K_Movies", url: "https://t.me/Aliyun_4K_Movies?start=xbiso" },
      { name: "🍴 Source of Food — @ZYFLS66", url: "https://t.me/ZYFLS66?start=xbiso" }
    ]
  },
  finance: {
    title: "💰 Financial Investment",
    items: [
      { name: "💰 Financial Investment — @finance", url: "https://t.me/finance" },
      { name: "💰 Financial Investment — @crypto_finance", url: "https://t.me/crypto_finance" },
      { name: "💰 Financial Investment — @stockstudy", url: "https://t.me/stockstudy" },
      { name: "💰 Financial Investment — @financially_free_in", url: "https://t.me/financially_free_in" },
      { name: "💰 Financial Investment — @token", url: "https://t.me/token" },
      { name: "💰 Financial Investment — @biquanqu", url: "https://t.me/biquanqu?start=xbiso" },
      { name: "💰 Financial Investment — @China77", url: "https://t.me/China77?start=xbiso" },
      { name: "💰 Financial Investment — @tonkeeper_news", url: "https://t.me/tonkeeper_news?start=xbiso" },
      { name: "💰 Financial Investment — @toncoin", url: "https://t.me/toncoin?start=xbiso" },
      { name: "💰 Financial Investment — @bbxx6666", url: "https://t.me/bbxx6666?start=xbiso" },
      { name: "💰 Financial Investment — @sssvip4", url: "https://t.me/sssvip4?start=xbiso" },
      { name: "💰 Financial Investment — @toncoin_es", url: "https://t.me/toncoin_es?start=xbiso" },
      { name: "💰 Financial Investment — @bx600", url: "https://t.me/bx600?start=xbiso" },
      { name: "💰 Financial Investment — @vhhhh", url: "https://t.me/vhhhh?start=xbiso" },
      { name: "💰 Financial Investment — @dailikaixian", url: "https://t.me/dailikaixian?start=xbiso" },
      { name: "💰 Financial Investment — @xinwenrd", url: "https://t.me/xinwenrd?start=xbiso" },
      { name: "💰 Financial Investment — @shuzibaike", url: "https://t.me/shuzibaike?start=xbiso" }
    ]
  },
  adult: {
    title: "🔞 Adult Content",
    items: [
      { name: "🔞 Adult Content — @bgcgw1", url: "https://t.me/bgcgw1/2773" },
      { name: "🔞 Adult Content — @weme_downIoad", url: "https://t.me/weme_downIoad/1031730" },
      { name: "🔞 Adult Content — @xahvh", url: "https://t.me/xahvh/1286" },
      { name: "🔞 Adult Content — @Daoyusmlie", url: "https://t.me/Daoyusmlie/93889" },
      { name: "🔞 Adult Content — @tianjin2023", url: "https://t.me/tianjin2023/6939" },
      { name: "🔞 Adult Content — @XOTANHUA", url: "https://t.me/XOTANHUA?start=xbiso" },
      { name: "🔞 Adult Content — @diyisec", url: "https://t.me/diyisec?start=xbiso" },
      { name: "🔞 Adult Content — @SGPAVCN", url: "https://t.me/SGPAVCN?start=xbiso" },
      { name: "🔞 Adult Content — @flapxz3", url: "https://t.me/flapxz3?start=xbiso" },
      { name: "🔞 Adult Content — @biaojie128", url: "https://t.me/biaojie128?start=xbiso" },
      { name: "🔞 Adult Content — @dongman98", url: "https://t.me/dongman98?start=xbiso" },
      { name: "🔞 Adult Content — @v131312", url: "https://t.me/v131312?start=xbiso" },
      { name: "🔞 Adult Content — @tunjing66666", url: "https://t.me/tunjing66666?start=xbiso" },
      { name: "🔞 Adult Content — @minixue", url: "https://t.me/minixue?start=xbiso" },
      { name: "🔞 Adult Content — @baiyisizu", url: "https://t.me/baiyisizu?start=xbiso" },
      { name: "🔞 Adult Content — @daydayACG", url: "https://t.me/daydayACG?start=xbiso" },
      { name: "🔞 Adult Content — @OFOSSS", url: "https://t.me/OFOSSS?start=xbiso" },
      { name: "🔞 Adult Content — @happylibrary", url: "https://t.me/happylibrary?start=xbiso" },
      { name: "🔞 Adult Content — @wumingzhidao123", url: "https://t.me/wumingzhidao123?start=xbiso" },
      { name: "🔞 Adult Content — @avav131", url: "https://t.me/avav131?start=xbiso" },
      { name: "🔞 Adult Content — @skkt888", url: "https://t.me/skkt888?start=xbiso" },
      { name: "🔞 Adult Content — @r18cg", url: "https://t.me/r18cg?start=xbiso" },
      { name: "🔞 Adult Content — @cosywdj", url: "https://t.me/cosywdj?start=xbiso" },
      { name: "🔞 Adult Content — @cutexf1v1", url: "https://t.me/cutexf1v1?start=xbiso" },
      { name: "🔞 Adult Content — @chigua1618", url: "https://t.me/chigua1618?start=xbiso" },
      { name: "🔞 Adult Content — @ddddffxxr", url: "https://t.me/ddddffxxr?start=xbiso" },
      { name: "🔞 Adult Content — @ahegobymt", url: "https://t.me/ahegobymt?start=xbiso" },
      { name: "🔞 Adult Content — @AVDSTV", url: "https://t.me/AVDSTV?start=xbiso" }
    ]
  }
};

const TOPIC_NAMES = {
  ai: "🎯 Perverted Woman",
  bitcoin: "💎 BeautyFilterRendering",
  tesla: " Test-03",
  openai: "🌐 Test-04",
  meriolchan: "🌸 Meriolchan",
  isa: "⭐ Isa",
  hypnotic_eyes: "👁️ Hypnotic Eyes",
  sun_yezi: "☀️ Sun Yezi",
  odetta: "💃 Odetta",
  socialite: "👑 Socialite",
  nine_gates: "⛩️ Nine Gates",
  ssaimi: "✨ Ssaimi",
  dragon_restaurant: "🐉 King Welcoming Dragon Restaurant",
  shoko_shouko: "📣 Shoko Shouko",
};

// ============================
// 🚀 /start COMMAND
// ============================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const payload = match ? match[1] : null;

    if (payload && payload.startsWith("det_")) {
      const parts = payload.split("_");
      const page = parseInt(parts.pop(), 10) || 1;
      const itemIdx = parseInt(parts.pop(), 10) || 0;
      const callbackPrefix = parts.slice(1).join(":");
      await renderItemDetailPage(chatId, callbackPrefix, itemIdx, page, null);
      return;
    }

    const firstName = msg.from.first_name || "there";

    // Welcome image + text
    await sendPhotoSafe(chatId, WELCOME_IMAGE, {
      caption:
        `📡 <b>Welcome to NexaHub, ${escapeHTML(firstName)}!</b>\n\n` +
        `🔍This is a Telegram resource search engine. Send keywords to find groups, channels, videos, and music.\n\n` +
        `👇 Tap any topic to see the best channels!`,
      parse_mode: "HTML",
      reply_markup: getPersistentNavigationKeyboard()
    });

    // Topic buttons + Trending combined
    await new Promise(r => setTimeout(r, 800));
    
    const combinedKeyboard = await getTrendingKeyboard();

    await sendMessageSafe(chatId,
      `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
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

    const message = `<b>How to Access Restricted/Sensitive Content on Telegram (iOS)</b>\n\n` +
      `If you encounter the following message when joining a group or channel:\n\n` +
      `<i>"This channel can't be displayed because it was used to spread pornographic content."</i>\n\n` +
      `<b>The Reason:</b>\n` +
      `The channel or group has been restricted by Telegram for containing adult or sensitive content.\n\n` +
      `<b>✅ The Fix:</b>\n\n` +
      `Log in to Telegram Web: https://web.telegram.org (Open this link in your mobile or desktop browser).\n\n` +
      `Follow these steps:\n` +
      `➊ Go to Settings\n` +
      `➋ Select Privacy and Security\n` +
      `➌ Scroll down to the Sensitive Content section\n` +
      `➍ Enable "Disable filtering"\n\n` +
      `Restart the Telegram app on your iOS device, and you should now have full access.`;

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
    } else if (data === "refresh_trending") {
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`;
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
      const text = `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`;
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
          `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
          {
            parse_mode: "HTML",
            reply_markup: combinedKeyboard,
          }
        );
        await sendMessageSafe(chatId,
          `✨ <b>Fresh session started!</b>`,
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
          `❌ History clearing cancelled.`,
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

    if (text === "🏠 Home") {
      const combinedKeyboard = await getTrendingKeyboard();

      await sendMessageSafe(chatId,
        `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
        {
          parse_mode: "HTML",
          reply_markup: combinedKeyboard,
        }
      );
      return;
    }

    if (text === "ℹ️ About") {
      const aboutText =
        `ℹ️ <b>About NexaHub</b>\n\n` +
        `NexaHub is a fast, intelligent Telegram resource search engine.\n\n` +
        `• Send any keyword to search groups, channels, and videos.\n` +
        `• Explore Hot Topics, Trending searches, and Breaking News.\n` +
        `• Access featured media & direct channel links instantly.`;

      await sendMessageSafe(chatId, aboutText, {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      });
      return;
    }

    if (text === "🗑️ History" || text === "🗑️ Clear History") {
      const confirmText =
        `⚠️ <b>Clear Chat History?</b>\n\n` +
        `This will remove the recent NexaHub messages from this conversation and start a fresh session.\n\n` +
        `Are you sure?`;

      await sendMessageSafe(chatId, confirmText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Yes, Clear", callback_data: "confirm_clear_history" },
              { text: "❌ Cancel", callback_data: "cancel_clear_history" }
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
  console.log("✅ NewsSearch Main Bot is running...");
  console.log("🔗 Channels shown directly in main bot!");

  // Perform ONE-TIME MTProto Startup Sync for all 10 managed private channels
  if (process.env.TELEGRAM_SESSION_STRING) {
    const MTProtoChannelReader = require("./mtproto_reader");
    const reader = new MTProtoChannelReader();
    console.log("📡 Initializing MTProto Startup Channel Sync...");
    reader.syncAllChannels(10, true)
      .then(results => {
        const totalIngested = results.reduce((acc, r) => acc + (r.posts_found || 0), 0);
        console.log(`✅ MTProto Startup Sync Complete! Synced ${results.length} channels (${totalIngested} total posts persisted).`);
      })
      .catch(err => console.error("⚠️ MTProto Startup Sync Error:", err.message));
  }
}

module.exports = {
  renderSearchResults,
  renderTopicPosts,
  CHANNELS,
  CATEGORIES,
  truncateUTF8,
  makeSearchCallbackData,
  escapeHTML,
  translateText,
  getMainKeyboard,
  getTrendingKeyboard,
  getPersistentKeyboard,
  getPersistentNavigationKeyboard,
  clearUserHistory,
  videoFileIdCache,
  saveVideoCache,
  getCachedFileId,
  acquireUserLock,
  releaseUserLock,
};

