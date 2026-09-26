/**
 * ============================================================
 * 📚 VIP CHANNEL CATALOG & PAGINATED LIST MANAGER
 * ============================================================
 * Maintains the latest 40 video posts for each of the 6 VIP channels
 * and renders interactive 8-item x 5-page paginated menus with clickable hyperlinks
 * and direct Join Channel links.
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

  _sort(channelKey) {
    if (this.catalogs[channelKey]) {
      this.catalogs[channelKey].sort((a, b) => {
        const idA = Number(a.messageId) || 0;
        const idB = Number(b.messageId) || 0;
        if (idB !== idA) return idB - idA;
        return new Date(b.date || 0) - new Date(a.date || 0);
      });
    }
  }

  /**
   * Returns a deduplicated list of items for a given channel (newest first).
   * Prevents repeated album posts with identical titles from cluttering the menu.
   */
  getUniqueItems(channelKey) {
    this._sort(channelKey);
    const rawList = this.catalogs[channelKey] || [];
    const seenBaseTitles = new Set();
    const uniqueList = [];

    for (const item of rawList) {
      const rawTitle = (item.title || '').trim();
      if (!rawTitle) continue;

      const firstLine = rawTitle.split(/[\n]/)[0].trim().toLowerCase();
      const bracketMatch = firstLine.match(/^(\[[^\]]+\]|【[^】]+】)/);
      const baseKey = bracketMatch ? bracketMatch[1] : firstLine;

      if (!seenBaseTitles.has(baseKey)) {
        seenBaseTitles.add(baseKey);
        uniqueList.push(item);
      }
    }
    return uniqueList;
  }

  /**
   * Adds a new video post to the channel's catalog (keeps latest 40).
   */
  addVideo(channelKey, { messageId, title, link, date = new Date().toISOString() }) {
    if (!this.catalogs[channelKey]) {
      this.catalogs[channelKey] = [];
    }

    const existsIndex = this.catalogs[channelKey].findIndex(v => v.messageId === messageId || v.link === link);
    if (existsIndex >= 0) {
      this.catalogs[channelKey][existsIndex].title = title;
      this._sort(channelKey);
      this._save();
      return false;
    }

    this.catalogs[channelKey].push({
      messageId: Number(messageId) || messageId,
      title: title.trim(),
      link,
      date
    });

    this._sort(channelKey);

    if (this.catalogs[channelKey].length > MAX_ITEMS_PER_CHANNEL) {
      this.catalogs[channelKey] = this.catalogs[channelKey].slice(0, MAX_ITEMS_PER_CHANNEL);
    }

    this._save();
    return true;
  }

  /**
   * Returns paginated list of distinct/unique videos for a given channel.
   */
  getPage(channelKey, page = 1) {
    const list = this.getUniqueItems(channelKey);
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
   * Formats the catalog text with clear spacing and HTML blue hyperlinks.
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
        const cleanT = (item.title || '')
          .replace(/<[^>]*>/g, '')
          .replace(/\[REMOVE\]/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        const safeTitle = this._escapeHTML(cleanT);
        // Spacious formatting with double newline gap between items
        text += `${itemNumber}. <a href="${item.link}">${safeTitle}</a>\n\n`;
      });
    }

    text += `<b>페이지 ${pageData.currentPage}/${pageData.totalPages}</b>`;
    return text;
  }

  /**
   * Builds pagination inline keyboard ([⬅️ 이전] [다음 ➡️], [📢 채널 입장하기], [🔙 뒤로가기] [🔄 새로고침]).
   */
  buildPaginationKeyboard(channelKeyOrConfig, pageData) {
    let channelKey = channelKeyOrConfig;
    let inviteLink = null;
    let channelName = '채널';

    if (channelKeyOrConfig && typeof channelKeyOrConfig === 'object') {
      channelKey = channelKeyOrConfig.key;
      inviteLink = channelKeyOrConfig.inviteLink;
      channelName = channelKeyOrConfig.name || channelKeyOrConfig.buttonLabel || channelKeyOrConfig.tag || '채널';
    }

    const keyboard = [];
    const pageNavRow = [];

    if (pageData.hasPrev) {
      pageNavRow.push({
        text: '⬅️ 이전',
        callback_data: `cat_pg:${channelKey}:${pageData.currentPage - 1}`
      });
    }

    if (pageData.hasNext) {
      pageNavRow.push({
        text: '다음 ➡️',
        callback_data: `cat_pg:${channelKey}:${pageData.currentPage + 1}`
      });
    }

    if (pageNavRow.length > 0) {
      keyboard.push(pageNavRow);
    }

    // Direct Channel Join Link button
    if (inviteLink) {
      keyboard.push([
        { text: `📢 ${channelName} 입장하기 ↗️`, url: inviteLink }
      ]);
    }

    // Navigation and refresh row
    keyboard.push([
      { text: '🔙 뒤로가기', callback_data: 'vip_main_menu' },
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
