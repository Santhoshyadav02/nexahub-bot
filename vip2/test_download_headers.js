const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to VPS');
  const pyCode = `
import json, time, requests
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    page = context.new_page()
    urls = []
    def req_handler(r):
        if 'data.cdn' in r.url and '.mp4' in r.url:
            urls.append({'url': r.url, 'headers': r.headers})
    page.on('request', req_handler)
    page.goto('https://02.avsee.is/korea/26886', wait_until='domcontentloaded', timeout=60000)
    time.sleep(5)
    cookies = context.cookies()
    browser.close()

print('Captured:', len(urls))
if urls:
    item = urls[0]
    cdn_url = item['url']
    req_headers = item['headers']
    print('CDN URL:', cdn_url)
    print('Request Headers from browser:', json.dumps(req_headers, indent=2))
    
    # Test downloading 100KB with browser headers
    try:
        r = requests.get(cdn_url, headers=req_headers, stream=True, timeout=15)
        print('Download status with browser headers:', r.status_code)
        if r.status_code in [200, 206]:
            print('Content length:', r.headers.get('content-length'))
    except Exception as e:
        print('Error:', e)

    # Test downloading with minimal headers
    try:
        h2 = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://02.avsee.is/'
        }
        r2 = requests.get(cdn_url, headers=h2, stream=True, timeout=15)
        print('Download status with minimal headers:', r2.status_code)
    except Exception as e:
        print('Error 2:', e)
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
