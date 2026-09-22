import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from bj_scraper import extract_video_from_html

mock_html = """
<html>
<head><title>Test Video Page > AVSee</title></head>
<body>
<h1 class="bo_v_tit">Super Star BJ Live Stream 001</h1>
<div class="jw-media">
  <video class="jw-video jw-reset" tabindex="-1" disableremoteplayback="" webkit-playsinline="" playsinline="" title="" preload="metadata" src="https://data.cdn.avsee.is/bcdn_token=PjL-fqOFlm2Vo9EAqo8xbx7UEVfWaQZR3VNgRkENnrs&amp;expires=1790078870&amp;token_path=%2Fa%2Fs%2FBJ%2F534%2F003.mp4/a/s/BJ/534/003.mp4"></video>
</div>
</body>
</html>
"""

title, mp4_url = extract_video_from_html(mock_html, "https://example.com/post/1")
print(f"Extracted Title: {title}")
print(f"Extracted MP4 URL: {mp4_url}")

assert title == "Super Star BJ Live Stream 001", f"Unexpected title: {title}"
assert "bcdn_token=PjL-fqOFlm2Vo9EAqo8xbx7UEVfWaQZR3VNgRkENnrs&expires=1790078870" in mp4_url, f"Unexpected URL: {mp4_url}"
assert "&amp;" not in mp4_url, "HTML entities must be unescaped"

print("✅ PASSED: extract_video_from_html parsed the exact target video structure successfully!")
