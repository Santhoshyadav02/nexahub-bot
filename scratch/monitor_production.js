const https = require('https');

const token = "8878746513:AAGPhdfdmTu-D5_L_jQF-rubjRxvgb0FwFU";

function getBotInfo() {
  return new Promise((resolve) => {
    https.get(`https://api.telegram.org/bot${token}/getMe`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    }).on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function monitor() {
  console.log("Checking Telegram Bot status via getMe API...");
  const botInfo = await getBotInfo();
  if (botInfo.ok) {
    console.log(` ✅ TELEGRAM BOT IS ONLINE & ACTIVE!`);
    console.log(`    Username: @${botInfo.result.username}`);
    console.log(`    Bot Name: ${botInfo.result.first_name}`);
    console.log(`    Bot ID: ${botInfo.result.id}`);
  } else {
    console.log(` ⚠️ Bot status query failed: ${JSON.stringify(botInfo)}`);
  }
}

monitor();
