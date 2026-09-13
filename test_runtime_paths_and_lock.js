/**
 * Offline tests for runtime_paths.js (data dir, seeding, atomic writes,
 * corrupt-file quarantine) and process_lock.js (single-instance guard).
 *
 *   node test_runtime_paths_and_lock.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ [FAIL] ${name}: ${err.message}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexahub-runtime-test-"));
process.env.NEXAHUB_DATA_DIR = path.join(tmpRoot, "data");

const runtimePaths = require("./runtime_paths");
const processLock = require("./process_lock");

runTest("1. NEXAHUB_DATA_DIR is honoured and created on demand", () => {
  const p = runtimePaths.dataPath("x.json");
  assert.strictEqual(path.dirname(p), path.resolve(process.env.NEXAHUB_DATA_DIR));
  assert.ok(fs.existsSync(process.env.NEXAHUB_DATA_DIR));
});

runTest("2. Without NEXAHUB_DATA_DIR the repo directory is used", () => {
  const saved = process.env.NEXAHUB_DATA_DIR;
  delete process.env.NEXAHUB_DATA_DIR;
  try {
    assert.strictEqual(runtimePaths.getDataDir(), runtimePaths.REPO_DIR);
  } finally {
    process.env.NEXAHUB_DATA_DIR = saved;
  }
});

runTest("3. seededDataPath copies the committed file once and never overwrites it afterwards", () => {
  const target = runtimePaths.seededDataPath("pipeline_config.json");
  const seed = fs.readFileSync(path.join(__dirname, "pipeline_config.json"), "utf8");
  assert.strictEqual(fs.readFileSync(target, "utf8"), seed);
  fs.writeFileSync(target, '{"changed":true}', "utf8");
  runtimePaths.seededDataPath("pipeline_config.json");
  assert.strictEqual(fs.readFileSync(target, "utf8"), '{"changed":true}');
});

runTest("4. writeJsonAtomicSync replaces content and leaves no temp files", () => {
  const target = runtimePaths.dataPath("atomic.json");
  runtimePaths.writeJsonAtomicSync(target, { a: 1 });
  runtimePaths.writeJsonAtomicSync(target, { a: 2, list: [1, 2, 3] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 2, list: [1, 2, 3] });
  const leftovers = fs.readdirSync(path.dirname(target)).filter(f => f.endsWith(".tmp"));
  assert.deepStrictEqual(leftovers, []);
});

runTest("5. A failed atomic write keeps the previous file intact", () => {
  const target = runtimePaths.dataPath("keep.json");
  runtimePaths.writeJsonAtomicSync(target, { ok: true });
  const circular = {};
  circular.self = circular;
  assert.throws(() => runtimePaths.writeJsonAtomicSync(target, circular));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
});

runTest("6. quarantineCorruptFile moves the file aside instead of deleting it", () => {
  const target = runtimePaths.dataPath("corrupt.json");
  fs.writeFileSync(target, "{ torn", "utf8");
  const moved = runtimePaths.quarantineCorruptFile(target);
  assert.ok(moved && fs.existsSync(moved));
  assert.ok(!fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(moved, "utf8"), "{ torn");
});

runTest("7. Bot lock: acquire succeeds, a live holder blocks, a dead or previous-boot holder is stale", () => {
  const lockPath = runtimePaths.dataPath("nexahub-bot.lock");
  const first = processLock.acquireBotLock();
  assert.strictEqual(first.acquired, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);

  // Our own lock never blocks us.
  assert.strictEqual(processLock.getActiveLockHolder(), null);

  // A live foreign process holding the lock blocks acquisition.
  const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const bootTime = JSON.parse(fs.readFileSync(lockPath, "utf8")).bootTime;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, bootTime, startedAt: "test" }), "utf8");
    const blocked = processLock.acquireBotLock();
    assert.strictEqual(blocked.acquired, false);
    assert.strictEqual(blocked.holder.pid, child.pid);

    // Same live PID but written during a previous boot -> stale (PID reuse).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, bootTime: bootTime - 24 * 3600 * 1000, startedAt: "test" }), "utf8");
    assert.strictEqual(processLock.getActiveLockHolder(), null);
  } finally {
    child.kill();
  }

  // A dead PID is stale.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, bootTime: Date.now(), startedAt: "test" }), "utf8");
  assert.strictEqual(processLock.getActiveLockHolder(), null);
  assert.strictEqual(processLock.acquireBotLock().acquired, true);
  processLock.releaseBotLock();
  assert.ok(!fs.existsSync(lockPath));
});

runTest("8. Standalone MTProto scripts refuse to run while the bot lock is held", () => {
  const holder = require("child_process").spawn(process.execPath, ["-e", `
    process.env.NEXAHUB_DATA_DIR = ${JSON.stringify(process.env.NEXAHUB_DATA_DIR)};
    const r = require(${JSON.stringify(path.join(__dirname, "process_lock.js"))}).acquireBotLock();
    process.stdout.write(r.acquired ? "LOCKED\\n" : "NOT_LOCKED\\n");
    setTimeout(() => {}, 30000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const start = Date.now();
    const lockPath = runtimePaths.dataPath("nexahub-bot.lock");
    while (Date.now() - start < 10000) {
      try {
        if (JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === holder.pid) break;
      } catch (e) {}
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
    }
    const res = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "process_lock.js"))}).assertBotNotRunning("test-script")`], {
      env: { ...process.env },
      encoding: "utf8"
    });
    assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
    assert.ok(res.stderr.includes("AUTH_KEY_DUPLICATED"));
  } finally {
    holder.kill();
  }
});

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (e) {}

console.log(`\n📊 RUNTIME PATHS & PROCESS LOCK TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
