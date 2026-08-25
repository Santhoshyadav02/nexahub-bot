const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "source_registry.json");

// Initial 10 Curated Telegram Source Channels provided by the user
const INITIAL_SOURCES = [
  { keyword: "Romantic Vibe", name: "Romantic Vibe", username: "ccsfvk", public_url: "https://t.me/ccsfvk" },
  { keyword: "Dating", name: "Dating", username: "cccsefk", public_url: "https://t.me/cccsefk" },
  { keyword: "Romance", name: "Romance", username: "e5brygh", public_url: "https://t.me/e5brygh" },
  { keyword: "Crotch", name: "Crotch", username: "ccdjxc", public_url: "https://t.me/ccdjxc" },
  { keyword: "Mosa", name: "Mosa", username: "vsdxda", public_url: "https://t.me/vsdxda" },
  { keyword: "Bunny Girl Cosplay Date", name: "Bunny Girl Cosplay Date", username: "tfccdet", public_url: "https://t.me/tfccdet" },
  { keyword: "Lustful Hostess", name: "Lustful Hostess", username: "sfgfem", public_url: "https://t.me/sfgfem" },
  { keyword: "Concubine", name: "Concubine", username: "ddkicr", public_url: "https://t.me/ddkicr" },
  { keyword: "Saki Mizumi", name: "Saki Mizumi", username: "cccddghhgf", public_url: "https://t.me/cccddghhgf" },
  { keyword: "A Muse", name: "A Muse", username: "bzd4wrf", public_url: "https://t.me/bzd4wrf" }
];

class SourceRegistry {
  constructor() {
    this.sources = [];
    this.posts = [];
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, "utf8");
        const parsed = JSON.parse(raw);
        this.sources = parsed.sources || [];
        this.posts = parsed.posts || [];
      } else {
        this.initDefaultData();
      }
    } catch (err) {
      console.error("⚠️ Error loading source_registry.json, reinitializing:", err.message);
      this.initDefaultData();
    }
    this.ensureInitialSources();
  }

  initDefaultData() {
    this.sources = [];
    this.posts = [];
    this.saveData();
  }

  ensureInitialSources() {
    let modified = false;
    for (const src of INITIAL_SOURCES) {
      const existing = this.sources.find(s => s.keyword === src.keyword);
      if (!existing) {
        this.sources.push({
          id: `src_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          keyword: src.keyword,
          name: src.name,
          username: src.username || null,
          public_url: src.public_url || null,
          invite_url: src.invite_url || null,
          chat_id: null,
          created_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString()
        });
        modified = true;
      } else {
        if (src.username && existing.username !== src.username) {
          existing.username = src.username;
          existing.public_url = src.public_url;
          delete existing.invite_url;
          modified = true;
        }
        if (src.invite_url && existing.invite_url !== src.invite_url) {
          existing.invite_url = src.invite_url;
          modified = true;
        }
      }
    }

    // Sanitize and update existing post records with source username/invite_url metadata
    for (const post of this.posts) {
      const src = this.sources.find(s => s.keyword === post.keyword || s.name === post.channel_name);
      if (src) {
        if (src.username) {
          if (post.username !== src.username || !post.telegram_url || !post.telegram_url.includes(src.username)) {
            post.username = src.username;
            post.telegram_url = `https://t.me/${src.username}/${post.message_id || ""}`;
            delete post.invite_url;
            modified = true;
          }
        } else if (src.invite_url) {
          if (post.invite_url !== src.invite_url || !post.telegram_url) {
            post.invite_url = src.invite_url;
            post.telegram_url = src.invite_url;
            modified = true;
          }
        }
      }
    }

    if (modified) {
      this.saveData();
    }
  }

  applyRollingRetention(maxPerTopic = 50) {
    const retainedPosts = [];
    const grouped = {};

    for (const post of this.posts) {
      const key = String(post.keyword || post.channel_name || "General").trim();
      if (!grouped[key]) {
        grouped[key] = [];
      }
      const isDup = grouped[key].some(p => 
        (p.unique_hash && post.unique_hash && p.unique_hash === post.unique_hash) ||
        (p.telegram_url && post.telegram_url && p.telegram_url === post.telegram_url) ||
        (p.message_id && post.message_id && String(p.message_id) === String(post.message_id))
      );
      if (!isDup) {
        grouped[key].push(post);
      }
    }

    for (const key of Object.keys(grouped)) {
      const postsForGroup = grouped[key];
      postsForGroup.sort((a, b) => {
        const aIsLegacy = a.message_id && parseInt(a.message_id, 10) > 10000;
        const bIsLegacy = b.message_id && parseInt(b.message_id, 10) > 10000;
        if (aIsLegacy !== bIsLegacy) {
          return aIsLegacy ? 1 : -1;
        }

        const dateA = a.published_at ? new Date(a.published_at).getTime() : (a.date ? a.date * 1000 : 0);
        const dateB = b.published_at ? new Date(b.published_at).getTime() : (b.date ? b.date * 1000 : 0);
        if (dateA !== dateB && dateA > 0 && dateB > 0) {
          return dateB - dateA;
        }
        return (b.message_id || 0) - (a.message_id || 0);
      });
      const sliced = postsForGroup.slice(0, maxPerTopic);
      retainedPosts.push(...sliced);
    }

    this.posts = retainedPosts;
  }

  saveData() {
    try {
      this.applyRollingRetention(50);
      const payload = {
        updated_at: new Date().toISOString(),
        sources: this.sources,
        posts: this.posts
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      console.error("❌ Error saving source_registry.json:", err.message);
    }
  }

  registerSource(keyword, inviteUrl, name, chatId = null) {
    let existing = this.sources.find(s => (inviteUrl && s.invite_url === inviteUrl) || (chatId && String(s.chat_id) === String(chatId)));
    if (existing) {
      if (chatId && String(existing.chat_id) !== String(chatId)) {
        existing.chat_id = String(chatId);
        this.saveData();
      }
      return existing;
    }

    const newSource = {
      id: `src_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      keyword: keyword,
      name: name || keyword,
      invite_url: inviteUrl || "",
      chat_id: chatId ? String(chatId) : null,
      created_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString()
    };
    this.sources.push(newSource);
    this.saveData();
    return newSource;
  }

  bindChatIdToSource(chatId, channelTitle = "", targetKeyword = null) {
    const strChatId = String(chatId);
    let source = this.sources.find(s => String(s.chat_id) === strChatId);
    if (source) return source;

    if (targetKeyword) {
      const targetKwLower = String(targetKeyword).trim().toLowerCase();
      source = this.sources.find(s => s.keyword.trim().toLowerCase() === targetKwLower || s.name.trim().toLowerCase() === targetKwLower);
    }

    if (!source && channelTitle) {
      const titleLower = String(channelTitle).trim().toLowerCase();
      source = this.sources.find(s => s.name.trim().toLowerCase() === titleLower || s.keyword.trim().toLowerCase() === titleLower);
    }

    if (source) {
      source.chat_id = strChatId;
      this.saveData();
      console.log(`🔗 Bound chat_id [${strChatId}] to Source [${source.name}] (Keyword: ${source.keyword})`);
    } else {
      const newKw = channelTitle || `Channel_${strChatId.replace("-100", "")}`;
      source = this.registerSource(newKw, "", newKw, strChatId);
    }
    return source;
  }

  processChannelPost(msg, explicitKeyword = null) {
    if (!msg || !msg.chat) return null;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const uniqueHash = `${chatId}_${messageId}`;

    const source = this.bindChatIdToSource(chatId, msg.chat.title || "", explicitKeyword);
    const targetKeyword = source ? source.keyword : (explicitKeyword || "General");
    const targetChannelName = source ? source.name : (msg.chat.title || "Telegram Channel");

    let text = msg.text || msg.caption || "";
    let mediaType = msg.media_type || "text";
    let duration = msg.duration || null;
    let videoFileId = msg.video_file_id || msg.file_id || null;

    if (msg.video) {
      mediaType = "video";
      if (msg.video.file_id) videoFileId = msg.video.file_id;
      if (msg.video.duration) {
        const durSec = msg.video.duration;
        const mins = Math.floor(durSec / 60);
        const secs = durSec % 60;
        duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
    } else if (msg.photo) {
      mediaType = "photo";
    } else if (msg.media_type === "video" || msg.video_file_id) {
      mediaType = "video";
    }

    let rawTextTitle = text.split("\n")[0] ? text.split("\n")[0].trim() : "";
    let displayTitle = rawTextTitle.length > 0 ? (rawTextTitle.length > 80 ? rawTextTitle.substring(0, 77) + "..." : rawTextTitle) : "제목 없음";
    const fullTitle = displayTitle;

    let cleanChatId = chatId.startsWith("-100") ? chatId.substring(4) : chatId.replace("-", "");
    let inviteUrl = source ? source.invite_url : null;
    let username = msg.chat.username || (source ? source.username : null);

    let telegramUrl = "";
    if (username) {
      telegramUrl = `https://t.me/${username}/${messageId}`;
    } else if (inviteUrl) {
      telegramUrl = inviteUrl;
    } else {
      telegramUrl = `https://t.me/c/${cleanChatId}/${messageId}`;
    }

    const existingPostIndex = this.posts.findIndex(p => 
      (p.unique_hash && p.unique_hash === uniqueHash) ||
      (p.telegram_url && telegramUrl && p.telegram_url === telegramUrl) ||
      (p.message_id && String(p.message_id) === String(messageId) && (p.keyword === targetKeyword || p.channel_name === targetChannelName))
    );

    const postRecord = {
      id: `post_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      source_id: source ? source.id : "unknown",
      keyword: source ? source.keyword : "General",
      channel_name: source ? source.name : (msg.chat.title || "Telegram Channel"),
      chat_id: chatId,
      message_id: messageId,
      unique_hash: uniqueHash,
      title: fullTitle,
      caption: text,
      media_type: mediaType,
      duration: duration,
      video_file_id: videoFileId,
      invite_url: inviteUrl,
      username: username,
      telegram_url: telegramUrl,
      views: "1.2K",
      published_at: new Date(msg.date * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    const isDebug = process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug";

    if (existingPostIndex !== -1) {
      this.posts[existingPostIndex] = {
        ...this.posts[existingPostIndex],
        ...postRecord,
        id: this.posts[existingPostIndex].id
      };
      if (isDebug) {
        console.log("[INGEST]");
        console.log(`channel=${targetChannelName}`);
        console.log(`message_id=${messageId}`);
        console.log(`media_type=${mediaType}`);
        console.log(`telegram_url=${telegramUrl}`);
      }
      this.saveData();
      return { post: this.posts[existingPostIndex], isNew: false };
    } else {
      this.posts.unshift(postRecord);
      if (source) {
        source.last_checked_at = new Date().toISOString();
      }
      if (isDebug) {
        console.log("[INGEST]");
        console.log(`channel=${targetChannelName}`);
        console.log(`message_id=${messageId}`);
        console.log(`media_type=${mediaType}`);
        console.log(`telegram_url=${telegramUrl}`);
      } else {
        console.log(`📥 [INGEST] channel=${targetChannelName} msgId=${messageId} type=${mediaType}`);
      }
      this.saveData();
      return { post: postRecord, isNew: true };
    }
  }

  resolveKeyword(rawKeyword) {
    if (!rawKeyword) return "";
    let kwLower = String(rawKeyword).trim().toLowerCase();

    // Strip leading emojis/icons from UI category labels
    const cleanKw = kwLower.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s▶️🎬🖼️🔥⭐🎤👁️🖤⚽🎲💃👑📰🚨📈🌎🇰🇷🏙️💬🎵💻🤖💰❤️✨👀🌟🎯📱]+/gu, "").trim();

    // Category mapping for English and Korean UI labels
    const CATEGORY_MAP = {
      // English card mappings
      "myanmar": "Romantic Vibe",
      "evergrande troupe": "Dating",
      "myanmar women": "Romance",
      "sister snake": "Crotch",
      "has work": "Mosa",
      "bullying & sex": "Bunny Girl Cosplay Date",
      "da ci ge": "Lustful Hostess",
      "senior year love story": "Concubine",
      "sichuan mother & son": "Saki Mizumi",
      "hu siyuan": "A Muse",
      "kept lover": "Romantic Vibe",
      "didi proxy operation": "Dating",

      // Korean UI mappings (from previous requirements / fallbacks)
      "아이돌 열애 루머": "Dating",
      "케이팝 열애설": "Romantic Vibe",
      "k-pop 열애설": "Romantic Vibe",
      "비밀 연애": "Dating",
      "연예인 결별": "Crotch",
      "열애 논란": "Mosa",
      "비밀 커플": "Bunny Girl Cosplay Date",
      "바이럴 로맨스": "Lustful Hostess",
      "럽스타그램": "Concubine",
      "결혼 루머": "Saki Mizumi",
      "연예계 스캔들": "A Muse"
    };

    return CATEGORY_MAP[cleanKw] || CATEGORY_MAP[kwLower] || rawKeyword;
  }

  getSourceByKeyword(keyword) {
    if (!keyword) return null;
    const resolved = this.resolveKeyword(keyword);
    const kwLower = resolved.trim().toLowerCase();
    return this.sources.find(s => (s.keyword && s.keyword.trim().toLowerCase() === kwLower) || (s.name && s.name.trim().toLowerCase() === kwLower));
  }

  enforceRollingRetention(targetKeyword) {
    if (!targetKeyword) return;
    const resolved = this.resolveKeyword(targetKeyword);
    const kwLower = resolved.trim().toLowerCase();

    const source = this.sources.find(s => 
      (s.keyword && s.keyword.trim().toLowerCase() === kwLower) || 
      (s.name && s.name.trim().toLowerCase() === kwLower) ||
      (s.username && s.username.trim().toLowerCase() === kwLower)
    );

    const targetKwLower = source ? source.keyword.trim().toLowerCase() : kwLower;

    // Find all valid video posts belonging to this source
    const sourcePosts = this.posts.filter(p => {
      const pKw = (p.keyword || "").trim().toLowerCase();
      const pChan = (p.channel_name || "").trim().toLowerCase();
      const pUser = (p.username || "").trim().toLowerCase();
      const pSrcId = p.source_id;
      if (source && pSrcId && pSrcId === source.id) return true;
      if (source && source.username && pUser === source.username.trim().toLowerCase()) return true;
      return pKw === targetKwLower || pChan === targetKwLower || pUser === targetKwLower;
    });

    const validVideos = sourcePosts.filter(p => {
      if (p.media_type !== "video") return false;
      if (!p.message_id) return false;
      if (!p.telegram_url || !p.telegram_url.startsWith("http")) return false;
      return true;
    });

    // Sort valid videos newest first by message_id descending, then published_at descending
    validVideos.sort((a, b) => {
      const idA = parseInt(a.message_id, 10) || 0;
      const idB = parseInt(b.message_id, 10) || 0;
      if (idA !== idB) return idB - idA;
      const dateA = new Date(a.published_at || a.date || 0).getTime();
      const dateB = new Date(b.published_at || b.date || 0).getTime();
      return dateB - dateA;
    });

    // If valid videos count > 40, retain newest 40 and evict older posts for this source
    if (validVideos.length > 40) {
      const retained40Set = new Set(validVideos.slice(0, 40).map(p => p.id));
      const evictedCount = validVideos.length - 40;

      this.posts = this.posts.filter(p => {
        const pKw = (p.keyword || "").trim().toLowerCase();
        const pChan = (p.channel_name || "").trim().toLowerCase();
        const pUser = (p.username || "").trim().toLowerCase();
        const pSrcId = p.source_id;
        let isMatch = pKw === targetKwLower || pChan === targetKwLower || pUser === targetKwLower;
        if (source) {
          if (pSrcId && pSrcId === source.id) isMatch = true;
          if (source.username && pUser === source.username.trim().toLowerCase()) isMatch = true;
        }
        if (!isMatch) return true;
        return retained40Set.has(p.id);
      });

      if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
        console.log(`🧹 Rolling 40 Retention: Retained 40 newest valid videos for "${targetKeyword}", evicted ${evictedCount} older posts.`);
      }
      this.saveData();
    }
  }

  getPostsForKeyword(rawKeyword, videoOnly = false) {
    if (!rawKeyword) return [];
    const resolved = this.resolveKeyword(rawKeyword);
    let targetKwLower = resolved.trim().toLowerCase();

    const source = this.sources.find(s => (s.keyword && s.keyword.trim().toLowerCase() === targetKwLower) || (s.name && s.name.trim().toLowerCase() === targetKwLower));

    const allDbPostsForSource = this.posts.filter(p => {
      const pKw = (p.keyword || "").trim().toLowerCase();
      const pChan = (p.channel_name || "").trim().toLowerCase();
      const pSrcId = p.source_id;
      if (source && pSrcId && pSrcId === source.id) return true;
      if (pKw === targetKwLower || pChan === targetKwLower) return true;
      if (source && source.username && p.username && p.username.trim().toLowerCase() === source.username.trim().toLowerCase()) return true;
      return false;
    });

    const isValidVideoRecord = p => {
      if (!p) return false;
      if (p.media_type !== "video") return false;
      if (!p.message_id || String(p.message_id).trim() === "") return false;
      if (!p.telegram_url || !p.telegram_url.startsWith("http")) return false;
      return true;
    };

    const matchedPosts = allDbPostsForSource.filter(p => {
      if (videoOnly) {
        if (!isValidVideoRecord(p)) return false;
      }
      return true;
    });

    const uniquePosts = [];
    const seenKeys = new Set();

    for (const p of matchedPosts) {
      const uid = p.unique_hash || (p.chat_id && p.message_id ? `${p.chat_id}_${p.message_id}` : p.telegram_url || p.id);
      if (!seenKeys.has(uid)) {
        seenKeys.add(uid);
        uniquePosts.push(p);
      }
    }

    uniquePosts.sort((a, b) => {
      const idA = parseInt(a.message_id, 10) || 0;
      const idB = parseInt(b.message_id, 10) || 0;
      if (idA !== idB) return idB - idA;
      const dateA = new Date(a.published_at || a.date || 0).getTime();
      const dateB = new Date(b.published_at || b.date || 0).getTime();
      return dateB - dateA;
    });

    const finalReturnedPosts = uniquePosts.slice(0, 40);

    const latestMsgId = uniquePosts[0] ? uniquePosts[0].message_id : "N/A";
    const oldestRetainedMsgId = uniquePosts[uniquePosts.length - 1] ? uniquePosts[uniquePosts.length - 1].message_id : "N/A";
    const dupCount = matchedPosts.length - uniquePosts.length;

    if (process.env.DEBUG === "true" || process.env.LOG_LEVEL === "debug") {
      console.log(`Category requested: ${rawKeyword}`);
      console.log(`Resolved keyword: ${resolved}`);
      console.log(`Resolved channel/source: ${source ? source.name || source.username || source.id : resolved}`);
      console.log(`Total DB records: ${allDbPostsForSource.length}`);
      console.log(`Total valid video records: ${uniquePosts.length}`);
      console.log(`Duplicate records: ${dupCount}`);
      console.log(`Latest Telegram message ID: ${latestMsgId}`);
      console.log(`Oldest retained message ID: ${oldestRetainedMsgId}`);
      console.log(`Posts eligible for display: ${uniquePosts.length}`);
      console.log(`Posts returned by API: ${finalReturnedPosts.length}`);
      console.log(`Posts rendered by UI: ${finalReturnedPosts.length}`);
    }

    return finalReturnedPosts;
  }

  searchPosts(query) {
    if (!query || typeof query !== "string") return [];
    const qLower = query.trim().toLowerCase();
    if (!qLower) return [];

    return this.posts.filter(p => {
      const titleLower = (p.title || "").toLowerCase();
      const captionLower = (p.caption || "").toLowerCase();
      const kwLower = (p.keyword || "").toLowerCase();
      const chanLower = (p.channel_name || "").toLowerCase();

      return titleLower.includes(qLower) || 
             captionLower.includes(qLower) || 
             kwLower.includes(qLower) || 
             chanLower.includes(qLower);
    });
  }

  getTopTrendingVideos(limit = 10) {
    const videoPosts = this.posts.filter(p => p.media_type === "video" || p.duration);
    if (videoPosts.length > 0) {
      return videoPosts.slice(0, limit);
    }
    return this.posts.slice(0, limit);
  }

  getPostById(postId) {
    return this.posts.find(p => p.id === postId || p.unique_hash === postId);
  }

  getLatestRealMessageId(keyword) {
    if (!keyword) return 0;
    const posts = this.getPostsForKeyword(keyword);
    const realPosts = posts.filter(p => p.message_id && parseInt(p.message_id, 10) < 10000);
    if (realPosts.length === 0) return 0;
    return Math.max(...realPosts.map(p => parseInt(p.message_id, 10)));
  }

  getAllSources() {
    return this.sources;
  }
}

const instance = new SourceRegistry();
module.exports = instance;
