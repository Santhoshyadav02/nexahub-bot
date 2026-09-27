/**
 * ============================================================
 * 🌸 VIP-2 CAPTION FORMATTER & KOREAN TRANSLATOR
 * ============================================================
 * Processes captions from @DreamTraveleo source channel,
 * translates Chinese adult hashtags and descriptions into natural
 * Korean, and formats clean Telegram HTML captions with channel links.
 */

const { translateToKorean } = require('../korean_caption_generator');

const HASHTAG_DICTIONARY = {
  '#高颜值': '#여신 #고화질',
  '#露脸': '#얼굴공개',
  '#御姐': '#글래머누님',
  '#网红': '#인플루언서',
  '#清纯': '#청순',
  '#少女': '#미소녀',
  '#自拍': '#셀카자위',
  '#反差': '#반전매력',
  '#萝莉': '#로리',
  '#高中生': '#여고생',
  '#极品': '#레전드',
  '#白虎': '#무모백호',
  '#大学生': '#여대생',
  '#丰满': '#풍만글래머',
  '#黑丝': '#검스코스타킹',
  '#肥臀': '#글래머힙',
  '#足控': '#풋잡페티쉬',
  '#丝袜': '#스타킹',
  '#微胖': '#육덕글래머',
  '#自慰': '#자위',
  '#调教': '#조교',
  '#包养': '#스폰서',
  '#露出': '#노출',
  '#福利': '#스페셜'
};

function translateHashtags(rawText) {
  if (!rawText) return '#VIP2 #신규영상';
  let processed = rawText;
  for (const [chTag, koTag] of Object.entries(HASHTAG_DICTIONARY)) {
    processed = processed.replace(new RegExp(chTag, 'g'), koTag);
  }
  return processed;
}

function extractHashtagsAndBody(rawMessage) {
  if (!rawMessage) return { hashtags: '', body: '', raw: '' };

  const lines = rawMessage.split('\n').map(l => l.trim()).filter(Boolean);
  const tagLines = [];
  const bodyLines = [];

  for (const line of lines) {
    if (line.includes('#')) {
      tagLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }

  const rawTags = tagLines.join(' ');
  const rawBody = bodyLines.join('\n\n');

  return {
    hashtags: rawTags,
    body: rawBody,
    raw: rawMessage
  };
}

async function formatVip2Caption(rawMessage, inviteLink = 'https://t.me/+HKD-EF-iSK5iN2Rh') {
  if (!rawMessage || !rawMessage.trim()) {
    return {
      title: 'V.I.P-2 신규 추천 영상',
      caption: `👑 <b>V.I.P 정보공유 (VIP-2)</b>\n\n🎬 <b>신규 고화질 영상이 업데이트되었습니다.</b>\n\n👉 <b><a href="${inviteLink}">V.I.P 정보공유 채널 바로가기</a></b>`
    };
  }

  const { hashtags, body } = extractHashtagsAndBody(rawMessage);

  let koreanTags = '';
  if (hashtags) {
    koreanTags = translateHashtags(hashtags);
  }

  let koreanBody = '';
  if (body) {
    try {
      koreanBody = await translateToKorean(body);
    } catch (e) {
      koreanBody = body;
    }
  }

  // Derive concise title for catalog
  let title = '';
  if (koreanBody) {
    const firstSentence = koreanBody.split(/[.\n]/)[0].trim();
    title = firstSentence.length > 80 ? firstSentence.substring(0, 77) + '...' : firstSentence;
  } else if (koreanTags) {
    title = koreanTags.replace(/#/g, '').replace(/\s+/g, ' ').trim();
  }

  if (!title) {
    title = 'V.I.P-2 신규 영상';
  }

  // Build final HTML formatted channel post caption
  let caption = `👑 <b>V.I.P 정보공유 (VIP-2)</b>\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (koreanTags) {
    caption += `🏷️ <code>${koreanTags}</code>\n\n`;
  }

  if (koreanBody) {
    caption += `📝 <b>${koreanBody}</b>\n\n`;
  }

  caption += `👉 <b><a href="${inviteLink}">V.I.P 정보공유 채널 입장하기 ↗️</a></b>`;

  return {
    title,
    caption,
    koreanTags,
    koreanBody
  };
}

module.exports = {
  formatVip2Caption,
  translateHashtags,
  extractHashtagsAndBody
};
