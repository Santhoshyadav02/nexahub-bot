const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const pyCode = `
import json, time
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir="/tmp/playwright_vip2_profile",
        headless=True,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://02.avsee.is/korea", wait_until="domcontentloaded", timeout=45000)
    time.sleep(5)
    print("Board Title:", page.title())

    posts = ["https://02.avsee.is/korea/26886", "https://02.avsee.is/korea/26883"]
    for post_url in posts:
        cdn_urls = []
        def req_h(r):
            if "data.cdn" in r.url and ".mp4" in r.url:
                cdn_urls.append(r.url)
        page.on("request", req_h)
        page.goto(post_url, wait_until="domcontentloaded", timeout=45000)
        time.sleep(5)
        print(f"Post: {post_url} -> Title: {page.title()} -> CDN URLs: {len(cdn_urls)}")
        if cdn_urls:
            print(f"  Token URL: {cdn_urls[0]}")
        page.remove_listener("request", req_h)
    context.close()
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
