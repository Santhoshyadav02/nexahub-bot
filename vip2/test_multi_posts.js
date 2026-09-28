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
    context = browser.new_context(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    
    posts = ['https://02.avsee.is/korea/26886', 'https://02.avsee.is/korea/26883']
    for post_url in posts:
        page = context.new_page()
        cdn_urls = []
        def req_h(r):
            if 'data.cdn' in r.url and '.mp4' in r.url:
                cdn_urls.append(r.url)
        page.on('request', req_h)
        page.goto(post_url, wait_until='domcontentloaded', timeout=45000)
        time.sleep(5)
        print(f'URL: {post_url} -> Title: {page.title()} -> CDN URLs: {len(cdn_urls)}')
        if cdn_urls:
            print(f'   Captured: {cdn_urls[0]}')
        page.close()
        time.sleep(2)
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
