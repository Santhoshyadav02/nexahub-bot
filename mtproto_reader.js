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

class MTProtoChannelReader {
  constructor() {
    if (MTProtoChannelReader.instance) {
      return MTProtoChannelReader.instance;
    }

    this.apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
    this.apiHash = process.env.TELEGRAM_API_HASH || "";
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || "";
    try {
      this.session = new StringSession(this.sessionString);
    } catch (e) {
      this.session = new StringSession("");
    }
    this.client = new TelegramClient(this.session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });
    this.authMode = "USER_SESSION";
    this.connectingPromise = null;

    MTProtoChannelReader.instance = this;
  }

  async connect() {
    if (!this.sessionString) {
      console.log("ℹ️ GramJS MTProto reader: TELEGRAM_SESSION_STRING not configured. Skipping MTProto connection.");
      return false;
    }

    if (this.client && this.client.connected) {
      console.log("✅ MTProto client: CONNECTED (reusing persistent connection)");
      return true;
    }

    if (this.connectingPromise) {
      return await this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      try {
        console.log("📡 MTProto client: CONNECTING...");
        await this.client.connect();
        try {
          // Cache all joined channel entities in 1 single request to avoid CheckChatInvite flood wait
          await this.client.getDialogs({ limit: 100 });
        } catch (e) {}
        console.log("✅ MTProto client: CONNECTED");
        return true;
      } catch (err) {
        console.error("❌ MTProto client connection error:", err.message);
        try { await this.client.disconnect(); } catch (e) {}
        return false;
      } finally {
        this.connectingPromise = null;
      }
    })();

    return await this.connectingPromise;
  }

  async disconnect() {
    try {
      if (this.client && this.client.connected) {
        console.log("🔌 Explicitly disconnecting MTProto client...");
        await this.client.disconnect().catch(() => {});
        if (typeof this.client.destroy === "function") {
          await this.client.destroy().catch(() => {});
        }
      }
    } catch (e) {}
  }

  async syncAllChannels(limit = 10, saveToDisk = false) {
    if (this.isSyncing) {
      console.log("ℹ️ MTProto sync already in progress. Skipping concurrent sync request.");
      return [];
    }
    this.isSyncing = true;
    try {
      const results = [];
      const connected = await this.connect();
      if (!connected) {
        console.warn("⚠️ Cannot run MTProto sync: Client not connected.");
        return results;
      }

      console.log("📡 MTProto client: SYNC START");

    let dialogs = [];
    try {
      dialogs = await this.client.getDialogs({ limit: 100 });
      console.log(`📋 MTProto entity cache prefilled with ${dialogs.length} dialogs.`);
    } catch (e) {
      console.warn("⚠️ getDialogs error during entity cache prefill:", e.message);
    }

    for (let idx = 0; idx < TARGET_CHANNELS.length; idx++) {
      const ch = TARGET_CHANNELS[idx];
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
            chatEntity = await this.client.getEntity(ch.username);
            channelReport.access = "YES";
          } catch (e) {}
        }

        if (!chatEntity && ch.chat_id) {
          try {
            chatEntity = await this.client.getEntity(ch.chat_id);
            channelReport.access = "YES";
          } catch (e) {}
        }

        if (!chatEntity && dialogs.length > 0) {
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

        if (!chatEntity && ch.hash) {
          const inviteInfo = await this.client.invoke(
            new Api.messages.CheckChatInvite({ hash: ch.hash })
          );
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

            const history = await this.client.invoke(
              new Api.messages.GetHistory(historyParams)
            );

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
              for (const p of sortedMsgs) {
                const res = sourceRegistry.processChannelPost(p, ch.name, true);
                if (res && res.isNew) {
                  newCount++;
                  insertedCount++;
                } else {
                  skippedCount++;
                }
              }

              const postsAfter = sourceRegistry.getPostsForKeyword(ch.name);
              channelReport.fetched = parsedPosts.length;
              channelReport.new_posts = newCount;
              channelReport.inserted = insertedCount;
              channelReport.skipped = skippedCount;
              channelReport.existing_after = postsAfter.length;

              console.log(`📦 [SYNC] channel=${ch.name} historical posts loaded=${channelReport.inserted}`);
            }
          }
        }
      } catch (err) {
        channelReport.history_status = "ERROR";
        channelReport.error = err.message;
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
        try { chatEntity = await this.client.getEntity(post.username); } catch (e) {}
      }
      if (!chatEntity) {
        try {
          const dialogs = await this.client.getDialogs({ limit: 100 });
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

module.exports = MTProtoChannelReader;
