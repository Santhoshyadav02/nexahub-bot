try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const https = require("https");
const { startScraperScheduler } = require("./scraper");

// ============================
// 🤖 MAIN BOT TOKEN & INIT
// ============================
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN environment variable is not defined!");
  console.error("Please set BOT_TOKEN in your environment or .env file.");
  process.exit(1);
}

const isMainModule = require.main === module;
const bot = new TelegramBot(TOKEN, { polling: isMainModule });

bot.on("polling_error", (error) => {
  console.error("⚠️ Telegram Bot Polling Error:", error.code || "", error.message || error);
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

async function renderFeaturedCardPosts(chatId, cardId, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const cardName = cardInfo ? cardInfo.name : `Card ${cardId}`;
  const posts = getFeaturedPosts(cardId);

  if (!posts || posts.length === 0) {
    const emptyText = `🔥 <b>${escapeHTML(cardName)}</b>\n\nNo posts found for this category.`;
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

  const itemsPerPage = 10;
  const totalPages = Math.ceil(posts.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pagePosts = posts.slice(startIndex, startIndex + itemsPerPage);

  // ============================================================
  // PROTOTYPE ONLY: 🔥 Teng Teng Cai (Card ID 6) Hyperlink List View
  // ============================================================
  if (cardId === 6) {
    const linkLines = pagePosts.map((p, index) => {
      const itemNumber = startIndex + index + 1;
      let displayTitle = String(p.title || "").trim();
      if (!displayTitle) {
        displayTitle = "Teng Teng Cai — Video";
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
      const safeUrl = escapeHTML(p.url);

      return `${itemNumber}. <a href="${safeUrl}">${escapedTitle}</a>`;
    });

    let messageText = `🔥🔥 <b>${escapeHTML(cardName)}</b>\n\n`;
    messageText += `Below are the channels and videos related to this topic. Click any link to open.\n`;
    messageText += `───────────────────\n`;
    messageText += `🔗 <b>CHANNEL/VIDEO LINKS</b>\n\n`;
    messageText += linkLines.join("\n\n");
    if (totalPages > 1) {
      messageText += `\n\n<b>Page ${currentPage}/${totalPages}</b>`;
    }
    messageText += `\n\nℹ️ <i>Note: Click any link above to open the channel/video in Telegram.</i>`;

    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "⬅️ Previous", callback_data: `featured_page:${cardId}:${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ➡️", callback_data: `featured_page:${cardId}:${currentPage + 1}` });
    }

    const inline_keyboard = [];
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

  const rows = pagePosts.map(p => {
    let displayTitle = String(p.title || "").trim();
    let icon = "";

    // Check if title already contains media icon or starts with bracket
    if (displayTitle.includes("▶") || displayTitle.includes("🎬") || displayTitle.includes("🖼️") || displayTitle.includes("📄") || displayTitle.includes("📹") || displayTitle.includes("🔘")) {
      icon = "";
    } else if (p.url.includes("img") || displayTitle.toLowerCase().includes("photo")) {
      icon = "🖼️ ";
    } else if (displayTitle.startsWith("[")) {
      icon = "▶️ ";
    } else {
      icon = "🎬 ";
    }

    const fullTitle = `${icon}${displayTitle}`.trim();
    const titleText = truncateUTF8(fullTitle, 55);
    return [{ text: titleText, url: p.url }];
  });

  // Pagination row if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀ Previous", callback_data: `featured_page:${cardId}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `featured_page:${cardId}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

  const messageText = `🔥 <b>${escapeHTML(cardName)}</b>\n\nFound <b>${posts.length}</b> post(s):`;
  const messageOptions = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, messageText, messageOptions);
  } else {
    return await sendMessageSafe(chatId, messageText, messageOptions);
  }
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

function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔥 Huangguo", callback_data: "featured:1" },
        { text: "⭐ Li Meng", callback_data: "featured:2" },
        { text: "🎤 Dong Qing", callback_data: "featured:3" },
        { text: "👁️ Hypnotic", callback_data: "featured:4" },
      ],
      [
        { text: "🖤 pinkchyu", callback_data: "featured:5" },
        { text: "🔥 Teng Teng", callback_data: "featured:6" },
        { text: "⚽ World Cup", callback_data: "featured:7" },
        { text: "🎲 Baccarat", callback_data: "featured:8" },
      ],
      [
        { text: "🔥 Perverted", callback_data: "topic:ai" },
        { text: "💎 BeautyFilter", callback_data: "topic:bitcoin" },
        { text: "🌸 Meriolchan", callback_data: "topic:meriolchan" },
        { text: "⭐ Isa", callback_data: "topic:isa" },
      ],
      [
        { text: "👁️ Hypnotic Eyes", callback_data: "topic:hypnotic_eyes" },
        { text: "☀️ Sun Yezi", callback_data: "topic:sun_yezi" },
        { text: "🔥 Odetta", callback_data: "topic:odetta" },
        { text: "👑 Socialite", callback_data: "topic:socialite" },
      ],
      [
        { text: "⛩️ Nine Gates", callback_data: "topic:nine_gates" },
        { text: "✨ Ssaimi", callback_data: "topic:ssaimi" },
        { text: "🔥 Dragon Rest.", callback_data: "topic:dragon_restaurant" },
        { text: "📣 Shoko Shouko", callback_data: "topic:shoko_shouko" },
      ],
    ],
  };
}

function searchResources(query) {
  if (!query || typeof query !== "string") return [];
  const rawQuery = query.trim().toLowerCase();
  if (!rawQuery) return [];

  const compactQuery = rawQuery.replace(/[\s\-_]+/g, "");
  const tokens = rawQuery.split(/[\s\-_]+/).filter(t => t.length > 0);

  const matchedItems = [];

  for (const [catKey, items] of Object.entries(CHANNELS)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!item || !item.name) continue;

      const nameLower = item.name.toLowerCase();
      const userLower = (item.user || "").toLowerCase();
      const catLower = catKey.toLowerCase();
      const nameCompact = nameLower.replace(/[\s\-_]+/g, "");
      const userCompact = userLower.replace(/[\s\-_]+/g, "");

      let score = 0;

      // 1. Exact phrase or code match (Highest priority)
      if (nameLower.includes(rawQuery) || (compactQuery.length > 1 && nameCompact.includes(compactQuery))) {
        score += 100;
      }
      if (userLower.includes(rawQuery) || (compactQuery.length > 1 && userCompact.includes(compactQuery))) {
        score += 90;
      }

      // 2. Token relevance matching in name
      for (const t of tokens) {
        const compactToken = t.replace(/[\s\-_]+/g, "");
        if (nameLower.includes(t)) {
          score += 30;
        } else if (compactToken.length > 1 && nameCompact.includes(compactToken)) {
          score += 25;
        }
      }

      // 3. Category matching
      if (catLower.includes(rawQuery) || tokens.some(t => catLower.includes(t))) {
        score += 15;
      }

      // 4. Token relevance matching in user field
      for (const t of tokens) {
        if (userLower.includes(t)) {
          score += 10;
        }
      }

      if (score > 0) {
        matchedItems.push({
          name: item.name,
          user: item.user,
          category: catKey,
          score: score,
        });
      }
    }
  }

  // Deduplicate by user URL if duplicate items exist across categories, keeping highest score
  const uniqueMap = new Map();
  for (const item of matchedItems) {
    const existing = uniqueMap.get(item.user);
    if (!existing || item.score > existing.score) {
      uniqueMap.set(item.user, item);
    }
  }

  // Sort by score descending
  return Array.from(uniqueMap.values()).sort((a, b) => b.score - a.score);
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

// ============================
// 🌟 FEATURED RESOURCES (TOP 8 CARDS)
// ============================
const FEATURED_RESOURCES = [
  { id: 1, name: "🔥 Huangguo Short Dramas" },
  { id: 2, name: "⭐ Li Meng" },
  { id: 3, name: "🎤 Dong Qing" },
  { id: 4, name: "👁️ Hypnotic Divine Eye" },
  { id: 5, name: "🖤 pinkchyu" },
  { id: 6, name: "🔥 Teng Teng Cai" },
  { id: 7, name: "⚽ World Cup" },
  { id: 8, name: "🎲 Baccarat / Dice / Gaming" }
];

function getFeaturedKeyboard() {
  const rows = [];
  for (let i = 0; i < FEATURED_RESOURCES.length; i += 2) {
    const r1 = FEATURED_RESOURCES[i];
    const r2 = FEATURED_RESOURCES[i + 1];

    const row = [
      { text: `${r1.name}`, callback_data: `featured:${r1.id}` }
    ];
    if (r2) {
      row.push({ text: `${r2.name}`, callback_data: `featured:${r2.id}` });
    }
    rows.push(row);
  }
  return rows;
}

function truncateUTF8(str, maxBytes) {
  if (!str) return "";
  const buf = Buffer.from(String(str), "utf8");
  if (buf.length <= maxBytes) {
    return str;
  }
  let sliceLen = maxBytes;
  while (sliceLen > 0 && (buf[sliceLen] & 0xc0) === 0x80) {
    sliceLen--;
  }
  return buf.slice(0, sliceLen).toString("utf8");
}

function makeSearchCallbackData(keyword) {
  const safeKw = truncateUTF8(keyword, 57);
  return `search:${safeKw}`;
}

async function getTrendingKeyboard() {
  const mainKeys = getMainKeyboard().inline_keyboard;
  const breaking = getBreakingNews();

  // 1. All 20 Hot Topics (4 buttons per row grid)
  const rows = [...mainKeys];

  // 2. Breaking News (if any)
  if (breaking.length > 0) {
    rows.push([{ text: "📰 BREAKING NEWS", callback_data: "none" }]);
    for (const news of breaking) {
      const displayNews = await translateText(news, "en");
      rows.push([{ text: `📰 ${displayNews}`, url: `https://www.google.com/search?q=${encodeURIComponent(news)}` }]);
    }
  }

  // 3. Refresh Trending button (full width)
  rows.push([{ text: "🔄 REFRESH TRENDING", callback_data: "refresh_trending" }]);

  // 4. 4 Permanent Category Buttons (2 per row) directly below REFRESH TRENDING
  rows.push([
    { text: "🎮 Play Games", callback_data: "cat:games" },
    { text: "🤖 AI", callback_data: "cat:ai_tools" }
  ]);
  rows.push([
    { text: "📚 Short Stories", callback_data: "cat:stories" },
    { text: "🔬 Scientific Paper", callback_data: "cat:papers" }
  ]);

  return { inline_keyboard: rows };
}

async function renderSearchResults(chatId, query, messageId = null) {
  recordUserSearch(chatId, query);
  const results = searchResources(query);
  const displayQuery = await translateText(query, "en");

  if (!messageId) {
    await sendMessageSafe(chatId,
      `🔍 <b>Searching:</b> <code>"${escapeHTML(displayQuery)}"</code>`,
      {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      }
    );
  }

  if (results.length > 0) {
    const rows = results.map(ch => ([
      { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
    ]));
    rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

    const text = `🔍 <b>Search Results for:</b> <code>"${escapeHTML(displayQuery)}"</code>\n\nFound <b>${results.length}</b> resource(s):`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    };

    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  } else {
    const trendingKeys = await getTrendingKeyboard();
    const text = `🔍 <b>No resources found for:</b> <code>"${escapeHTML(displayQuery)}"</code>\n\nTry searching with different keywords or explore hot topics below 👇`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: trendingKeys,
    };

    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  }
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
      { name: "🎮 Play Games — @swag912", url: "https://t.me/swag912?start=xbiso" },
      { name: "🎮 Play Games — @xi_8888888", url: "https://t.me/xi_8888888?start=xbiso" },
      { name: "🎮 Play Games — @lifanhuangyouxi", url: "https://t.me/lifanhuangyouxi?start=xbiso" },
      { name: "🎮 Play Games — @zest110", url: "https://t.me/zest110?start=xbiso" },
      { name: "🎮 Play Games — @Ebpay", url: "https://t.me/Ebpay?start=xbiso" },
      { name: "🎮 Play Games — @dohnaduona", url: "https://t.me/dohnaduona?start=xbiso" },
      { name: "🎮 Play Games — @farrslgrpg", url: "https://t.me/farrslgrpg?start=xbiso" },
      { name: "🎮 Play Games — @MTXFXS", url: "https://t.me/MTXFXS?start=xbiso" },
      { name: "🎮 Play Games — @huangyou_A", url: "https://t.me/huangyou_A?start=xbiso" },
      { name: "🎮 Play Games — @dailikaixian", url: "https://t.me/dailikaixian?start=xbiso" },
      { name: "🎮 Play Games — @cosplaytele2", url: "https://t.me/cosplaytele2?start=xbiso" },
      { name: "🎮 Play Games — @TT95333", url: "https://t.me/TT95333?start=xbiso" },
      { name: "🎮 Play Games — @BTCnewsvip02", url: "https://t.me/BTCnewsvip02?start=xbiso" },
      { name: "🎮 Play Games — @bgtfp", url: "https://t.me/bgtfp?start=xbiso" },
      { name: "🎮 Play Games — @rgggg", url: "https://t.me/rgggg?start=xbiso" }
    ]
  },
  ai_tools: {
    title: "🤖 AI",
    items: [
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
      { name: "🤖 AI — @woaicja", url: "https://t.me/woaicja?start=xbiso" },
      { name: "🤖 AI — @piracy6", url: "https://t.me/piracy6?start=xbiso" },
      { name: "🤖 AI — @yumengai", url: "https://t.me/yumengai?start=xbiso" },
      { name: "🤖 AI — @ph_dcgroup", url: "https://t.me/ph_dcgroup?start=xbiso" },
      { name: "🤖 AI — @GodlyNews1", url: "https://t.me/GodlyNews1?start=xbiso" },
      { name: "🤖 AI — @me888888888888", url: "https://t.me/me888888888888?start=xbiso" },
      { name: "🤖 AI — @FinanceNewsDaily", url: "https://t.me/FinanceNewsDaily?start=xbiso" }
    ]
  },
  stories: {
    title: "📚 Short Stories",
    items: [
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
      { name: "📚 Short Stories — @ysxs8", url: "https://t.me/ysxs8?start=xbiso" },
      { name: "📚 Short Stories — @Flymirai", url: "https://t.me/Flymirai?start=xbiso" },
      { name: "📚 Short Stories — @SQXiaoShuo", url: "https://t.me/SQXiaoShuo?start=xbiso" },
      { name: "📚 Short Stories — @douban_read", url: "https://t.me/douban_read?start=xbiso" },
      { name: "📚 Short Stories — @qsxiaoshuo", url: "https://t.me/qsxiaoshuo?start=xbiso" },
      { name: "📚 Short Stories — @JGBOOK", url: "https://t.me/JGBOOK?start=xbiso" }
    ]
  },
  papers: {
    title: "🔬 Scientific Paper",
    items: [
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
      { name: "🔬 Scientific Paper — @xiaoshuwu", url: "https://t.me/xiaoshuwu?start=xbiso" },
      { name: "🔬 Scientific Paper — @jiufangyum", url: "https://t.me/jiufangyum?start=xbiso" },
      { name: "🔬 Scientific Paper — @DuyaoSS", url: "https://t.me/DuyaoSS?start=xbiso" },
      { name: "🔬 Scientific Paper — @aibuwan8", url: "https://t.me/aibuwan8?start=xbiso" },
      { name: "🔬 Scientific Paper — @GieGie777", url: "https://t.me/GieGie777?start=xbiso" },
      { name: "🔬 Scientific Paper — @The_Lord_Rings", url: "https://t.me/The_Lord_Rings?start=xbiso" }
    ]
  }
};

async function renderCategoryResources(chatId, catKey, page = 1, messageId = null) {
  const category = CATEGORIES[catKey];
  if (!category) return;

  const title = category.title;
  const items = category.items;
  const itemsPerPage = 10;
  const totalPages = Math.ceil(items.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = items.slice(startIndex, startIndex + itemsPerPage);

  const rows = pageItems.map(item => [
    { text: item.name, url: item.url }
  ]);

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀ Previous", callback_data: `cat_page:${catKey}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `cat_page:${catKey}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

  const messageText = `<b>${escapeHTML(title)}</b>\n\nFound <b>${items.length}</b> resource(s):`;
  const messageOptions = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, messageText, messageOptions);
  } else {
    return await sendMessageSafe(chatId, messageText, messageOptions);
  }
}

async function renderTopicPosts(chatId, topicKey, page = 1, messageId = null) {
  const channels = CHANNELS[topicKey] || [];
  const displayTopicName = TOPIC_NAMES[topicKey] || topicKey;

  if (!channels || channels.length === 0) {
    const emptyText = `📢 <b>${escapeHTML(displayTopicName)}</b>\n\nNo posts found for this category.`;
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

  const itemsPerPage = 10;
  const totalPages = Math.ceil(channels.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageChannels = channels.slice(startIndex, startIndex + itemsPerPage);

  const rows = pageChannels.map(ch => {
    let displayTitle = String(ch.name || "").trim();
    let icon = "";
    if (displayTitle.includes("▶") || displayTitle.includes("🎬") || displayTitle.includes("🖼️") || displayTitle.includes("📄") || displayTitle.includes("📹") || displayTitle.includes("🔘")) {
      icon = "";
    } else {
      icon = "🎬 ";
    }
    const fullTitle = `${icon}${displayTitle}`.trim();
    const titleText = truncateUTF8(fullTitle, 55);
    const url = ch.url || (ch.user ? `https://t.me/${ch.user}` : "");
    return [{ text: titleText, url: url }];
  });

  // Pagination row if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀ Previous", callback_data: `topic_page:${topicKey}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `topic_page:${topicKey}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

  const messageText = `📢 <b>${escapeHTML(displayTopicName)}</b>\n\nFound <b>${channels.length}</b> post(s):`;
  const messageOptions = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, messageText, messageOptions);
  } else {
    return await sendMessageSafe(chatId, messageText, messageOptions);
  }
}

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
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
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

    if (data.startsWith("featured_page:")) {
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
    } else if (data.startsWith("search:")) {
      const keyword = data.replace("search:", "");
      await renderSearchResults(chatId, keyword, messageId);
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
}

module.exports = {
  searchResources,
  CHANNELS,
  FEATURED_RESOURCES,
  truncateUTF8,
  makeSearchCallbackData,
  escapeHTML,
  translateText,
  getMainKeyboard,
  getTrendingKeyboard,
  getPersistentKeyboard,
  getPersistentNavigationKeyboard,
  getFeaturedPosts,
  getFeaturedChannels,
  renderFeaturedCardPosts,
  renderFeaturedChannelPosts,
  clearUserHistory,
  videoFileIdCache,
  saveVideoCache,
  getCachedFileId,
  acquireUserLock,
  releaseUserLock,
};

