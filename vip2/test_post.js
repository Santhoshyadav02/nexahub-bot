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
    urls = []
    def req_handler(r):
        if '.mp4' in r.url or 'm3u8' in r.url or 'data.cdn' in r.url:
            urls.append(r.url)
    page.on('request', req_handler)
    page.goto('https://02.avsee.is/korea/26886', wait_until='domcontentloaded', timeout=60000)
    time.sleep(5)
    print('Title:', page.title())
    soup = BeautifulSoup(page.content(), 'html.parser')
    for v in soup.find_all(['video', 'source', 'iframe']):
        print('Tag:', v.name, v.attrs)
    print('Network URLs captured:', json.dumps(urls, indent=2))
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
