const https = require('https');

function fetchText(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function run() {
  const html = await fetchText('https://awesome-ui.netlify.app/');
  const jsMatches = html.match(/\/assets\/[a-zA-Z0-9_.-]+\.js/g) || [];
  console.log('Found JS files on awesome-ui:', jsMatches.length);
  
  for (const jsPath of jsMatches) {
    const jsUrl = 'https://awesome-ui.netlify.app' + jsPath;
    const code = await fetchText(jsUrl);
    if (code.includes('search') || code.includes('naver') || code.includes('rank') || code.includes('signal') || code.includes('where=')) {
      console.log('\n=== Matching JS:', jsPath);
      const matches = code.match(/https?:\/\/[^\s"'`<>]+/g) || [];
      const filtered = matches.filter(u => u.includes('naver') || u.includes('signal') || u.includes('search') || u.includes('daum') || u.includes('zum') || u.includes('google'));
      if (filtered.length > 0) {
        console.log('  Found URLs:', [...new Set(filtered)]);
      }
      // Check for link construction patterns
      const snippets = code.match(/.{0,50}(?:search\.naver|query|where=|sm=).{0,50}/gi) || [];
      if (snippets.length > 0) {
        console.log('  Found Snippets:', snippets.slice(0, 10));
      }
    }
  }
}
run();
