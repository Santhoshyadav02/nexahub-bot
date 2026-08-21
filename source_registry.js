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

  applyRollingRetention(maxPerTopic = 20) {
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
      this.applyRollingRetention(20);
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
      invite_url: inviteUrl,
      username: username,
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

  getSourceByKeyword(keyword) {
    if (!keyword) return null;
    const kwLower = keyword.trim().toLowerCase();
    return this.sources.find(s => s.keyword.trim().toLowerCase() === kwLower || s.name.trim().toLowerCase() === kwLower);
  }

  getPostsForKeyword(keyword) {
    if (!keyword) return [];
    const kwLower = keyword.trim().toLowerCase();
    return this.posts.filter(p => p.keyword.trim().toLowerCase() === kwLower || p.channel_name.trim().toLowerCase() === kwLower);
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

  getAllSources() {
    return this.sources;
  }
}

const instance = new SourceRegistry();
module.exports = instance;
