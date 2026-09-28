const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const pyCode = `
import json, time
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    page.goto('https://02.avsee.is/caption', wait_until='networkidle', timeout=60000)
    for _ in range(10):
        if 'Just a moment' not in page.title():
            break
        time.sleep(1)
    print('Title:', page.title())
    soup = BeautifulSoup(page.content(), 'html.parser')
    posts = []
    for a in soup.find_all('a'):
        href = a.get('href', '')
        if '/caption/' in href:
            text = a.get_text(strip=True)
            posts.append({'title': text, 'href': href})
    print(f'Found {len(posts)} caption posts:')
    for p_item in posts[:10]:
        print(p_item)
    browser.close()
`;

  conn.exec(`/opt/nexahub-bot/.venv/bin/python3 -c "${pyCode.replace(/"/g, '\\"')}"`, (err, stream) => {
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
