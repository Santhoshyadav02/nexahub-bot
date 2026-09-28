const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const pyCode = `
import json, time
from playwright.sync_api import sync_playwright

def get_post_video(url):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled", "--no-sandbox"])
        context = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        page = context.new_page()
        cdn_urls = []
        def req_h(r):
            if "data.cdn" in r.url and ".mp4" in r.url:
                cdn_urls.append(r.url)
        page.on("request", req_h)
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        time.sleep(5)
        title = page.title()
        token = cdn_urls[0] if cdn_urls else None
        browser.close()
        return title, token

posts = ["https://02.avsee.is/korea/26886", "https://02.avsee.is/korea/26883", "https://02.avsee.is/caption/52858"]
for post in posts:
    t, tok = get_post_video(post)
    print(f"Post: {post}")
    print(f"  Title: {t}")
    print(f"  Token: {tok is not None}")
    if tok:
        print(f"  URL: {tok[:80]}...")
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
