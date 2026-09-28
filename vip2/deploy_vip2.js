const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const VPS_HOST = '154.19.187.160';
const VPS_USER = 'root';
const VPS_PASS = 'VNQi7iroRIY-';
const TARGET_DIR = '/opt/nexahub-bot';

async function runSSH() {
  const conn = new Client();

  return new Promise((resolve, reject) => {
    conn.on('ready', () => {
      console.log('✅ SSH Connection established to VPS:', VPS_HOST);
      console.log(`🎯 Target directory on VPS: ${TARGET_DIR}`);

      const deployCmd = `
        cd ${TARGET_DIR} &&
        git fetch origin deploy/vps-hardening-full &&
        git reset --hard origin/deploy/vps-hardening-full &&
        mkdir -p vip2/scrapers
      `;

      conn.exec(deployCmd, (err2, stream2) => {
        if (err2) return reject(err2);
        stream2.on('data', d => process.stdout.write(d.toString()));
        stream2.stderr.on('data', d => process.stderr.write(d.toString()));
        stream2.on('close', async (code) => {
          if (code !== 0) {
            return reject(new Error(`Git pull failed with exit code ${code}`));
          }
          console.log('✅ Git pull complete on VPS.');

          // Open SFTP session
          const sftp = await new Promise((resSftp, rejSftp) => {
            conn.sftp((errSftp, s) => errSftp ? rejSftp(errSftp) : resSftp(s));
          });

          // Upload vip2/.env
          const envContent = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8');
          await new Promise((resW, rejW) => {
            const wStream = sftp.createWriteStream(`${TARGET_DIR}/vip2/.env`);
            wStream.write(envContent);
            wStream.end();
            wStream.on('close', resW);
            wStream.on('error', rejW);
          });
          console.log('✅ vip2/.env uploaded to VPS.');

          // Upload initial catalog and state files if exist
          for (const fname of ['channel_catalog.json', 'processed_ids.json', 'media_signatures.json', 'content_hashes.json', 'config.json']) {
            const localF = path.resolve(__dirname, fname);
            if (fs.existsSync(localF)) {
              const content = fs.readFileSync(localF, 'utf8');
              await new Promise((resW, rejW) => {
                const wStream = sftp.createWriteStream(`${TARGET_DIR}/vip2/${fname}`);
                wStream.write(content);
                wStream.end();
                wStream.on('close', resW);
                wStream.on('error', rejW);
              });
            }
          }
          console.log('✅ vip2 state files uploaded to VPS.');

          // Upload scrapers files (BJ and AV only)
          const scrapersDir = path.resolve(__dirname, 'scrapers');
          if (fs.existsSync(scrapersDir)) {
            const files = fs.readdirSync(scrapersDir);
            for (const f of files) {
              const fp = path.resolve(scrapersDir, f);
              if (fs.statSync(fp).isFile()) {
                const content = fs.readFileSync(fp);
                await new Promise((resW, rejW) => {
                  const wStream = sftp.createWriteStream(`${TARGET_DIR}/vip2/scrapers/${f}`);
                  wStream.write(content);
                  wStream.end();
                  wStream.on('close', resW);
                  wStream.on('error', rejW);
                });
              }
            }
            console.log('✅ vip2 BJ & AV scraper files uploaded to VPS.');
          }

          // PM2: Delete old VIP-1 bot (@INFINITY_121_bot) and vip-pipeline, keeping only nexahub-bot and vip2-bot
          const pm2Cmd = `
            cd ${TARGET_DIR} &&
            echo "🛑 Stopping & Deleting old VIP-1 bot (vip-bot & vip-pipeline)..." &&
            pm2 delete vip-bot 2>/dev/null || true &&
            pm2 delete vip-pipeline 2>/dev/null || true &&
            pm2 delete vip2-bot 2>/dev/null || true &&
            echo "🚀 Starting new VIP-2 Bot (@VIP_2211bot)..." &&
            pm2 start vip2/index.js --name vip2-bot &&
            pm2 save &&
            echo "📊 Current PM2 Process List:" &&
            pm2 status &&
            sleep 4 &&
            pm2 logs vip2-bot --lines 30 --nostream
          `;

          conn.exec(pm2Cmd, (err3, stream3) => {
            if (err3) return reject(err3);
            stream3.on('data', d => process.stdout.write(d.toString()));
            stream3.stderr.on('data', d => process.stderr.write(d.toString()));
            stream3.on('close', () => {
              console.log('\n🎉 VIP-1 Bot deleted, BJ & AV connected to VIP-2 Bot, and deployment finished!');
              conn.end();
              resolve();
            });
          });
        });
      });
    }).connect({
      host: VPS_HOST,
      port: 22,
      username: VPS_USER,
      password: VPS_PASS,
      readyTimeout: 30000
    });
  });
}

runSSH().catch(err => {
  console.error('❌ VPS Deployment Error:', err);
  process.exit(1);
});
