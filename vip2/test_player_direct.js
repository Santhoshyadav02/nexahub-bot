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
    
    # 1. Load board page to get post links
    page.goto('https://02.avsee.is/korea', wait_until='domcontentloaded', timeout=45000)
    time.sleep(4)
    soup = BeautifulSoup(page.content(), 'html.parser')
    posts = []
    for a in soup.find_all('a', href=True):
        if '/korea/' in a['href'] and a.get_text(strip=True):
            posts.append({'title': a.get_text(strip=True), 'url': f"https://02.avsee.is{a['href']}"})
    print(f'Found {len(posts)} posts')

    # Test first 2 posts
    for p_item in posts[:2]:
        print(f"Loading post: {p_item['title']} -> {p_item['url']}")
        page.goto(p_item['url'], wait_until='domcontentloaded', timeout=45000)
        time.sleep(3)
        soup_post = BeautifulSoup(page.content(), 'html.parser')
        iframe = soup_post.find('iframe', src=lambda s: s and 'player.php' in s)
        if iframe:
            player_url = f"https://02.avsee.is{iframe['src']}" if iframe['src'].startswith('/') else iframe['src']
            print(f"  Player URL: {player_url}")
            cdn_tokens = []
            def req_h(r):
                if 'data.cdn' in r.url and '.mp4' in r.url:
                    cdn_tokens.append(r.url)
            page.on('request', req_h)
            page.goto(player_url, wait_until='domcontentloaded', timeout=30000)
            time.sleep(4)
            page.remove_listener('request', req_h)
            print(f"  Tokens found: {len(cdn_tokens)}")
            if cdn_tokens:
                print(f"  Token URL: {cdn_tokens[0]}")
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
