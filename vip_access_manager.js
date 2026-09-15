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
const AUTHORIZED_ADMIN_USERNAMES = new Set(["cse_006", "ooalw"]);

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
      if (userIdStr) authorizedAdminIds.add(userIdStr);
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

    // Send notifications to both authorized admin accounts
    if (bot) {
      await this._notifyAdminsOfRequest(bot, newRecord);
    }

    return { status: "PENDING", success: true, record: newRecord };
  }

  async _notifyAdminsOfRequest(bot, record) {
    const adminMsg =
      `🔔 <b>VIP 접근 요청</b>\n\n` +
      `사용자: ${escapeHTML(record.displayName)}\n` +
      `Username: ${record.username ? record.username : "없음"}\n` +
      `Telegram ID: <code>${record.userId}</code>\n\n` +
      `VIP 그룹 접근을 요청했습니다.`;

    const adminKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ 승인", callback_data: `vip_admin:approve:${record.userId}` },
          { text: "❌ 거절", callback_data: `vip_admin:reject:${record.userId}` }
        ]
      ]
    };

    const targetAdmins = Array.from(authorizedAdminIds);
    const targets = targetAdmins.length > 0 ? targetAdmins : ["@CSE_006", "@ooalw"];

    for (const target of targets) {
      try {
        await bot.sendMessage(target, adminMsg, {
          parse_mode: "HTML",
          reply_markup: adminKeyboard
        });
      } catch (err) {
        // Ignored if direct chat is not yet opened with bot by that admin target
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

    const adminId = String(adminUser.id || adminUser.username || "admin");
    const adminName = adminUser.username ? `@${adminUser.username.replace(/^@/, "")}` : `ID:${adminUser.id}`;

    const normalizedDecision = decision === "APPROVE" || decision === "approve" ? "APPROVED" : "REJECTED";
    record.approvals[adminId] = {
      decision: normalizedDecision,
      adminName: adminName,
      timestamp: new Date().toISOString()
    };

    // OR LOGIC: If ANY admin approved, status is immediately APPROVED
    const anyApproved = Object.values(record.approvals).some(a => a.decision === "APPROVED");

    if (anyApproved) {
      record.status = "APPROVED";
      record.approvedAt = record.approvedAt || new Date().toISOString();
      record.approvedBy = adminName;
    } else {
      // If all recorded decisions are REJECTED, status is REJECTED
      const allRejected = Object.values(record.approvals).length > 0 &&
        Object.values(record.approvals).every(a => a.decision === "REJECTED");
      if (allRejected) {
        record.status = "REJECTED";
      }
    }

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
