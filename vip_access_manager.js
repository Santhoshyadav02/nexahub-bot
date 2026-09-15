/**
 * vip_access_manager.js
 *
 * Isolated VIP Access Approval System.
 * - Manages VIP permission states (PENDING, APPROVED, REJECTED)
 * - Persistent storage in data/vip_access_registry.json
 * - Dual-admin authorization: @CSE_006 and @ooalw
 * - Strict OR logic: Either admin approval immediately grants access
 */

const fs = require("fs");
const path = require("path");
const { dataPath, writeJsonAtomicSync, quarantineCorruptFile } = require("./runtime_paths");

const REGISTRY_FILE = dataPath("vip_access_registry.json");
const AUTHORIZED_ADMIN_USERNAMES = new Set(["cse_006"]);

// In-memory set of numeric admin IDs
const authorizedAdminIds = new Set();

function initAdminIdsFromEnv() {
  const envIds = [
    process.env.VIP_ADMIN_IDS,
    process.env.VIP_ADMIN_1_ID,
    process.env.VIP_ADMIN_2_ID,
    process.env.ADMIN_USER_ID,
    process.env.TELEGRAM_ADMIN_ID
  ];

  for (const raw of envIds) {
    if (!raw) continue;
    const parts = String(raw).split(/[,;\s]+/);
    for (const p of parts) {
      const trimmed = p.trim();
      if (/^\d+$/.test(trimmed)) {
        authorizedAdminIds.add(trimmed);
      }
    }
  }
}

initAdminIdsFromEnv();

class VipAccessManager {
  constructor(filePath = REGISTRY_FILE) {
    this.filePath = filePath;
    this.users = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data.users === "object") {
          for (const [id, record] of Object.entries(data.users)) {
            this.users.set(String(id), record);
          }
        }
        if (Array.isArray(data.adminIds)) {
          for (const aId of data.adminIds) {
            authorizedAdminIds.add(String(aId));
          }
        }
      }
    } catch (err) {
      console.error("[VIP_ACCESS] Corrupt registry, quarantining:", err.message);
      quarantineCorruptFile(this.filePath);
      this.users = new Map();
    }
  }

  _save() {
    try {
      const serialized = {
        updatedAt: new Date().toISOString(),
        adminIds: Array.from(authorizedAdminIds),
        users: Object.fromEntries(this.users)
      };
      writeJsonAtomicSync(this.filePath, serialized);
    } catch (err) {
      console.error("[VIP_ACCESS] Failed to save registry:", err.message);
    }
  }

  registerAdminIfMatched(user) {
    if (!user) return false;
    const username = (user.username || "").toLowerCase().replace(/^@/, "");
    const userIdStr = String(user.id || user.userId || "");
    if (AUTHORIZED_ADMIN_USERNAMES.has(username) && userIdStr) {
      if (!authorizedAdminIds.has(userIdStr)) {
        console.log(`👑 [VIP_ACCESS] Registered admin @${username} with numeric Telegram ID: ${userIdStr}`);
      }
      authorizedAdminIds.add(userIdStr);
      this._save();
      return true;
    }
    return false;
  }

  isAuthorizedAdmin(user) {
    if (!user) return false;
    const userIdStr = String(user.id || user.userId || "");
    const username = (user.username || "").toLowerCase().replace(/^@/, "");

    if (AUTHORIZED_ADMIN_USERNAMES.has(username)) {
      if (userIdStr) {
        authorizedAdminIds.add(userIdStr);
        this._save();
      }
      return true;
    }

    if (userIdStr && authorizedAdminIds.has(userIdStr)) {
      return true;
    }

    return false;
  }

  getUserRecord(userId) {
    return this.users.get(String(userId)) || null;
  }

  getVipStatus(userId) {
    const record = this.getUserRecord(userId);
    return record ? record.status : "NOT_REQUESTED";
  }

  isVipApproved(userId) {
    return this.getVipStatus(userId) === "APPROVED";
  }

  async requestVipAccess(user, bot = null) {
    if (!user || !user.id) {
      return { status: "INVALID_USER", success: false };
    }

    const userIdStr = String(user.id);
    const existing = this.getUserRecord(userIdStr);

    if (existing && existing.status === "APPROVED") {
      return { status: "APPROVED", success: true, alreadyApproved: true, record: existing };
    }

    if (existing && existing.status === "PENDING") {
      // Re-notify admin if requested again while pending
      if (bot) {
        await this._notifyAdminsOfRequest(bot, existing);
      }
      return { status: "PENDING", success: true, alreadyPending: true, record: existing };
    }

    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "사용자";
    const username = user.username || "";

    const newRecord = {
      userId: userIdStr,
      username: username ? `@${username.replace(/^@/, "")}` : "",
      displayName: displayName,
      status: "PENDING",
      requestedAt: new Date().toISOString(),
      approvedAt: null,
      approvedBy: null,
      approvals: {}
    };

    this.users.set(userIdStr, newRecord);
    this._save();

    // Send notifications to authorized admin account (@CSE_006)
    if (bot) {
      await this._notifyAdminsOfRequest(bot, newRecord);
    }

    return { status: "PENDING", success: true, record: newRecord };
  }

  async _notifyAdminsOfRequest(bot, record) {
    const formattedTime = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const adminMsg =
      `🔔 <b>[VIP 접근 요청]</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `👤 <b>이름:</b> ${escapeHTML(record.displayName)}\n` +
      `🏷️ <b>Username:</b> ${record.username ? escapeHTML(record.username) : "없음"}\n` +
      `🆔 <b>Telegram ID:</b> <code>${record.userId}</code>\n` +
      `⏰ <b>요청 시간:</b> ${formattedTime} (KST)\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `VIP 접근을 승인하시겠습니까?`;

    const adminKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ 승인", callback_data: `vip_admin:approve:${record.userId}` },
          { text: "❌ 거절", callback_data: `vip_admin:reject:${record.userId}` }
        ]
      ]
    };

    const targetAdmins = Array.from(authorizedAdminIds);
    if (targetAdmins.length === 0) {
      console.warn(`⚠️ [VIP_ACCESS] No numeric Telegram chat ID registered for @CSE_006 yet. Admin must send /start or /admin to the bot to receive notifications.`);
      return;
    }

    for (const targetId of targetAdmins) {
      try {
        await bot.sendMessage(targetId, adminMsg, {
          parse_mode: "HTML",
          reply_markup: adminKeyboard
        });
        console.log(`✅ [VIP_ACCESS] Notification sent to admin chatId: ${targetId} for user ${record.userId}`);
      } catch (err) {
        console.error(`❌ [VIP_ACCESS] Failed to send notification to admin chatId ${targetId}:`, err.message);
      }
    }
  }

  processAdminDecision(adminUser, targetUserId, decision) {
    const userIdStr = String(targetUserId);
    const record = this.getUserRecord(userIdStr);

    if (!record) {
      return { success: false, error: "USER_NOT_FOUND" };
    }

    if (!this.isAuthorizedAdmin(adminUser)) {
      return { success: false, error: "UNAUTHORIZED_ADMIN" };
    }

    const adminName = adminUser.username ? `@${adminUser.username.replace(/^@/, "")}` : `@CSE_006`;
    const isApproved = decision === "APPROVE" || decision === "approve";

    if (isApproved) {
      record.status = "APPROVED";
      record.approvedAt = new Date().toISOString();
      record.approvedBy = adminName;
    } else {
      record.status = "REJECTED";
      record.rejectedAt = new Date().toISOString();
      record.rejectedBy = adminName;
    }

    record.approvals[String(adminUser.id || "admin")] = {
      decision: record.status,
      adminName: adminName,
      timestamp: new Date().toISOString()
    };

    this.users.set(userIdStr, record);
    this._save();

    return {
      success: true,
      newStatus: record.status,
      targetUserId: userIdStr,
      record: record,
      adminName: adminName
    };
  }

  getVipGroupLink() {
    return process.env.VIP_GROUP_LINK || "https://t.me/+vl6BuZ0Ey7Q5YjU0";
  }
}

function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const defaultManager = new VipAccessManager();

module.exports = {
  VipAccessManager,
  vipAccessManager: defaultManager,
  AUTHORIZED_ADMIN_USERNAMES,
  authorizedAdminIds
};
