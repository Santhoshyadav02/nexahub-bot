const assert = require("assert");

const originalEnvSession = process.env.TELEGRAM_SESSION_STRING;
process.env.TELEGRAM_SESSION_STRING = "mock_session_token_123456789";

let mockIsBot = true;
let calls = [];

const MTProtoChannelReader = require("./mtproto_reader");

async function runTests() {
  console.log("=== RUNNING MTPROTO BOT & USER COMPATIBILITY TESTS ===\n");

  // TEST 1: Bot session behavior
  console.log("Test 1: Bot MTProto session verification...");
  calls = [];
  mockIsBot = true;

  // Reset singleton for test
  MTProtoChannelReader.instance = null;
  const botReader = new MTProtoChannelReader();

  // Mock client methods
  botReader.client = {
    connected: false,
    connect: async () => {
      calls.push("connect");
      botReader.client.connected = true;
    },
    isBot: async () => {
      calls.push("isBot");
      return true;
    },
    getDialogs: async () => {
      calls.push("getDialogs");
      throw new Error("400: BOT_METHOD_INVALID (caused by messages.GetDialogs)");
    },
    getEntity: async (identifier) => {
      calls.push(`getEntity:${identifier}`);
      return { id: 12345678, title: "Test Channel", username: "testchannel" };
    },
    invoke: async (request) => {
      calls.push(`invoke:${request.constructor ? request.constructor.name : 'Unknown'}`);
      throw new Error("400: BOT_METHOD_INVALID (caused by messages.GetHistory)");
    },
    getMessages: async () => {
      calls.push("getMessages");
      return [];
    },
    disconnect: async () => {
      calls.push("disconnect");
      botReader.client.connected = false;
    }
  };

  const connectResult = await botReader.connect();
  assert.strictEqual(connectResult, true, "botReader.connect() should return true");
  assert.strictEqual(botReader.isBotSession, true, "botReader.isBotSession should be true");
  assert.strictEqual(botReader.authMode, "BOT_SESSION", "botReader.authMode should be BOT_SESSION for bot");
  assert.strictEqual(calls.includes("getDialogs"), false, "getDialogs should NOT be called during bot connect");

  const syncResults = await botReader.syncAllChannels(5, false);
  assert(Array.isArray(syncResults), "syncResults should be an array");
  assert.strictEqual(syncResults.length, 10, "syncResults should contain 10 target channels");
  assert.strictEqual(calls.includes("getDialogs"), false, "getDialogs should NOT be called during bot channel sync");

  // Verify all channels were classified as SKIPPED_BOT_SESSION
  for (const report of syncResults) {
    assert.strictEqual(report.access, "YES", "Channel access should be YES when getEntity succeeds");
    assert.strictEqual(report.history_status, "SKIPPED_BOT_SESSION", "History status should be SKIPPED_BOT_SESSION for bot");
    assert.strictEqual(report.posts_found, 0, "posts_found should be 0 for bot");
    assert.strictEqual(report.posts.length, 0, "posts should be empty for bot");
  }

  // Verify resolveMediaForPost does not call getDialogs for bot
  calls = [];
  const mediaResult = await botReader.resolveMediaForPost({ username: "unknown_channel", message_id: 100 });
  assert.strictEqual(calls.includes("getDialogs"), false, "resolveMediaForPost should NOT call getDialogs for bot session");

  console.log("✅ Test 1 (Bot MTProto Session) PASS: 0 getDialogs calls, 0 unhandled BOT_METHOD_INVALID errors.\n");

  // TEST 2: User session behavior
  console.log("Test 2: User MTProto session verification...");
  calls = [];
  mockIsBot = false;

  MTProtoChannelReader.instance = null;
  const userReader = new MTProtoChannelReader();

  userReader.client = {
    connected: false,
    connect: async () => {
      calls.push("connect");
      userReader.client.connected = true;
    },
    isBot: async () => {
      calls.push("isBot");
      return false;
    },
    getDialogs: async () => {
      calls.push("getDialogs");
      return [{ entity: { id: 12345678, title: "Test Channel", username: "testchannel" } }];
    },
    getEntity: async (identifier) => {
      calls.push(`getEntity:${identifier}`);
      return { id: 12345678, title: "Test Channel", username: "testchannel" };
    },
    invoke: async (request) => {
      calls.push(`invoke:${request.constructor ? request.constructor.name : 'Unknown'}`);
      return {
        messages: [
          {
            id: 1,
            date: Math.floor(Date.now() / 1000),
            message: "Test message title\nBody content",
            media: null
          }
        ]
      };
    },
    disconnect: async () => {
      calls.push("disconnect");
      userReader.client.connected = false;
    }
  };

  const userConnectResult = await userReader.connect();
  assert.strictEqual(userConnectResult, true, "userReader.connect() should return true");
  assert.strictEqual(userReader.isBotSession, false, "userReader.isBotSession should be false");
  assert.strictEqual(userReader.authMode, "USER_SESSION", "userReader.authMode should be USER_SESSION for user session");
  assert.strictEqual(calls.includes("getDialogs"), true, "getDialogs should be called during user connect");

  calls = [];
  const userSyncResults = await userReader.syncAllChannels(5, false);
  assert(Array.isArray(userSyncResults), "userSyncResults should be an array");
  assert.strictEqual(calls.includes("getDialogs"), true, "getDialogs should be called during user channel sync");

  for (const report of userSyncResults) {
    assert.strictEqual(report.access, "YES", "Channel access should be YES");
    assert.strictEqual(report.history_status, "SUCCESS", "History status should be SUCCESS for user session");
    assert.strictEqual(report.posts_found, 1, "posts_found should be 1 for user session");
  }

  console.log("✅ Test 2 (User MTProto Session) PASS: getDialogs called, history successfully fetched.\n");

  // TEST 3: Unknown / Null session-type fail-closed verification
  console.log("Test 3: Unknown/null MTProto session fail-closed verification...");
  calls = [];

  MTProtoChannelReader.instance = null;
  const unknownReader = new MTProtoChannelReader();

  unknownReader.client = {
    connected: false,
    connect: async () => {
      calls.push("connect");
      unknownReader.client.connected = true;
    },
    isBot: async () => {
      calls.push("isBot");
      throw new Error("RPCError: capability inspection failed");
    },
    getDialogs: async () => {
      calls.push("getDialogs");
      throw new Error("400: BOT_METHOD_INVALID (caused by messages.GetDialogs)");
    },
    getEntity: async (identifier) => {
      calls.push(`getEntity:${identifier}`);
      return { id: 12345678, title: "Test Channel", username: "testchannel" };
    },
    invoke: async (request) => {
      calls.push(`invoke:${request.constructor ? request.constructor.name : 'Unknown'}`);
      throw new Error("invoke should not be called for unverified session");
    },
    getMessages: async () => {
      calls.push("getMessages");
      return [];
    },
    disconnect: async () => {
      calls.push("disconnect");
      unknownReader.client.connected = false;
    }
  };

  const unknownConnectResult = await unknownReader.connect();
  assert.strictEqual(unknownConnectResult, true, "unknownReader.connect() should return true");
  assert.strictEqual(unknownReader.isBotSession, null, "unknownReader.isBotSession should be null when isBot throws");
  assert.strictEqual(unknownReader.authMode, "UNKNOWN_SESSION", "unknownReader.authMode should be UNKNOWN_SESSION");
  assert.strictEqual(calls.includes("getDialogs"), false, "getDialogs should NOT be called for unverified session");

  calls = [];
  const unknownSyncResults = await unknownReader.syncAllChannels(5, false);
  assert(Array.isArray(unknownSyncResults), "unknownSyncResults should be an array");
  assert.strictEqual(calls.includes("getDialogs"), false, "getDialogs should NOT be called during unverified channel sync");
  assert.strictEqual(calls.some(c => c.startsWith("invoke:GetHistory")), false, "GetHistory should NOT be called during unverified sync");

  for (const report of unknownSyncResults) {
    assert.strictEqual(report.access, "YES", "Channel access should be YES");
    assert.strictEqual(report.history_status, "SKIPPED_UNVERIFIED_SESSION", "History status should be SKIPPED_UNVERIFIED_SESSION");
    assert.strictEqual(report.posts_found, 0, "posts_found should be 0");
  }

  calls = [];
  const unknownMediaResult = await unknownReader.resolveMediaForPost({ username: "unknown_channel", message_id: 100 });
  assert.strictEqual(calls.includes("getDialogs"), false, "resolveMediaForPost should NOT call getDialogs for unverified session");

  console.log("✅ Test 3 (Unknown MTProto Session Fail-Closed) PASS: getDialogs/GetHistory never called, classified SKIPPED_UNVERIFIED_SESSION.\n");

  console.log("==========================================");
  console.log("ALL MTPROTO COMPATIBILITY TESTS PASSED!");
  console.log("==========================================");
}

runTests().catch(err => {
  console.error("❌ Test failure:", err);
  process.exit(1);
}).finally(() => {
  process.env.TELEGRAM_SESSION_STRING = originalEnvSession;
});
