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
    this.apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
    this.apiHash = process.env.TELEGRAM_API_HASH || "";
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || "";
    this.botToken = process.env.BOT_TOKEN || "";
    this.session = new StringSession(this.sessionString);
    this.client = new TelegramClient(this.session, this.apiId, this.apiHash, {
      connectionRetries: 3,
    });
    this.authMode = this.sessionString ? "USER_SESSION" : "BOT_TOKEN";
  }

  async connect() {
    if (this.sessionString) {
      await this.client.connect();
      try {
        // Cache all joined channel entities in 1 single request to avoid CheckChatInvite flood wait
        await this.client.getDialogs({ limit: 100 });
      } catch (e) {}
    } else {
      await this.client.start({ botAuthToken: this.botToken });
    }
  }

  async disconnect() {
    try {
      if (this.client) {
        await this.client.disconnect().catch(() => {});
        if (typeof this.client.destroy === "function") {
          await this.client.destroy().catch(() => {});
        }
      }
    } catch (e) {}
  }

  async syncAllChannels(limit = 10, saveToDisk = false) {
    const results = [];
    try {
      await this.connect();

      for (const ch of TARGET_CHANNELS) {
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
        if (ch.chat_id) {
          try {
            chatEntity = await this.client.getEntity(ch.chat_id);
            channelReport.access = "YES";
          } catch (e) {}
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

          const history = await this.client.invoke(
            new Api.messages.GetHistory({
              peer: chatEntity,
              limit: limit,
            })
          );

          const msgs = history.messages || [];
          channelReport.posts_found = msgs.length;
          channelReport.history_status = "SUCCESS";

          if (msgs.length > 0) {
            const parsedPosts = [];
            for (const m of msgs) {
              if (m instanceof Api.MessageEmpty) continue;

              let mediaType = "text";
              let durationStr = null;

              if (m.media instanceof Api.MessageMediaDocument) {
                mediaType = "video";
                channelReport.num_videos++;
                const doc = m.media.document;
                if (doc && doc.attributes) {
                  const videoAttr = doc.attributes.find(a => a instanceof Api.DocumentAttributeVideo);
                  if (videoAttr && videoAttr.duration) {
                    const dur = Math.floor(videoAttr.duration);
                    const mins = Math.floor(dur / 60);
                    const secs = dur % 60;
                    durationStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
                  }
                }
              } else if (m.media instanceof Api.MessageMediaPhoto) {
                mediaType = "photo";
                channelReport.num_photos++;
              } else {
                channelReport.num_text++;
              }

              const textContent = m.message || "";
              let titleText = textContent.split("\n")[0] || `${ch.name} Post ${m.id}`;
              titleText = titleText.trim();
              if (titleText.length > 80) {
                titleText = titleText.substring(0, 77) + "...";
              }

              let icon = "🎬 ";
              if (mediaType === "video") {
                icon = durationStr ? `▶️ [${durationStr}] ` : "▶️ ";
              } else if (mediaType === "photo") {
                icon = "🖼️ ";
              }

              const fullTitle = `${icon}${titleText}`;
              const cleanChatId = fullChatId.substring(4);
              const tgUrl = `https://t.me/c/${cleanChatId}/${m.id}`;

              const postObj = {
                message_id: m.id,
                date: m.date,
                chat: { id: fullChatId, title: ch.name, type: "channel" },
                caption: textContent,
                text: textContent,
                media_type: mediaType,
                title: fullTitle,
                telegram_url: tgUrl
              };

              parsedPosts.push(postObj);
            }

            channelReport.posts = parsedPosts;
            if (parsedPosts.length > 0) {
              const top = parsedPosts[0];
              channelReport.latest_msg_id = top.message_id;
              channelReport.latest_date = new Date(top.date * 1000).toISOString();
              channelReport.media_type = top.media_type;
              channelReport.latest_caption = top.caption || top.title;

              if (saveToDisk) {
                // Sort by message_id ascending so newest post is unshifted last to position 0
                const sortedMsgs = [...parsedPosts].sort((a, b) => a.message_id - b.message_id);
                for (const p of sortedMsgs) {
                  sourceRegistry.processChannelPost(p, ch.name);
                }
              }
            }
          }
        }
      } catch (err) {
        channelReport.history_status = "ERROR";
        channelReport.error = err.message;
      }

      results.push(channelReport);
    }
    } finally {
      await this.disconnect();
    }
    return results;
  }
}

module.exports = MTProtoChannelReader;
