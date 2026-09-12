/**
 * Frame Inspector Module for Playwright Browser Control.
 * Enumerates all frames, identifies candidate player iframes,
 * extracts frame URLs and domains with safe URL redaction.
 */

const { redactUrl } = require('./navigation_recovery');

const PLAYER_HEURISTIC_KEYWORDS = [
  'player',
  'embed',
  'stream',
  'video',
  'vids',
  'media',
  'jwplayer',
  'videojs',
  'play',
  'iframe_player'
];

/**
 * Check if a frame URL or content qualifies as a candidate player frame.
 * @param {import('playwright').Frame} frame
 * @returns {Promise<boolean>}
 */
async function isCandidatePlayerFrame(frame) {
  if (!frame) return false;
  try {
    const frameUrl = (frame.url() || '').toLowerCase();
    
    // Check URL pattern keywords
    if (PLAYER_HEURISTIC_KEYWORDS.some(kw => frameUrl.includes(kw))) {
      return true;
    }

    // Check frame DOM for video elements or video player containers
    const hasVideoOrPlayer = await frame.evaluate(() => {
      const v = document.querySelector('video');
      if (v) return true;
      const playerEl = document.querySelector('.jwplayer, .video-js, [class*="player"], [id*="player"]');
      return Boolean(playerEl);
    }).catch(() => false);

    return Boolean(hasVideoOrPlayer);
  } catch (e) {
    return false;
  }
}

/**
 * Inspect all frames in a page.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ totalFrames: number, frames: Array<Object>, candidatePlayerFrames: Array<Object> }>}
 */
async function inspectFrames(page) {
  if (!page || page.isClosed()) {
    return {
      totalFrames: 0,
      frames: [],
      candidatePlayerFrames: []
    };
  }

  try {
    const allFrames = page.frames();
    const results = [];
    const candidatePlayerFrames = [];

    for (let i = 0; i < allFrames.length; i++) {
      const frame = allFrames[i];
      const rawUrl = frame.url() || '';
      const safeUrl = redactUrl(rawUrl);
      const isMain = (frame === page.mainFrame());
      const name = frame.name() || (isMain ? 'main-frame' : `frame-${i}`);
      
      let domain = 'unknown';
      try {
        if (rawUrl && rawUrl.startsWith('http')) {
          domain = new URL(rawUrl).hostname;
        } else if (rawUrl.startsWith('about:')) {
          domain = 'about:blank';
        }
      } catch (e) {
        domain = 'invalid-url';
      }

      const isCandidate = await isCandidatePlayerFrame(frame);

      let candidateStreamUrl = null;
      let candidateStreamHost = null;
      try {
        if (rawUrl && rawUrl.startsWith('http')) {
          const parsed = new URL(rawUrl);
          for (const paramKey of ['720', '1080', '480', 'file', 'source', 'url', 'src', 'video']) {
            const val = parsed.searchParams.get(paramKey);
            if (val && (val.startsWith('http://') || val.startsWith('https://'))) {
              candidateStreamUrl = redactUrl(val);
              try { candidateStreamHost = new URL(val).hostname; } catch (e) {}
              break;
            }
          }
        }
      } catch (e) {}

      const frameData = {
        index: i,
        name,
        url: safeUrl,
        domain,
        isMainFrame: isMain,
        isCandidatePlayerFrame: isCandidate,
        candidateStreamUrl,
        candidateStreamHost
      };

      results.push(frameData);
      if (isCandidate && !isMain) {
        candidatePlayerFrames.push(frameData);
      }
    }

    return {
      totalFrames: results.length,
      frames: results,
      candidatePlayerFrames
    };
  } catch (err) {
    return {
      totalFrames: 0,
      frames: [],
      candidatePlayerFrames: [],
      error: err.message
    };
  }
}

module.exports = {
  inspectFrames,
  isCandidatePlayerFrame,
  PLAYER_HEURISTIC_KEYWORDS
};
