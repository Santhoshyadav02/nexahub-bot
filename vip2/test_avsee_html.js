const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const cmd = `
    /opt/nexahub-bot/.venv/bin/python3 -c "
import urllib.request, re
req = urllib.request.Request('https://02.avsee.is/bbs/board.php?bo_table=korea', headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req, timeout=15) as res:
        html = res.read().decode('utf-8', errors='ignore')
        matches = re.findall(r'bo_table=korea&wr_id=\d+', html)
        print('Direct HTML fetch matches for korea:', len(matches), set(matches[:5]))
except Exception as e:
    print('Error:', e)
"
  `;
  conn.exec(cmd, (err, stream) => {
    if (err) throw err;
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
    stream.on('close', (c) => {
      console.log('Exit code:', c);
      conn.end();
    });
  });
}).connect({
  host: '154.19.187.160',
  port: 22,
  username: 'root',
  password: 'VNQi7iroRIY-'
});
