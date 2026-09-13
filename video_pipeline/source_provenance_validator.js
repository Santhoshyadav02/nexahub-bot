/**
 * ============================================================
 * 🔗 SOURCE PROVENANCE VALIDATOR
 * ============================================================
 * Deliberately SEPARATE from media_validator.js's technical validation.
 *
 * TECHNICAL VALIDATION (media_validator.js) answers: "can this file be
 * played? is it a real, undamaged video?" A tiny 1-second internal fixture
 * clip answers that question exactly as validly as a real-source video -
 * technical validity says nothing about WHERE the bytes came from.
 *
 * SOURCE PROVENANCE VALIDATION (this file) answers a completely different
 * question: "does this media record actually belong to the source/post it
 * claims to, and is its source_mode self-consistent?" A fixture clip must
 * never be able to pass this check while claiming to be authorized-source
 * media, and vice versa.
 *
 * Both must pass before publication. Neither is a substitute for the other.
 */

const VALID_SOURCE_MODES = new Set(['fixture', 'authorized']);

/**
 * @param {object} media Media record (sourceMode, isFixtureMedia,
 *   sourcePageUrl, sourceVideoUrl, contentSha256, filePath)
 * @returns {{
 *   valid: boolean,
 *   checks: Record<string, boolean>,
 *   error: string|null
 * }}
 */
function validateSourceProvenance(media) {
  const checks = {
    sourceModeKnown: false,
    sourcePageUrlPresent: false,
    sourceVideoUrlPresent: false,
    sourceVideoUrlConsistentWithPage: false,
    contentSha256Linked: false,
    isFixtureMediaFlagConsistent: false
  };

  if (!media || typeof media !== 'object') {
    return { valid: false, checks, error: 'No media record supplied to provenance validation.' };
  }

  // 1. source_mode is a known, explicit value - never inferred/guessed.
  checks.sourceModeKnown = VALID_SOURCE_MODES.has(media.sourceMode);

  // 2. source_page_url is present and looks like a real URL (fixture or
  // authorized - both must still originate from SOME identifiable page;
  // an empty/missing page URL means the record cannot be traced to any post).
  checks.sourcePageUrlPresent = Boolean(media.sourcePageUrl) && /^https?:\/\//i.test(media.sourcePageUrl);

  // 3. source_video_url is present and well-formed.
  checks.sourceVideoUrlPresent = Boolean(media.sourceVideoUrl) && /^https?:\/\//i.test(media.sourceVideoUrl);

  // 4. source_video_url must belong to the SAME origin as source_page_url -
  // catches a media record whose video URL was somehow associated with a
  // different site/post than the one it claims to have been discovered on.
  if (checks.sourcePageUrlPresent && checks.sourceVideoUrlPresent) {
    try {
      const pageOrigin = new URL(media.sourcePageUrl).origin;
      const videoOrigin = new URL(media.sourceVideoUrl).origin;
      checks.sourceVideoUrlConsistentWithPage = pageOrigin === videoOrigin;
    } catch (e) {
      checks.sourceVideoUrlConsistentWithPage = false;
    }
  }

  // 5. The media record must be linked to a specific, computed artifact hash
  // - a record with no SHA256 cannot be tied to any particular downloaded file.
  checks.contentSha256Linked = Boolean(media.contentSha256) && typeof media.contentSha256 === 'string' && media.contentSha256.length >= 32;

  // 6. isFixtureMedia must agree with sourceMode - the exact "fixture
  // represented as authorized" case this check exists to catch.
  if (checks.sourceModeKnown) {
    const expectedFlag = media.sourceMode === 'fixture';
    checks.isFixtureMediaFlagConsistent = media.isFixtureMedia === expectedFlag;
  }

  const valid = Object.values(checks).every(Boolean);
  let error = null;
  if (!valid) {
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    error = `Source provenance validation failed: ${failed.join(', ')}`;
  }

  return { valid, checks, error };
}

module.exports = { validateSourceProvenance, VALID_SOURCE_MODES };
