/**
 * Browser Control Module Exports
 */

const { NavigationRecovery, detectChallenge, redactUrl, CHALLENGE_STATES } = require('./navigation_recovery');
const { inspectFrames, isCandidatePlayerFrame } = require('./frame_inspector');
const { inspectVideos, inspectFrameVideos, READY_STATE_MAP } = require('./video_inspector');
const { BrowserController, BROWSER_STATES, LOAD_STATES } = require('./browser_controller');
const { BrowserControlUIServer } = require('./browser_control_ui');
const { VideoSourceCapture, CAPTURE_STATES, ACTION_DELAY_MIN_MS, ACTION_DELAY_MAX_MS, humanDelay } = require('./video_source_capture');
const {
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  getPacingConfig,
  computeBoundedDelay,
  sleep,
  waitBeforeAction,
  waitAfterAction,
  pacedClick,
  pacedHover,
  pacedMouseMove,
  pacedPress,
  pacedFill
} = require('./interaction_pacing');

module.exports = {
  NavigationRecovery,
  detectChallenge,
  redactUrl,
  CHALLENGE_STATES,
  inspectFrames,
  isCandidatePlayerFrame,
  inspectVideos,
  inspectFrameVideos,
  READY_STATE_MAP,
  BrowserController,
  BROWSER_STATES,
  LOAD_STATES,
  BrowserControlUIServer,
  VideoSourceCapture,
  CAPTURE_STATES,
  ACTION_DELAY_MIN_MS,
  ACTION_DELAY_MAX_MS,
  humanDelay,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  getPacingConfig,
  computeBoundedDelay,
  sleep,
  waitBeforeAction,
  waitAfterAction,
  pacedClick,
  pacedHover,
  pacedMouseMove,
  pacedPress,
  pacedFill
};
