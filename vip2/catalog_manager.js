/**
 * ============================================================
 * 📚 VIP-2 CHANNEL CATALOG & PAGINATED LIST MANAGER
 * ============================================================
 * Maintains the latest 40 video posts for VIP-2 channel (-1004361683750)
 * and renders interactive 8-item x 5-page paginated menus with clickable hyperlinks.
 */

const fs = require('fs');
const path = require('path');

const CATALOG_DATA_PATH = path.resolve(__dirname, 'channel_catalog.json');
const MAX_ITEMS = 40;
const ITEMS_PER_PAGE = 8;

class Vip2CatalogManager {
  constructor(dataPath = CATALOG_DATA_PATH) {
    this.dataPath = dataPath;
    this.items = []; // [ { messageId, title, link, date } ]
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        this.items = JSON.parse(raw);
      }
    } catch (err) {
      console.error('❌ [VIP2_CATALOG] Failed to load catalog:', err.message);
      this.items = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ [VIP2_CATALOG] Failed to save catalog:', err.message);
    }
  }

  _sort() {
    this.items.sort((a, b) => {
      const idA = Number(a.messageId) || 0;
      const idB = Number(b.messageId) || 0;
      if (idB !== idA) return idB - idA;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
  }

  /**
   * Adds a video post to the catalog (keeps latest 40).
   */
  addVideo({ messageId, title, link, date = new Date().toISOString() }) {
    const numId = Number(messageId) || messageId;
    const cleanTitle = (title || '').trim() || 'V.I.P-2 신규 영상';

    const existsIndex = this.items.findIndex(
      v => String(v.messageId) === String(numId) || (link && v.link === link)
    );

    if (existsIndex >= 0) {
      this.items[existsIndex].title = cleanTitle;
      if (date) this.items[existsIndex].date = date;
      this._sort();
      this._save();
      return false;
    }

    this.items.push({
      messageId: numId,
      title: cleanTitle,
      link,
      date
    });

    this._sort();
    if (this.items.length > MAX_ITEMS) {
      this.items = this.items.slice(0, MAX_ITEMS);
    }

    this._save();
    return true;
  }

  /**
   * Returns paginated list of videos (8 per page, up to 5 pages).
   */
  getPage(page = 1) {
    this._load();
    this._sort();

    const totalItems = this.items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    const safePage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (safePage - 1) * ITEMS_PER_PAGE;
    const pageItems = this.items.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    return {
      items: pageItems,
      currentPage: safePage,
      totalPages,
      totalItems,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages
    };
  }

  /**
   * Formats 8-item catalog text with HTML hyperlinks matching reference UI.
   */
  formatCatalogText(pageData, channelTitle = 'V.I.P 정보공유 (VIP-2)') {
    let text = `👑 <b>${this._escapeHTML(channelTitle)}</b>\n\n`;
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
        const safeTitle = this._escapeHTML(cleanT || `신규 영상 #${item.messageId}`);
        text += `${itemNumber}. <a href="${item.link}">${safeTitle}</a>\n\n`;
      });
    }

    text += `<b>페이지 ${pageData.currentPage}/${pageData.totalPages}</b>`;
    return text;
  }

  /**
   * Builds pagination inline keyboard ([⬅️ 이전] [다음 ➡️] + [🔄 새로고침] + [📢 채널 입장]).
   */
  buildPaginationKeyboard(pageData, inviteLink = 'https://t.me/+HKD-EF-iSK5iN2Rh') {
    const navRow = [];

    if (pageData.hasPrev) {
      navRow.push({
        text: '⬅️ 이전',
        callback_data: `vip2_pg:${pageData.currentPage - 1}`
      });
    }

    if (pageData.hasNext) {
      navRow.push({
        text: '다음 ➡️',
        callback_data: `vip2_pg:${pageData.currentPage + 1}`
      });
    }

    const keyboard = [];
    if (navRow.length > 0) {
      keyboard.push(navRow);
    }

    const actionRow = [
      { text: '🔄 새로고침', callback_data: `vip2_pg:${pageData.currentPage}` }
    ];
    if (inviteLink) {
      actionRow.push({ text: '📢 채널 입장', url: inviteLink });
    }
    keyboard.push(actionRow);

    keyboard.push([
      { text: '🏠 메인 메뉴', callback_data: 'vip2_home' }
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
  Vip2CatalogManager,
  MAX_ITEMS,
  ITEMS_PER_PAGE
};
