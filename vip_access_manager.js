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
const AUTHORIZED_ADMIN_USERNAMES = new Set(["ooalw", "cse_006", "cse_06", "cse06", "cse006"]);

// In-memory set of numeric admin IDs
const authorizedAdminIds = new Set(["8781836301"]);

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

    // Send notifications to authorized admin account (@ooalw / @CSE_006)
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
      console.warn(`⚠️ [VIP_ACCESS] No numeric Telegram chat ID registered for @ooalw / @CSE_006 yet. Admin must send /start or /admin to the bot to receive notifications.`);
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

    const adminName = adminUser.username ? `@${adminUser.username.replace(/^@/, "")}` : `@ooalw`;
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

  approveAllPending(adminUser) {
    if (!this.isAuthorizedAdmin(adminUser)) {
      return { success: false, error: "UNAUTHORIZED_ADMIN", count: 0, approvedIds: [] };
    }
    const adminName = adminUser.username ? `@${adminUser.username.replace(/^@/, "")}` : `@ooalw`;
    const pendingUsers = this.getUsersByStatus("PENDING");
    const now = new Date().toISOString();
    const approvedIds = [];

    for (const u of pendingUsers) {
      u.status = "APPROVED";
      u.approvedAt = now;
      u.approvedBy = adminName;
      u.approvals[String(adminUser.id || "admin")] = {
        decision: "APPROVED",
        adminName: adminName,
        timestamp: now
      };
      this.users.set(u.userId, u);
      approvedIds.push(u.userId);
    }

    if (approvedIds.length > 0) {
      this._save();
    }

    return { success: true, count: approvedIds.length, approvedIds };
  }

  getUsersByStatus(status = "APPROVED") {
    const list = Array.from(this.users.values());
    if (!status || status === "ALL") return list;
    return list.filter(u => u.status === status);
  }

  getStats() {
    const all = Array.from(this.users.values());
    const approved = all.filter(u => u.status === "APPROVED").length;
    const pending = all.filter(u => u.status === "PENDING").length;
    const rejected = all.filter(u => u.status === "REJECTED").length;
    return {
      total: all.length,
      approved,
      pending,
      rejected
    };
  }

  formatAdminPanel(statusFilter = "APPROVED") {
    const stats = this.getStats();
    const filteredUsers = this.getUsersByStatus(statusFilter).sort((a, b) => {
      const timeA = new Date(a.approvedAt || a.requestedAt || 0).getTime();
      const timeB = new Date(b.approvedAt || b.requestedAt || 0).getTime();
      return timeB - timeA;
    });

    const statusTitle =
      statusFilter === "APPROVED" ? "✅ 승인된 사용자 목록" :
      statusFilter === "PENDING" ? "⏳ 승인 대기 중 목록 (Waiting for Approval)" :
      statusFilter === "REJECTED" ? "❌ 거절된 사용자 목록" : "👥 전체 사용자 목록";

    let text =
      `👑 <b>VIP 관리자 패널</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>VIP 현황 요약</b>\n` +
      `• ✅ 승인된 사용자: <b>${stats.approved}</b>명\n` +
      `• ⏳ 대기 중 사용자: <b>${stats.pending}</b>명\n` +
      `• ❌ 거절된 사용자: <b>${stats.rejected}</b>명\n` +
      `• 👥 총 등록자: <b>${stats.total}</b>명\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📜 <b>${statusTitle}</b>\n\n`;

    const actionButtons = [];

    if (filteredUsers.length === 0) {
      if (statusFilter === "PENDING") {
        text += `<i>현재 승인 대기 중인 사용자가 없습니다. (모두 처리됨)</i>`;
      } else {
        text += `<i>해당 상태의 사용자가 없습니다.</i>`;
      }
    } else {
      const displayUsers = filteredUsers.slice(0, 15);
      displayUsers.forEach((u, i) => {
        const timeStr = u.approvedAt
          ? new Date(u.approvedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
          : (u.requestedAt ? new Date(u.requestedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음");
        text +=
          `<b>${i + 1}. ${escapeHTML(u.displayName || "사용자")}</b>\n` +
          `   • Username: ${u.username ? escapeHTML(u.username) : "없음"}\n` +
          `   • ID: <code>${u.userId}</code>\n` +
          `   • 일시: ${timeStr}\n` +
          (u.approvedBy ? `   • 처리자: ${escapeHTML(u.approvedBy)}\n` : "") +
          `\n`;

        if (statusFilter === "PENDING" && i < 6) {
          const rawName = u.displayName || u.username || u.userId;
          const shortName = rawName.length > 10 ? rawName.slice(0, 9) + "…" : rawName;
          actionButtons.push([
            { text: `✅ 승인: ${shortName}`, callback_data: `vip_admin:approve:${u.userId}` },
            { text: `❌ 거절: ${shortName}`, callback_data: `vip_admin:reject:${u.userId}` }
          ]);
        }
      });
      if (filteredUsers.length > 15) {
        text += `<i>... 외 ${filteredUsers.length - 15}명 생략</i>\n`;
      }

      if (statusFilter === "PENDING" && filteredUsers.length > 1) {
        actionButtons.push([
          { text: `⚡ 전체 대기자 일괄 승인 (${filteredUsers.length}명)`, callback_data: `vip_admin:approve_all` }
        ]);
      }
    }

    const navigationRow = [
      { text: `✅ 승인 (${stats.approved})`, callback_data: "admin_view:APPROVED" },
      { text: `⏳ 대기 (${stats.pending})`, callback_data: "admin_view:PENDING" },
      { text: `❌ 거절 (${stats.rejected})`, callback_data: "admin_view:REJECTED" }
    ];

    const keyboard = {
      inline_keyboard: [
        ...actionButtons,
        navigationRow,
        [
          { text: "📊 24h 파이프라인 보고서", callback_data: "admin_daily_report" },
          { text: "🔄 새로고침", callback_data: `admin_view:${statusFilter}` }
        ]
      ]
    };

    return { text, keyboard };
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
