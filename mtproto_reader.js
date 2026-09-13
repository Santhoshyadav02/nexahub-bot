require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const sourceRegistry = require("./source_registry");

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", username: "ccsfvk", public_url: "https://t.me/ccsfvk", chat_id: "-1005563024409" },
  { name: "Dating", username: "cccsefk", public_url: "https://t.me/cccsefk", chat_id: "-1005362445410" },
  { name: "Romance", username: "e5brygh", public_url: "https://t.me/e5brygh", chat_id: "-1005491187683" },
  { name: "Crotch", username: "ccdjxc", public_url: "https://t.me/ccdjxc", chat_id: "-1005296875877" },
  { name: "Mosa", username: "vsdxda", public_url: "https://t.me/vsdxda", chat_id: "-1005427855016" },
  { name: "Bunny Girl Cosplay Date", username: "tfccdet", public_url: "https://t.me/tfccdet", chat_id: "-1005353472623" },
  { name: "Lustful Hostess", username: "sfgfem", public_url: "https://t.me/sfgfem", chat_id: "-1005591987853" },
  { name: "Concubine", username: "ddkicr", public_url: "https://t.me/ddkicr", chat_id: "-1005394162064" },
  { name: "Saki Mizumi", username: "cccddghhgf", public_url: "https://t.me/cccddghhgf", chat_id: "-1005356656249" },
  { name: "A Muse", username: "bzd4wrf", public_url: "https://t.me/bzd4wrf", chat_id: "-1005476708057" }
];

// Upper bounds for single MTProto calls so one hung request can never leave
// isSyncing / a publish cycle stuck forever.
const CONNECT_TIMEOUT_MS = 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;
const ENTITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTITY_CACHE_SIZE = 500;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAuthKeyDuplicatedError(err) {
  if (!err) return false;
  return (err.message && err.message.includes("AUTH_KEY_DUPLICATED")) || err.errorMessage === "AUTH_KEY_DUPLICATED";
}

/**
 * Returns the FloodWait duration in seconds, or 0 if err is not a FloodWait.
 */
function getFloodWaitSeconds(err) {
  if (!err) return 0;
  const isFlood = err.className === "FloodWaitError" ||
    (err.constructor && err.constructor.name === "FloodWaitError") ||
    (typeof err.errorMessage === "string" && err.errorMessage.startsWith("FLOOD_WAIT")) ||
    (typeof err.message === "string" && /FLOOD_WAIT|A wait of \d+ seconds is required/i.test(err.message));
  if (!isFlood) return 0;
  if (Number.isFinite(err.seconds) && err.seconds > 0) return err.seconds;
  const match = String(err.message || "").match(/(\d+)\s*seconds?/i) || String(err.errorMessage || "").match(/FLOOD_WAIT_(\d+)/);
  return match ? parseInt(match[1], 10) : 60;
}

class MTProtoChannelReader {
  constructor() {
    if (MTProtoChannelReader.instance) {
      return MTProtoChannelReader.instance;
    }

    MTProtoChannelReader.constructionCount = (MTProtoChannelReader.constructionCount || 0) + 1;
    console.log(`📡 [MTProtoChannelReader] Initializing singleton reader instance (Count: ${MTProtoChannelReader.constructionCount})...`);

    this.apiId = parseInt(String(process.env.TELEGRAM_API_ID || "0").trim(), 10) || 0;
    this.apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
    this.sessionString = String(process.env.TELEGRAM_SESSION_STRING || "").trim();
    this.session = null;
    this._client = null;
    this.authMode = "USER_SESSION";
    this.isBotSession = null;
    this.connectingPromise = null;
    this.fatalError = null;
    this.floodWaitUntil = null;
    this.entityCache = new Map(); // key -> { entity, cachedAt }

    MTProtoChannelReader.instance = this;
  }

  hasCredentials() {
    return Boolean(this.sessionString && this.apiId && this.apiHash);
  }

  /**
   * The GramJS client is created lazily: constructing TelegramClient throws
   * when TELEGRAM_API_ID / TELEGRAM_API_HASH are missing, and this module is
   * required at bot startup. Returns null when credentials are incomplete.
   */
  get client() {
    if (!this._client && this.hasCredentials()) {
      try {
        this.session = new StringSession(this.sessionString);
      } catch (e) {
        this.fatalError = `TELEGRAM_SESSION_STRING is malformed (${e.message}). Regenerate it with generate_mtproto_session.js.`;
        console.error(`❌ [MTProtoChannelReader] ${this.fatalError}`);
        return null;
      }
      this._client = new TelegramClient(this.session, this.apiId, this.apiHash, {
        connectionRetries: 5,
      });
    }
    return this._client;
  }

  set client(value) {
    this._client = value;
  }

  /**
   * FloodWait bookkeeping shared by sync and publishing: once Telegram asks
   * us to wait, every MTProto consumer stays quiet until the wait is over.
   */
  noteFloodWait(err) {
    const seconds = getFloodWaitSeconds(err);
    if (!seconds) return 0;
    this.floodWaitUntil = Date.now() + seconds * 1000;
    console.warn(`⚠️ [MTProtoChannelReader] FloodWait: Telegram requires a ${seconds}s pause. MTProto calls suspended until ${new Date(this.floodWaitUntil).toISOString()}.`);
    return seconds;
  }

  isFloodWaitActive() {
    return Boolean(this.floodWaitUntil && Date.now() < this.floodWaitUntil);
  }

  async getCachedEntity(identifier) {
    const key = String(identifier).toLowerCase();
    const cached = this.entityCache.get(key);
    if (cached && Date.now() - cached.cachedAt < ENTITY_CACHE_TTL_MS) {
      return cached.entity;
    }
    const entity = await withTimeout(this.client.getEntity(identifier), CALL_TIMEOUT_MS, `getEntity(${identifier})`);
    if (this.entityCache.size >= MAX_ENTITY_CACHE_SIZE) {
      this.entityCache.delete(this.entityCache.keys().next().value);
    }
    this.entityCache.set(key, { entity, cachedAt: Date.now() });
    return entity;
  }

  async connect() {
    if (!this.sessionString) {
      console.log("ℹ️ GramJS MTProto reader: TELEGRAM_SESSION_STRING not configured. Skipping MTProto connection.");
      return false;
    }

    if (!this._client && (!this.apiId || !this.apiHash)) {
      console.error("❌ GramJS MTProto reader: TELEGRAM_SESSION_STRING is set but TELEGRAM_API_ID / TELEGRAM_API_HASH are missing or invalid. Skipping MTProto connection.");
      return false;
    }

    if (this.fatalError) {
      return false;
    }

    const client = this.client;
    if (!client) {
      return false;
    }

    if (client.connected) {
      return true;
    }

    if (this.isFloodWaitActive()) {
      const waitSec = Math.ceil((this.floodWaitUntil - Date.now()) / 1000);
      console.log(`ℹ️ [MTProtoChannelReader] FloodWait active (${waitSec}s remaining). Skipping connect request.`);
      return false;
    }

    if (this.backoffUntil && Date.now() < this.backoffUntil) {
      const waitSec = Math.ceil((this.backoffUntil - Date.now()) / 1000);
      console.log(`ℹ️ [MTProtoChannelReader] Connection backoff active (${waitSec}s remaining). Skipping connect request.`);
      return false;
    }

    if (this.connectingPromise) {
      return await this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      try {
        console.log("📡 MTProto client: CONNECTING...");
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "MTProto connect");

        if (typeof client.isBot === "function") {
          try {
            this.isBotSession = Boolean(await withTimeout(client.isBot(), CALL_TIMEOUT_MS, "isBot"));
          } catch (e) {
            this.isBotSession = null;
          }
        } else {
          this.isBotSession = null;
        }
        this.authMode = this.isBotSession === true ? "BOT_SESSION" : (this.isBotSession === false ? "USER_SESSION" : "UNKNOWN_SESSION");

        if (this.isBotSession === false) {
          try {
            // Cache all joined channel entities in 1 single request to avoid CheckChatInvite flood wait
            await withTimeout(client.getDialogs({ limit: 100 }), CALL_TIMEOUT_MS, "getDialogs");
          } catch (e) {
            this.noteFloodWait(e);
          }
        } else {
          console.log(`ℹ️ [MTProto] ${this.isBotSession === true ? "Bot session detected" : "Session type unverified"}. Entity-cache prefill skipped.`);
        }

        console.log("✅ MTProto client: CONNECTED");
        this.backoffUntil = null;
        return true;
      } catch (err) {
        if (isAuthKeyDuplicatedError(err)) {
          // Telegram has already invalidated this authorization key; retrying
          // can never succeed. Stop all MTProto work until the session string
          // is regenerated and the bot restarted.
          this.fatalError = "AUTH_KEY_DUPLICATED: this TELEGRAM_SESSION_STRING was used by two clients at the same time and Telegram revoked it. Generate a new session string (node generate_mtproto_session.js), update .env, and make sure only ONE process/machine uses it.";
          console.error(`❌ [MTProtoChannelReader] ${this.fatalError}`);
        } else if (getFloodWaitSeconds(err)) {
          this.noteFloodWait(err);
        } else {
          console.error("❌ MTProto client connection error:", err.message);
          this.backoffUntil = Date.now() + 5000;
        }

        try {
          await this.disconnect();
        } catch (e) {}
        return false;
      } finally {
        this.connectingPromise = null;
      }
    })();

    return await this.connectingPromise;
  }

  async disconnect() {
    try {
      const client = this._client;
      if (client) {
        console.log("🔌 Explicitly disconnecting MTProto client...");
        await withTimeout(Promise.resolve(client.disconnect()).catch(() => {}), 10000, "MTProto disconnect").catch(() => {});
        if (typeof client.destroy === "function") {
          await withTimeout(Promise.resolve(client.destroy()).catch(() => {}), 10000, "MTProto destroy").catch(() => {});
          // A destroyed GramJS client cannot reconnect; the next connect()
          // builds a fresh one from the same session string.
          if (this._client === client) {
            this._client = null;
          }
        }
      }
    } catch (e) {}
  }

  async syncAllChannels(limit = 10, saveToDisk = false) {
    if (this.isSyncing) {
      console.log("ℹ️ MTProto sync already in progress. Skipping concurrent sync request.");
      return null;
    }
    this.isSyncing = true;
    try {
      const results = [];
      const connected = await this.connect();
      if (!connected) {
        console.warn("⚠️ Cannot run MTProto sync: Client not connected.");
        return null;
      }

      console.log("📡 MTProto client: SYNC START");

      let dialogs = [];
      if (this.isBotSession === false) {
        try {
          dialogs = await withTimeout(this.client.getDialogs({ limit: 100 }), CALL_TIMEOUT_MS, "getDialogs");
          console.log(`📋 MTProto entity cache prefilled with ${dialogs.length} dialogs.`);
        } catch (e) {
          this.noteFloodWait(e);
          console.warn("⚠️ getDialogs error during entity cache prefill:", e.message);
        }
      } else {
        console.log(`ℹ️ [MTProto] Entity-cache prefill skipped (${this.isBotSession === true ? "bot MTProto session" : "unverified MTProto session capability"})`);
      }

      for (let idx = 0; idx < TARGET_CHANNELS.length; idx++) {
        const ch = TARGET_CHANNELS[idx];
        if (this.isFloodWaitActive()) {
          console.warn(`⚠️ [MTProto] FloodWait active - stopping this sync cycle before channel "${ch.name}".`);
          break;
        }
        const channelReport = {
          channel_name: ch.name,
          chat_id: "NOT BOUND YET",
          access: "NO",
          history_status: "FAILED",
          posts_found: 0,
          num_videos: 0,
          num_photos: 0,
          num_text: 0,
          latest_msg_id: "None",
          latest_date: "None",
          media_type: "None",
          latest_caption: "None",
          error: null,
          posts: []
        };

        try {
          let chatEntity = null;
          if (ch.username) {
            try {
              chatEntity = await this.getCachedEntity(ch.username);
              channelReport.access = "YES";
            } catch (e) {
              if (this.noteFloodWait(e)) throw e;
            }
          }

          if (!chatEntity && ch.chat_id) {
            try {
              chatEntity = await this.getCachedEntity(ch.chat_id);
              channelReport.access = "YES";
            } catch (e) {
              if (this.noteFloodWait(e)) throw e;
            }
          }

          if (!chatEntity && this.isBotSession === false && dialogs.length > 0) {
            const foundDialog = dialogs.find(d => {
              const ent = d.entity;
              if (!ent) return false;
              if (ent.username && ch.username && ent.username.toLowerCase() === ch.username.toLowerCase()) return true;
              if (ent.title && ch.name && ent.title.toLowerCase() === ch.name.toLowerCase()) return true;
              if (ent.id && ch.chat_id && String(ent.id).includes(String(ch.chat_id).replace("-100", ""))) return true;
              return false;
            });
            if (foundDialog) {
              chatEntity = foundDialog.entity;
              channelReport.access = "YES";
            }
          }

          if (!chatEntity && this.isBotSession === false && ch.hash) {
            const inviteInfo = await withTimeout(this.client.invoke(
              new Api.messages.CheckChatInvite({ hash: ch.hash })
            ), CALL_TIMEOUT_MS, "CheckChatInvite");
            if (inviteInfo instanceof Api.ChatInviteAlready) {
              chatEntity = inviteInfo.chat;
              channelReport.access = "YES";
            } else if (inviteInfo instanceof Api.ChatInvite) {
              channelReport.access = "PREVIEW_ONLY";
              channelReport.error = "Account is not a joined member of this private channel yet";
            }
          }

          if (chatEntity) {
            const rawChatId = String(chatEntity.id);
            const fullChatId = rawChatId.startsWith("-100") ? rawChatId : `-100${rawChatId}`;
            channelReport.chat_id = fullChatId;

            if (this.isBotSession === false) {
              const lastProcessedMsgId = sourceRegistry.getLatestRealMessageId(ch.name);
              const parsedPosts = [];
              let offsetId = 0;
              let hasMore = true;
              let videosFoundCount = 0;

              while (hasMore && videosFoundCount < limit) {
                const historyParams = {
                  peer: chatEntity,
                  limit: 100,
                };

                if (offsetId > 0) {
                  historyParams.offsetId = offsetId;
                }

                const history = await withTimeout(this.client.invoke(
                  new Api.messages.GetHistory(historyParams)
                ), CALL_TIMEOUT_MS, `GetHistory(${ch.name})`);

                const msgs = history.messages || [];
                if (msgs.length === 0) {
                  hasMore = false;
                  break;
                }

                let validCountInBatch = 0;
                for (const m of msgs) {
                  if (m instanceof Api.MessageEmpty) continue;

                  validCountInBatch++;

                  let mediaType = "text";
                  let durationStr = null;
                  let videoFileId = null;

                  if (m.media instanceof Api.MessageMediaDocument) {
                    const doc = m.media.document;
                    let videoAttr = null;
                    let isVideo = false;

                    if (doc) {
                      const mime = (doc.mimeType || doc.mime_type || "").toLowerCase();
                      if (mime.startsWith("video/")) {
                        isVideo = true;
                      }
                      if (doc.attributes) {
                        videoAttr = doc.attributes.find(a =>
                          (a instanceof Api.DocumentAttributeVideo) ||
                          (a && (a.className === "DocumentAttributeVideo" || a.CONSTRUCTOR_ID === 0xef02ce60))
                        );
                        if (videoAttr) isVideo = true;
                      }
                    }

                    if (isVideo) {
                      mediaType = "video";
                      videosFoundCount++;
                      channelReport.num_videos++;
                      // Do not store raw MTProto numeric doc.id as Bot API file_id
                      videoFileId = null;
                      if (videoAttr && videoAttr.duration) {
                        const dur = Math.floor(videoAttr.duration);
                        const mins = Math.floor(dur / 60);
                        const secs = dur % 60;
                        durationStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
                      }
                    } else {
                      mediaType = "file";
                      if (!channelReport.num_documents) channelReport.num_documents = 0;
                      channelReport.num_documents++;
                    }
                  } else if (m.media instanceof Api.MessageMediaPhoto) {
                    mediaType = "photo";
                    channelReport.num_photos++;
                  } else {
                    channelReport.num_text++;
                  }

                  const textContent = m.message || "";
                  let rawTextTitle = textContent.split("\n")[0] ? textContent.split("\n")[0].trim() : "";
                  let titleText = rawTextTitle.length > 0 ? (rawTextTitle.length > 80 ? rawTextTitle.substring(0, 77) + "..." : rawTextTitle) : "제목 없음";

                  const fullTitle = titleText;
                  const postObj = {
                    message_id: m.id,
                    date: m.date,
                    chat: { id: fullChatId, title: ch.name, username: ch.username, type: "channel" },
                    caption: textContent,
                    text: textContent,
                    media_type: mediaType,
                    duration: durationStr,
                    video_file_id: videoFileId,
                    title: fullTitle,
                    telegram_url: ch.username ? `https://t.me/${ch.username}/${m.id}` : `https://t.me/c/${fullChatId.substring(4)}/${m.id}`
                  };

                  parsedPosts.push(postObj);
                }

                if (msgs.length < 100 || validCountInBatch === 0) {
                  hasMore = false;
                } else {
                  const minIdInBatch = Math.min(...msgs.map(m => m.id));
                  if (offsetId > 0 && minIdInBatch >= offsetId) {
                    hasMore = false;
                  } else {
                    offsetId = minIdInBatch;
                  }
                }
              }

              channelReport.posts_found = parsedPosts.length;
              channelReport.history_status = "SUCCESS";

              channelReport.posts = parsedPosts;
              if (parsedPosts.length > 0) {
                const top = parsedPosts[0];
                channelReport.latest_msg_id = top.message_id;
                channelReport.latest_date = new Date(top.date * 1000).toISOString();
                channelReport.media_type = top.media_type;
                channelReport.latest_caption = top.caption || top.title;

                if (saveToDisk) {
                  const postsBefore = sourceRegistry.getPostsForKeyword(ch.name);
                  channelReport.existing_before = postsBefore.length;

                  let newCount = 0;
                  let insertedCount = 0;
                  let skippedCount = 0;

                  // Sort by message_id ascending so newest post is unshifted last to position 0
                  const sortedMsgs = [...parsedPosts].sort((a, b) => a.message_id - b.message_id);
                  // One registry write for the whole channel instead of 1-3 full
                  // rewrites of source_registry.json per fetched post.
                  sourceRegistry.runInBatch(() => {
                    for (const p of sortedMsgs) {
                      const res = sourceRegistry.processChannelPost(p, ch.name, true);
                      if (res && res.isNew) {
                        newCount++;
                        insertedCount++;
                      } else {
                        skippedCount++;
                      }
                    }
                  });

                  const postsAfter = sourceRegistry.getPostsForKeyword(ch.name);
                  channelReport.fetched = parsedPosts.length;
                  channelReport.new_posts = newCount;
                  channelReport.inserted = insertedCount;
                  channelReport.skipped = skippedCount;
                  channelReport.existing_after = postsAfter.length;

                  console.log(`📦 [SYNC] channel=${ch.name} fetched=${channelReport.fetched} new=${channelReport.new_posts} skipped=${channelReport.skipped} existing_after=${channelReport.existing_after}`);
                }
              }
            } else {
              // Bot or unverified session: fail-closed against invoking user-only messages.GetHistory
              channelReport.posts_found = 0;
              channelReport.history_status = this.isBotSession === true ? "SKIPPED_BOT_SESSION" : "SKIPPED_UNVERIFIED_SESSION";
              channelReport.error = this.isBotSession === true
                ? "Channel message history reading is not supported for Bot MTProto sessions by Telegram API (requires user account)"
                : "Channel message history reading skipped: MTProto session type is unverified / fail-closed";
              console.log(`ℹ️ [MTProto] Channel "${ch.name}" resolved (${fullChatId}), history reading skipped (${this.isBotSession === true ? "bot MTProto session capability limitation" : "unverified session fail-closed"}).`);
            }
          }
        } catch (err) {
          channelReport.history_status = "ERROR";
          channelReport.error = err.message;
          if (this.isFloodWaitActive() || this.noteFloodWait(err)) {
            results.push(channelReport);
            break;
          }
          if (err.message && (err.message.includes("disconnected") || err.message.includes("closed") || err.message.includes("TIMEOUT"))) {
            console.warn("⚠️ MTProto CONNECTION LOST during channel sync:", err.message);
            console.log("🔄 RECONNECTING MTProto client...");
            try {
              await this.connect();
              console.log("✅ MTProto RECONNECTED");
            } catch (recErr) {
              console.error("❌ MTProto reconnection failed:", recErr.message);
            }
          }
        }

        results.push(channelReport);
      }

      console.log("📡 MTProto client: SYNC COMPLETE");
      console.log("📡 MTProto client: STILL CONNECTED");
      return results;
    } finally {
      this.isSyncing = false;
    }
  }

  async resolveMediaForPost(post) {
    if (!post || (!post.chat_id && !post.username) || !post.message_id) return null;
    try {
      const connected = await this.connect();
      if (!connected) return null;

      let chatEntity = null;
      if (post.username) {
        try { chatEntity = await this.getCachedEntity(post.username); } catch (e) { this.noteFloodWait(e); }
      }
      if (!chatEntity && this.isBotSession === false) {
        try {
          const dialogs = await withTimeout(this.client.getDialogs({ limit: 100 }), CALL_TIMEOUT_MS, "getDialogs");
          const found = dialogs.find(d => {
            const ent = d.entity;
            if (!ent) return false;
            if (ent.username && post.username && ent.username.toLowerCase() === post.username.toLowerCase()) return true;
            if (ent.id && post.chat_id && String(ent.id).includes(String(post.chat_id).replace("-100", ""))) return true;
            return false;
          });
          if (found) chatEntity = found.entity;
        } catch (e) {}
      }

      if (chatEntity) {
        const msgs = await this.client.getMessages(chatEntity, { ids: [parseInt(post.message_id, 10)] });
        if (msgs && msgs[0] && msgs[0].media) {
          const m = msgs[0];
          let type = "video";
          if (m.media instanceof Api.MessageMediaPhoto) type = "photo";
          return {
            message_id: m.id,
            type: type,
            has_media: true,
            chat_id: post.chat_id
          };
        }
      }
    } catch (err) {
      console.warn("⚠️ Error in MTProto resolveMediaForPost:", err.message);
    }
    return null;
  }
}

MTProtoChannelReader.withTimeout = withTimeout;
MTProtoChannelReader.getFloodWaitSeconds = getFloodWaitSeconds;
MTProtoChannelReader.isAuthKeyDuplicatedError = isAuthKeyDuplicatedError;

module.exports = MTProtoChannelReader;
