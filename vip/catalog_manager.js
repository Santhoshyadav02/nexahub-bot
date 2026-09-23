/**
 * ============================================================
 * 📚 VIP CHANNEL CATALOG & PAGINATED LIST MANAGER
 * ============================================================
 * Maintains the latest 40 video posts for each of the 6 VIP channels
 * and renders interactive 8-item x 5-page paginated menus with clickable hyperlinks.
 *
 * Each title is formatted as an HTML hyperlink:
 * <a href="https://t.me/c/<channel_id>/<message_id>">Title</a>
 *
 * Page layout:
 *   📺 {CHANNEL_NAME}
 *   이 채널의 최신 동영상 목록입니다.
 *
 *   1. Title 1 (Hyperlink)
 *   2. Title 2 (Hyperlink)
 *   ...
 *   8. Title 8 (Hyperlink)
 *
 *   페이지 1/5
 *   [ 다음 ➡️ ]
 */

const fs = require('fs');
const path = require('path');

const CATALOG_DATA_PATH = path.resolve(__dirname, 'channel_catalogs.json');
const MAX_ITEMS_PER_CHANNEL = 40;
const ITEMS_PER_PAGE = 8;

class CatalogManager {
  constructor(dataPath = CATALOG_DATA_PATH) {
    this.dataPath = dataPath;
    this.catalogs = {}; // { [channelKey]: [ { messageId, title, link, date } ] }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        this.catalogs = JSON.parse(raw);
      }
    } catch (err) {
      console.error('❌ [CATALOG_MANAGER] Failed to load catalogs:', err.message);
      this.catalogs = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.catalogs, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ [CATALOG_MANAGER] Failed to save catalogs:', err.message);
    }
  }

  /**
   * Adds a new video post to the channel's catalog (keeps latest 40).
   */
  addVideo(channelKey, { messageId, title, link, date = new Date().toISOString() }) {
    if (!this.catalogs[channelKey]) {
      this.catalogs[channelKey] = [];
    }

    // Check if already exists
    const existsIndex = this.catalogs[channelKey].findIndex(v => v.messageId === messageId || v.link === link);
    if (existsIndex >= 0) {
      // Update title/date if needed
      this.catalogs[channelKey][existsIndex].title = title;
      this._save();
      return false;
    }

    // Insert newest at beginning
    this.catalogs[channelKey].unshift({
      messageId,
      title: title.trim(),
      link,
      date
    });

    // Cap at 40 items
    if (this.catalogs[channelKey].length > MAX_ITEMS_PER_CHANNEL) {
      this.catalogs[channelKey] = this.catalogs[channelKey].slice(0, MAX_ITEMS_PER_CHANNEL);
    }

    this._save();
    return true;
  }

  /**
   * Returns paginated list of videos for a given channel.
   */
  getPage(channelKey, page = 1) {
    const list = this.catalogs[channelKey] || [];
    const totalItems = list.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    const safePage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
    const items = list.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    return {
      channelKey,
      items,
      currentPage: safePage,
      totalPages,
      totalItems,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages
    };
  }

  /**
   * Formats the 8-item catalog text with HTML blue hyperlinks matching reference UI.
   */
  formatCatalogText(channelConfig, pageData) {
    const channelName = channelConfig.name || channelConfig.buttonLabel || 'VIP 채널';
    const emoji = channelConfig.emoji || '📺';

    let text = `${emoji} <b>${this._escapeHTML(channelName)}</b>\n\n`;
    text += `이 채널의 최신 동영상 목록입니다.\n\n`;

    if (pageData.items.length === 0) {
      text += `<i>현재 등록된 최신 동영상이 없습니다.</i>\n\n`;
    } else {
      pageData.items.forEach((item, index) => {
        const itemNumber = (pageData.currentPage - 1) * ITEMS_PER_PAGE + (index + 1);
        const safeTitle = this._escapeHTML(item.title);
        // Blue clickable hyperlink wrapping title
        text += `${itemNumber}. <a href="${item.link}">${safeTitle}</a>\n\n`;
      });
    }

    text += `<b>페이지 ${pageData.currentPage}/${pageData.totalPages}</b>`;
    return text;
  }

  /**
   * Builds pagination inline keyboard ([⬅️ 이전] [다음 ➡️]).
   */
  buildPaginationKeyboard(channelKey, pageData) {
    const row = [];

    if (pageData.hasPrev) {
      row.push({
        text: '⬅️ 이전',
        callback_data: `cat_pg:${channelKey}:${pageData.currentPage - 1}`
      });
    }

    if (pageData.hasNext) {
      row.push({
        text: '다음 ➡️',
        callback_data: `cat_pg:${channelKey}:${pageData.currentPage + 1}`
      });
    }

    const keyboard = [];
    if (row.length > 0) {
      keyboard.push(row);
    }

    // Refresh row
    keyboard.push([
      { text: '🔄 새로고침', callback_data: `cat_pg:${channelKey}:${pageData.currentPage}` }
    ]);

    return { inline_keyboard: keyboard };
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = {
  CatalogManager,
  MAX_ITEMS_PER_CHANNEL,
  ITEMS_PER_PAGE
};
