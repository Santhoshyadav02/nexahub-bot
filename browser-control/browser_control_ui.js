/**
 * Browser Control Dashboard Server & UI.
 * Provides a responsive web interface and REST / SSE API for Playwright Browser Control.
 */

const http = require('http');
const { URL } = require('url');
const { BrowserController, redactUrl } = require('./browser_controller');

function generateHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Playwright Browser Control &amp; Inspector</title>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-card: #1e293b;
      --bg-input: #0f172a;
      --border-color: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-blue: #38bdf8;
      --accent-green: #22c55e;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: var(--bg-primary); color: var(--text-main); padding: 20px; line-height: 1.5; }
    .container { max-width: 1380px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    
    /* Header */
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 15px; }
    header h1 { font-size: 22px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 10px; }
    .badge { padding: 4px 10px; font-size: 12px; font-weight: 600; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-stopped { background: #334155; color: #cbd5e1; }
    .badge-starting { background: #854d0e; color: #fef08a; }
    .badge-running { background: #14532d; color: #86efac; }
    .badge-error { background: #7f1d1d; color: #fca5a5; }
    
    /* Controls Bar */
    .controls-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .input-row { display: flex; gap: 10px; }
    .input-row input { flex: 1; background: var(--bg-input); border: 1px solid var(--border-color); color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 14px; outline: none; }
    .input-row input:focus { border-color: var(--accent-blue); }
    button { padding: 10px 18px; font-size: 14px; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; color: #fff; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-secondary { background: #334155; color: #cbd5e1; }
    .btn-secondary:hover { background: #475569; }

    /* Grid Layout */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

    .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    .card-title { font-size: 16px; font-weight: 600; color: var(--accent-blue); display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; }

    /* Key-Value Lists */
    .kv-list { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
    .kv-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 4px 0; border-bottom: 1px dashed #243248; }
    .kv-item:last-child { border-bottom: none; }
    .kv-key { color: var(--text-muted); font-weight: 500; min-width: 140px; }
    .kv-value { color: #fff; font-family: monospace; word-break: break-all; text-align: right; }
    .highlight-warn { color: var(--accent-amber); font-weight: bold; }
    .highlight-success { color: var(--accent-green); font-weight: bold; }

    /* Tables */
    .table-container { max-height: 240px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #0f172a; color: var(--text-muted); padding: 8px 10px; text-align: left; position: sticky; top: 0; font-weight: 600; }
    td { padding: 8px 10px; border-bottom: 1px solid #243248; font-family: monospace; }
    tr:hover { background: #243248; }
    .tag { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
    .tag-candidate { background: #065f46; color: #6ee7b7; }
    .tag-standard { background: #334155; color: #cbd5e1; }

    /* Activity Logs */
    .log-container { background: #090d16; border: 1px solid var(--border-color); border-radius: 6px; height: 260px; overflow-y: auto; padding: 10px; font-family: 'Courier New', Courier, monospace; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
    .log-line { display: flex; gap: 8px; }
    .log-time { color: #64748b; min-width: 85px; }
    .log-level-info { color: #38bdf8; font-weight: bold; }
    .log-level-warn { color: #f59e0b; font-weight: bold; }
    .log-level-error { color: #ef4444; font-weight: bold; }
    .log-msg { color: #e2e8f0; flex: 1; word-break: break-word; }

    /* Manual Action Required Banner */
    .manual-action-card {
      background: linear-gradient(135deg, #451a03 0%, #1e293b 100%);
      border: 2px solid var(--accent-amber);
      border-radius: 10px;
      padding: 18px 22px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.25);
    }
    .manual-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(245, 158, 11, 0.3);
      padding-bottom: 10px;
    }
    .manual-title {
      font-size: 17px;
      font-weight: 700;
      color: #fef08a;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .manual-timer {
      font-family: monospace;
      font-size: 14px;
      font-weight: 700;
      background: #78350f;
      color: #fef08a;
      padding: 4px 12px;
      border-radius: 6px;
      border: 1px solid #b45309;
    }
    .manual-body {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }
    .manual-desc {
      font-size: 13.5px;
      color: #fde68a;
      max-width: 800px;
    }
    .manual-url-tag {
      font-family: monospace;
      background: #0f172a;
      padding: 3px 8px;
      border-radius: 4px;
      color: var(--accent-blue);
      border: 1px solid var(--border-color);
      display: inline-block;
      margin-top: 4px;
      word-break: break-all;
    }
    .btn-resume {
      background: #16a34a;
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      padding: 12px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(22, 163, 74, 0.35);
    }
    .btn-resume:hover {
      background: #15803d;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Playwright Browser Control &amp; Inspector</h1>
      <div id="browser-status-badge" class="badge badge-stopped">STOPPED</div>
    </header>

    <!-- Manual Action Required Alert Panel -->
    <div id="manual-action-card" class="manual-action-card" style="display: none;">
      <div class="manual-header">
        <div class="manual-title">
          <span>⚠️ MANUAL ACTION REQUIRED — Security Challenge Detected</span>
        </div>
        <div id="manual-elapsed-timer" class="manual-timer">Elapsed: 00:00</div>
      </div>
      <div class="manual-body">
        <div class="manual-desc">
          <div>A legitimate Cloudflare verification challenge has appeared on the target route or player iframe. The browser is <strong>remaining open</strong> to allow normal user verification.</div>
          <div>Target Route: <span id="manual-target-url" class="manual-url-tag">--</span></div>
          <div style="margin-top: 6px; font-size: 12px; color: #cbd5e1;">Complete the verification in the active browser window. Once cleared, click <strong>Resume Inspection</strong> or wait for automatic resumption.</div>
        </div>
        <div>
          <button id="btn-manual-resume" class="btn-resume" onclick="resumeInspection()">▶ Resume Inspection</button>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls-card">
      <div class="input-row">
        <input type="text" id="target-url-input" placeholder="Enter source or player URL (e.g., https://example.com/video)" />
        <button id="btn-start" class="btn-primary" onclick="startBrowser()">Start Browser</button>
        <button id="btn-stop" class="btn-danger" onclick="stopBrowser()">Stop Browser</button>
        <button id="btn-resume-control" class="btn-secondary" onclick="resumeInspection()">Resume</button>
        <button id="btn-inspect" class="btn-secondary" onclick="triggerInspect()">Inspect Now</button>
        <button id="btn-clear-log" class="btn-secondary" onclick="clearLogs()">Clear Log</button>
      </div>
    </div>

    <!-- Status Panels Grid -->
    <div class="grid-2">
      <!-- Browser Status Panel -->
      <div class="card">
        <div class="card-title">
          <span>Browser Status</span>
          <span id="load-state-tag" class="tag tag-standard">UNLOADED</span>
        </div>
        <div class="kv-list">
          <div class="kv-item"><span class="kv-key">Status:</span><span id="stat-browser" class="kv-value">STOPPED</span></div>
          <div class="kv-item"><span class="kv-key">Load State:</span><span id="stat-load" class="kv-value">UNLOADED</span></div>
          <div class="kv-item"><span class="kv-key">Page Title:</span><span id="stat-title" class="kv-value">--</span></div>
          <div class="kv-item"><span class="kv-key">Current URL:</span><span id="stat-current-url" class="kv-value">--</span></div>
          <div class="kv-item"><span class="kv-key">Main Page URL:</span><span id="stat-main-url" class="kv-value">--</span></div>
          <div class="kv-item"><span class="kv-key">Open Tabs Count:</span><span id="stat-tabs" class="kv-value">0</span></div>
        </div>
      </div>

      <!-- Navigation & Recovery Status Panel -->
      <div class="card">
        <div class="card-title">
          <span>Navigation &amp; Recovery Status</span>
        </div>
        <div class="kv-list">
          <div class="kv-item"><span class="kv-key">Challenge Detection:</span><span id="stat-challenge" class="kv-value highlight-success">CLEAR</span></div>
          <div class="kv-item"><span class="kv-key">Closed Popups Count:</span><span id="stat-popups-count" class="kv-value">0</span></div>
          <div class="kv-item"><span class="kv-key">Last Closed Popup URL:</span><span id="stat-last-popup" class="kv-value">None</span></div>
          <div class="kv-item"><span class="kv-key">Main Page Focused:</span><span id="stat-focus" class="kv-value highlight-success">YES</span></div>
        </div>
      </div>
    </div>

    <!-- Frame Inspection Panel -->
    <div class="card">
      <div class="card-title">
        <span>Frame Hierarchy &amp; Candidates</span>
        <span id="stat-frame-count" class="tag tag-standard">0 Frames</span>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Domain</th>
              <th>URL</th>
              <th>Candidate Player</th>
            </tr>
          </thead>
          <tbody id="frames-table-body">
            <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No frames detected</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Video Element Inspection Panel -->
    <div class="card">
      <div class="card-title">
        <span>Discovered Video Elements</span>
        <span id="stat-video-count" class="tag tag-standard">0 Videos</span>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Source Host</th>
              <th>currentSrc (Redacted)</th>
              <th>Ready State</th>
              <th>Paused</th>
              <th>Duration</th>
              <th>Dimensions</th>
            </tr>
          </thead>
          <tbody id="videos-table-body">
            <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No video elements found</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Activity Log Panel -->
    <div class="card">
      <div class="card-title">
        <span>Real-Time Activity Log</span>
      </div>
      <div id="log-console" class="log-container"></div>
    </div>
  </div>

  <script>
    var eventSource = null;
    var waitStartTime = null;
    var timerInterval = null;

    function formatTime(isoStr) {
      if (!isoStr) return '';
      var d = new Date(isoStr);
      return d.toTimeString().split(' ')[0];
    }

    function appendLog(log) {
      var consoleEl = document.getElementById('log-console');
      var line = document.createElement('div');
      line.className = 'log-line';
      
      var timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = '[' + formatTime(log.timestamp) + ']';

      var levelSpan = document.createElement('span');
      levelSpan.className = 'log-level-' + (log.level || 'info').toLowerCase();
      levelSpan.textContent = '[' + log.level + ']';

      var msgSpan = document.createElement('span');
      msgSpan.className = 'log-msg';
      msgSpan.textContent = log.message + (log.details ? ' ' + log.details : '');

      line.appendChild(timeSpan);
      line.appendChild(levelSpan);
      line.appendChild(msgSpan);

      consoleEl.appendChild(line);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    function updateElapsedDisplay() {
      if (!waitStartTime) return;
      var elapsedSec = Math.max(0, Math.floor((Date.now() - waitStartTime) / 1000));
      var mins = Math.floor(elapsedSec / 60);
      var secs = elapsedSec % 60;
      var formatted = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
      document.getElementById('manual-elapsed-timer').textContent = 'Elapsed: ' + formatted;
    }

    function updateUI(state) {
      if (!state) return;

      // Status Badge
      var badge = document.getElementById('browser-status-badge');
      badge.className = 'badge badge-' + state.browserState.toLowerCase();
      badge.textContent = state.browserState;

      // Browser Status
      document.getElementById('stat-browser').textContent = state.browserState;
      document.getElementById('stat-load').textContent = state.loadState;
      document.getElementById('load-state-tag').textContent = state.loadState;
      document.getElementById('stat-title').textContent = state.pageTitle || '--';
      document.getElementById('stat-current-url').textContent = state.currentPageUrl || '--';
      document.getElementById('stat-main-url').textContent = state.mainPageUrl || '--';
      document.getElementById('stat-tabs').textContent = state.openTabsCount || 0;

      // Recovery & Manual Wait Status
      var rec = state.recoveryStatus || {};
      var manual = state.manualWaitStatus || {};
      var challengeEl = document.getElementById('stat-challenge');
      challengeEl.textContent = rec.challengeState || 'CLEAR';

      var manualCard = document.getElementById('manual-action-card');

      if (rec.challengeState === 'LEGITIMATE/MANUAL ACTION REQUIRED' || manual.isWaiting) {
        challengeEl.className = 'kv-value highlight-warn';
        manualCard.style.display = 'flex';
        document.getElementById('manual-target-url').textContent = state.currentPageUrl || '--';

        if (manual.challengeDetectedAt) {
          waitStartTime = new Date(manual.challengeDetectedAt).getTime();
        } else if (!waitStartTime) {
          waitStartTime = Date.now();
        }
        if (!timerInterval) {
          timerInterval = setInterval(updateElapsedDisplay, 1000);
        }
        updateElapsedDisplay();
      } else {
        challengeEl.className = 'kv-value highlight-success';
        manualCard.style.display = 'none';
        waitStartTime = null;
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      }

      document.getElementById('stat-popups-count').textContent = rec.closedPopupsCount || 0;
      document.getElementById('stat-last-popup').textContent = rec.lastClosedPopupUrl || 'None';
      document.getElementById('stat-focus').textContent = rec.isRefocused ? 'YES' : 'NO';

      // Frames Table
      var framesData = state.frameInspection || { totalFrames: 0, frames: [] };
      document.getElementById('stat-frame-count').textContent = framesData.totalFrames + ' Frames';
      var frameTbody = document.getElementById('frames-table-body');
      if (framesData.frames && framesData.frames.length > 0) {
        var frameRows = '';
        for (var i = 0; i < framesData.frames.length; i++) {
          var f = framesData.frames[i];
          var shortUrl = f.url.length > 60 ? f.url.substring(0, 60) + '...' : f.url;
          var tagClass = f.isCandidatePlayerFrame ? 'tag-candidate' : 'tag-standard';
          var tagText = f.isCandidatePlayerFrame ? 'YES (Candidate)' : 'NO';
          frameRows += '<tr>' +
            '<td>' + f.index + '</td>' +
            '<td>' + f.name + '</td>' +
            '<td>' + f.domain + '</td>' +
            '<td title="' + f.url + '">' + shortUrl + '</td>' +
            '<td><span class="tag ' + tagClass + '">' + tagText + '</span></td>' +
            '</tr>';
        }
        frameTbody.innerHTML = frameRows;
      } else {
        frameTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No frames detected</td></tr>';
      }

      // Videos Table
      var videosData = state.videoInspection || { videoCount: 0, videos: [] };
      document.getElementById('stat-video-count').textContent = videosData.videoCount + ' Videos';
      var videoTbody = document.getElementById('videos-table-body');
      if (videosData.videos && videosData.videos.length > 0) {
        var videoRows = '';
        for (var j = 0; j < videosData.videos.length; j++) {
          var v = videosData.videos[j];
          var curSrc = v.currentSrc || 'None';
          var shortSrc = curSrc.length > 50 ? curSrc.substring(0, 50) + '...' : curSrc;
          var durSec = v.duration ? v.duration.toFixed(1) + 's' : 'unknown';
          videoRows += '<tr>' +
            '<td>' + (j + 1) + '</td>' +
            '<td>' + v.sourceHost + '</td>' +
            '<td title="' + curSrc + '">' + shortSrc + '</td>' +
            '<td>' + v.readyState + '</td>' +
            '<td>' + (v.paused ? 'true' : 'false') + '</td>' +
            '<td>' + v.durationFormatted + ' (' + durSec + ')</td>' +
            '<td>' + v.dimensions + '</td>' +
            '</tr>';
        }
        videoTbody.innerHTML = videoRows;
      } else {
        videoTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No video elements found</td></tr>';
      }
    }

    function initSSE() {
      if (eventSource) eventSource.close();
      eventSource = new EventSource('/api/events');

      eventSource.addEventListener('state', function(e) {
        try {
          var state = JSON.parse(e.data);
          updateUI(state);
        } catch (err) {}
      });

      eventSource.addEventListener('log', function(e) {
        try {
          var log = JSON.parse(e.data);
          appendLog(log);
        } catch (err) {}
      });

      eventSource.onerror = function() {
        setTimeout(initSSE, 3000);
      };
    }

    async function fetchInitial() {
      try {
        var res = await fetch('/api/status');
        var state = await res.json();
        updateUI(state);

        var logsRes = await fetch('/api/logs');
        var logs = await logsRes.json();
        var consoleEl = document.getElementById('log-console');
        consoleEl.innerHTML = '';
        logs.forEach(appendLog);
      } catch (e) {}
    }

    async function startBrowser() {
      var url = document.getElementById('target-url-input').value.trim();
      try {
        await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url })
        });
      } catch (e) {
        alert('Failed to start browser: ' + e.message);
      }
    }

    async function stopBrowser() {
      try {
        await fetch('/api/stop', { method: 'POST' });
      } catch (e) {
        alert('Failed to stop browser: ' + e.message);
      }
    }

    async function resumeInspection() {
      try {
        var res = await fetch('/api/resume', { method: 'POST' });
        var data = await res.json();
        if (data.state) updateUI(data.state);
      } catch (e) {
        alert('Failed to resume: ' + e.message);
      }
    }

    async function triggerInspect() {
      try {
        var res = await fetch('/api/inspect', { method: 'POST' });
        var data = await res.json();
        if (data.state) updateUI(data.state);
      } catch (e) {
        alert('Inspection failed: ' + e.message);
      }
    }

    async function clearLogs() {
      try {
        await fetch('/api/clear-logs', { method: 'POST' });
        document.getElementById('log-console').innerHTML = '';
      } catch (e) {}
    }

    window.onload = function() {
      fetchInitial();
      initSSE();
    };
  </script>
</body>
</html>`;
}

class BrowserControlUIServer {
  constructor(controller, options = {}) {
    this.controller = controller || new BrowserController(options);
    this.port = options.port || 3456;
    this.host = options.host || '127.0.0.1';
    this.server = null;
    this.sseClients = new Set();

    // Hook events
    this.controller.on('log', (log) => this.broadcastSSE('log', log));
    this.controller.on('state_updated', (state) => this.broadcastSSE('state', state));
    this.controller.on('inspected', (state) => this.broadcastSSE('state', state));
    this.controller.on('manual_action_required', (state) => this.broadcastSSE('state', state));
    this.controller.on('resumed', (state) => this.broadcastSSE('state', state));
  }

  broadcastSSE(event, data) {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch (e) {
        this.sseClients.delete(res);
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        console.log('Browser Control Dashboard running at http://' + this.host + ':' + this.port + '/');
        resolve(this.server);
      });
      this.server.on('error', reject);
    });
  }

  async handleRequest(req, res) {
    const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathName = parsed.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Static HTML UI
    if (req.method === 'GET' && pathName === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateHtml());
      return;
    }

    // API Status
    if (req.method === 'GET' && pathName === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.controller.getState()));
      return;
    }

    // API Logs
    if (req.method === 'GET' && pathName === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.controller.getLogs()));
      return;
    }

    // SSE Stream
    if (req.method === 'GET' && pathName === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('event: state\ndata: ' + JSON.stringify(this.controller.getState()) + '\n\n');
      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // Helper to read JSON body
    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (e) {
          resolve({});
        }
      });
    });

    // POST /api/start
    if (req.method === 'POST' && pathName === '/api/start') {
      const body = await readBody();
      try {
        const state = await this.controller.start(body.url, body.options || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST /api/stop
    if (req.method === 'POST' && pathName === '/api/stop') {
      try {
        const state = await this.controller.stop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST /api/inspect
    if (req.method === 'POST' && pathName === '/api/inspect') {
      try {
        const state = await this.controller.inspect();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST /api/resume
    if (req.method === 'POST' && pathName === '/api/resume') {
      try {
        const state = await this.controller.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // POST /api/clear-logs
    if (req.method === 'POST' && pathName === '/api/clear-logs') {
      this.controller.clearLogs();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  async stop() {
    for (const res of this.sseClients) {
      try { res.end(); } catch (e) {}
    }
    this.sseClients.clear();

    if (this.controller) {
      await this.controller.stop().catch(() => {});
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }
}

// CLI runner
if (require.main === module) {
  const port = process.env.PORT || 3456;
  const server = new BrowserControlUIServer(null, { port });
  server.start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  BrowserControlUIServer,
  generateHtml
};
