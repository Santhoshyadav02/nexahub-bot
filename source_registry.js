const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "source_registry.json");

// Initial 10 Curated Telegram Source Channels provided by the user
const INITIAL_SOURCES = [
  { keyword: "Romantic Vibe", name: "Romantic Vibe", invite_url: "https://t.me/+AGVRDJ6c7M9lMGRh" },
  { keyword: "Dating", name: "Dating", invite_url: "https://t.me/+I3z-vJdRRV8xZDlh" },
  { keyword: "Romance", name: "Romance", invite_url: "https://t.me/+3g-HIjq_KgtkZDE5" },
  { keyword: "Crotch", name: "Crotch", invite_url: "https://t.me/+8MHLLZRd1L5jMzhh" },
  { keyword: "Mosa", name: "Mosa", invite_url: "https://t.me/+hdaykD30jbdhNzlh" },
  { keyword: "Bunny Girl Cosplay Date", name: "Bunny Girl Cosplay Date", invite_url: "https://t.me/+5jGUuJ_HWLg5ZWRh" },
  { keyword: "Lustful Hostess", name: "Lustful Hostess", invite_url: "https://t.me/+IypAk6ypLrM1Y2Rh" },
  { keyword: "Concubine", name: "Concubine", invite_url: "https://t.me/+McyWlyEXgEdkY2Jh" },
  { keyword: "Saki Mizumi", name: "Saki Mizumi", invite_url: "https://t.me/+Kr4JkikOPjtmNTNh" },
  { keyword: "A Muse", name: "A Muse", invite_url: "https://t.me/+e-JQoCwT8wMyM2Zh" }
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
      const existing = this.sources.find(s => s.keyword === src.keyword || s.invite_url === src.invite_url);
      if (!existing) {
        this.sources.push({
          id: `src_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          keyword: src.keyword,
          name: src.name,
          invite_url: src.invite_url,
          chat_id: null,
          created_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString()
        });
        modified = true;
      }
    }
    if (modified) {
      this.saveData();
    }
  }

  saveData() {
    try {
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

  bindChatIdToSource(chatId, channelTitle = "") {
    const strChatId = String(chatId);
    let source = this.sources.find(s => String(s.chat_id) === strChatId);
    if (source) return source;

    if (channelTitle) {
      const titleLower = channelTitle.trim().toLowerCase();
      source = this.sources.find(s => s.name.trim().toLowerCase() === titleLower || s.keyword.trim().toLowerCase() === titleLower);
    }

    if (!source) {
      source = this.sources.find(s => !s.chat_id);
    }

    if (source) {
      source.chat_id = strChatId;
      if (channelTitle) source.name = channelTitle;
      this.saveData();
      console.log(`🔗 Bound chat_id [${strChatId}] to Source [${source.name}] (Keyword: ${source.keyword})`);
    } else {
      const newKw = channelTitle || `Channel_${strChatId.replace("-100", "")}`;
      source = this.registerSource(newKw, "", newKw, strChatId);
    }
    return source;
  }

  processChannelPost(msg) {
    if (!msg || !msg.chat) return null;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const uniqueHash = `${chatId}_${messageId}`;

    const existingPostIndex = this.posts.findIndex(p => p.unique_hash === uniqueHash);

    const source = this.bindChatIdToSource(chatId, msg.chat.title || "");

    let text = msg.text || msg.caption || "";
    let mediaType = "text";
    let duration = null;

    if (msg.video) {
      mediaType = "video";
      if (msg.video.duration) {
        const durSec = msg.video.duration;
        const mins = Math.floor(durSec / 60);
        const secs = durSec % 60;
        duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
    } else if (msg.photo) {
      mediaType = "photo";
    }

    let displayTitle = text.split("\n")[0] || `${source ? source.name : "Post"} Update`;
    displayTitle = displayTitle.trim();
    if (displayTitle.length > 80) {
      displayTitle = displayTitle.substring(0, 77) + "...";
    }

    let icon = "🎬 ";
    if (mediaType === "video") {
      icon = duration ? `▶️ [${duration}] ` : "▶️ ";
    } else if (mediaType === "photo") {
      icon = "🖼️ ";
    }

    const fullTitle = `${icon}${displayTitle}`;

    let cleanChatId = chatId.startsWith("-100") ? chatId.substring(4) : chatId.replace("-", "");
    let telegramUrl = msg.chat.username 
      ? `https://t.me/${msg.chat.username}/${messageId}`
      : `https://t.me/c/${cleanChatId}/${messageId}`;

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
      telegram_url: telegramUrl,
      views: "1.2K",
      published_at: new Date(msg.date * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    if (existingPostIndex !== -1) {
      this.posts[existingPostIndex] = {
        ...this.posts[existingPostIndex],
        ...postRecord,
        id: this.posts[existingPostIndex].id
      };
      console.log(`🔄 Updated existing channel_post [${uniqueHash}] for keyword "${postRecord.keyword}"`);
      this.saveData();
      return { post: this.posts[existingPostIndex], isNew: false };
    } else {
      this.posts.unshift(postRecord);
      if (source) {
        source.last_checked_at = new Date().toISOString();
      }
      console.log(`📥 Ingested NEW channel_post [${uniqueHash}] for keyword "${postRecord.keyword}": "${fullTitle}"`);
      this.saveData();
      return { post: postRecord, isNew: true };
    }
  }

  getPostsForKeyword(keyword) {
    if (!keyword) return [];
    const kwLower = keyword.trim().toLowerCase();
    return this.posts.filter(p => p.keyword.trim().toLowerCase() === kwLower || p.channel_name.trim().toLowerCase() === kwLower);
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

  getAllSources() {
    return this.sources;
  }
}

const instance = new SourceRegistry();
module.exports = instance;
