const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const cmd = `
    /opt/nexahub-bot/.venv/bin/python3 -c "
from playwright.sync_api import sync_playwright
import re, time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    print('Navigating with Playwright to https://02.avsee.is/bbs/board.php?bo_table=korea ...')
    page.goto('https://02.avsee.is/bbs/board.php?bo_table=korea', timeout=60000)
    time.sleep(4)
    print('Title:', page.title())
    content = page.content()
    matches = set(re.findall(r'bo_table=korea&wr_id=\d+', content))
    print('Found post links with Playwright:', len(matches), list(matches)[:5])
    browser.close()
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
