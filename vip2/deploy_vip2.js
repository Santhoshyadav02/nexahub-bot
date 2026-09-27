const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const VPS_HOST = '154.19.187.160';
const VPS_USER = 'root';
const VPS_PASS = 'VNQi7iroRIY-';

async function runSSH() {
  const conn = new Client();

  return new Promise((resolve, reject) => {
    conn.on('ready', () => {
      console.log('✅ SSH Connection established to VPS:', VPS_HOST);

      // Find the repository directory on VPS
      const checkCmd = 'find /root -maxdepth 3 -name "catalog_manager.js" 2>/dev/null';
      conn.exec(checkCmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log('Found repo paths:\n', out);

          // Let's determine project root
          const lines = out.trim().split('\n').filter(Boolean);
          let targetDir = '/root/hiruboy';
          if (lines.length > 0) {
            targetDir = path.posix.dirname(path.posix.dirname(lines[0]));
          }
          console.log(`🎯 Target directory on VPS: ${targetDir}`);

          // Deployment commands
          const deployCmd = `
            cd ${targetDir} &&
            git fetch origin deploy/vps-hardening-full &&
            git reset --hard origin/deploy/vps-hardening-full &&
            mkdir -p vip2
          `;

          conn.exec(deployCmd, (err2, stream2) => {
            if (err2) return reject(err2);
            stream2.on('data', d => process.stdout.write(d.toString()));
            stream2.stderr.on('data', d => process.stderr.write(d.toString()));
            stream2.on('close', async () => {
              console.log('✅ Git pull complete on VPS.');

              // Upload vip2/.env
              const envContent = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8');
              const sftp = await new Promise((resSftp, rejSftp) => {
                conn.sftp((errSftp, s) => errSftp ? rejSftp(errSftp) : resSftp(s));
              });

              await new Promise((resW, rejW) => {
                const wStream = sftp.createWriteStream(`${targetDir}/vip2/.env`);
                wStream.write(envContent);
                wStream.end();
                wStream.on('close', resW);
                wStream.on('error', rejW);
              });
              console.log('✅ vip2/.env uploaded to VPS.');

              // Upload initial catalog and processed IDs if exist
              for (const fname of ['channel_catalog.json', 'processed_ids.json', 'config.json']) {
                const localF = path.resolve(__dirname, fname);
                if (fs.existsSync(localF)) {
                  const content = fs.readFileSync(localF, 'utf8');
                  await new Promise((resW, rejW) => {
                    const wStream = sftp.createWriteStream(`${targetDir}/vip2/${fname}`);
                    wStream.write(content);
                    wStream.end();
                    wStream.on('close', resW);
                    wStream.on('error', rejW);
                  });
                }
              }
              console.log('✅ vip2 state files uploaded to VPS.');

              // PM2 start/restart
              const pm2Cmd = `
                cd ${targetDir} &&
                pm2 delete vip2-bot 2>/dev/null || true &&
                pm2 start vip2/index.js --name vip2-bot &&
                pm2 save &&
                pm2 status &&
                sleep 4 &&
                pm2 logs vip2-bot --lines 25 --nostream
              `;

              conn.exec(pm2Cmd, (err3, stream3) => {
                if (err3) return reject(err3);
                stream3.on('data', d => process.stdout.write(d.toString()));
                stream3.stderr.on('data', d => process.stderr.write(d.toString()));
                stream3.on('close', () => {
                  console.log('\n🎉 VIP-2 VPS Deployment finished successfully!');
                  conn.end();
                  resolve();
                });
              });
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
