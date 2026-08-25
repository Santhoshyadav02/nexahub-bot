require("dotenv").config();
const https = require("https");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("No BOT_TOKEN found in .env");
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`;

https.get(url, (res) => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    try {
      const json = JSON.parse(data);
      console.log("=== TELEGRAM DELETE WEBHOOK RESULT ===");
      console.log(JSON.stringify(json, null, 2));
    } catch (e) {
      console.error("Failed to parse JSON:", e.message);
    }
  });
}).on("error", (e) => {
  console.error("HTTP Error:", e.message);
});
