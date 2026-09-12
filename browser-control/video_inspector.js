/**
 * Video Inspector Module for Playwright Browser Control.
 * Discovers HTML5 <video> elements across main page and all frames,
 * extracts playback state, dimensions, duration, and applies strict URL redaction.
 */

const { redactUrl } = require('./navigation_recovery');

const READY_STATE_MAP = {
  0: 'HAVE_NOTHING',
  1: 'HAVE_METADATA',
  2: 'HAVE_CURRENT_DATA',
  3: 'HAVE_FUTURE_DATA',
  4: 'HAVE_ENOUGH_DATA'
};

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds <= 0) {
    return '0:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/**
 * Inspect video elements in a specific frame.
 * @param {import('playwright').Frame} frame
 * @param {number} frameIndex
 * @param {boolean} isMainFrame
 * @returns {Promise<Array<Object>>}
 */
async function inspectFrameVideos(frame, frameIndex, isMainFrame) {
  if (!frame) return [];
  try {
    const rawVideos = await frame.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('video'));
      return elements.map((v, idx) => {
        let activeSrc = v.currentSrc || v.src || '';
        if (!activeSrc) {
          const sourceEl = v.querySelector('source');
          if (sourceEl) {
            activeSrc = sourceEl.src || sourceEl.getAttribute('src') || '';
          }
        }

        return {
          tagIndex: idx,
          currentSrc: v.currentSrc || '',
          srcAttribute: v.getAttribute('src') || '',
          resolvedSrc: activeSrc,
          readyState: v.readyState,
          paused: Boolean(v.paused),
          duration: (typeof v.duration === 'number' && !isNaN(v.duration) && isFinite(v.duration)) ? v.duration : null,
          videoWidth: v.videoWidth || 0,
          videoHeight: v.videoHeight || 0,
          clientWidth: v.clientWidth || 0,
          clientHeight: v.clientHeight || 0,
          muted: Boolean(v.muted),
          autoplay: Boolean(v.autoplay),
          loop: Boolean(v.loop)
        };
      });
    }).catch(() => []);

    const frameUrl = redactUrl(frame.url() || '');

    return rawVideos.map((v, i) => {
      const safeCurrentSrc = redactUrl(v.currentSrc || v.resolvedSrc);
      const safeSrcAttr = redactUrl(v.srcAttribute);
      
      let sourceHost = 'unknown';
      try {
        const urlToParse = v.currentSrc || v.resolvedSrc || v.srcAttribute;
        if (urlToParse && urlToParse.startsWith('http')) {
          sourceHost = new URL(urlToParse).hostname;
        } else if (urlToParse && urlToParse.startsWith('blob:')) {
          sourceHost = 'blob';
        }
      } catch (e) {
        sourceHost = 'invalid-host';
      }

      const dimensions = (v.videoWidth && v.videoHeight)
        ? `${v.videoWidth}x${v.videoHeight}`
        : (v.clientWidth && v.clientHeight ? `${v.clientWidth}x${v.clientHeight} (client)` : 'unknown');

      return {
        frameIndex,
        frameUrl,
        isMainFrame,
        tagIndex: v.tagIndex,
        currentSrc: safeCurrentSrc,
        srcAttribute: safeSrcAttr,
        readyState: READY_STATE_MAP[v.readyState] || `UNKNOWN(${v.readyState})`,
        readyStateCode: v.readyState,
        paused: v.paused,
        duration: v.duration,
        durationFormatted: formatDuration(v.duration),
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        dimensions,
        sourceHost,
        muted: v.muted,
        autoplay: v.autoplay
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Discovers and inspects all video elements across all frames in a page.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ videoCount: number, videos: Array<Object> }>}
 */
async function inspectVideos(page) {
  if (!page || page.isClosed()) {
    return {
      videoCount: 0,
      videos: []
    };
  }

  try {
    const allFrames = page.frames();
    const allVideos = [];

    for (let i = 0; i < allFrames.length; i++) {
      const frame = allFrames[i];
      const isMain = (frame === page.mainFrame());
      const frameVideos = await inspectFrameVideos(frame, i, isMain);
      allVideos.push(...frameVideos);
    }

    return {
      videoCount: allVideos.length,
      videos: allVideos
    };
  } catch (err) {
    return {
      videoCount: 0,
      videos: [],
      error: err.message
    };
  }
}

module.exports = {
  inspectVideos,
  inspectFrameVideos,
  READY_STATE_MAP,
  formatDuration
};
