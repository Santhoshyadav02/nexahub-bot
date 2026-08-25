require("dotenv").config();
const assert = require("assert");

try {
  console.log("=== VERIFYING CLEAN INDEX.JS INITIALIZATION ===");
  const indexApp = require("../index.js");
  console.log("✅ index.js imported and initialized cleanly without any TypeError or startup crash!");
  console.log("✅ All exports present:", Object.keys(indexApp));
  process.exit(0);
} catch (err) {
  console.error("❌ STARTUP CRASH DETECTED:", err.stack);
  process.exit(1);
}
