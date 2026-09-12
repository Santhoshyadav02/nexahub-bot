# DOM video link scraper

## Recommended: one command, without extension

```powershell
powershell -ExecutionPolicy Bypass -File .\run_scraper.ps1
```

Ye dedicated Chrome window start/reuse karta hai aur connection ready hone ka wait karta hai.
Usi window mein website manually open karo, login/verification complete karke post open
hona confirm karo, phir terminal mein Enter dabao. Cancel ke liye `q` type karo.
Scraper usi session mein saved post links process karega. JSON `output/videos.json`
mein save hota hai. Extension aur incognito ki zarurat nahi.

Ye everyday Chrome profile ko import nahi karta. Agar dedicated window mein bhi site
manually nahi khulti, `q` se cancel karo; scraper chalana is access issue ko solve nahi karega.
Unresolved verification par batch rukta hai aur challenge tab inspection ke liye open rehta hai.
Edge use karna ho: `powershell -ExecutionPolicy Bypass -File .\run_scraper.ps1 -Browser edge`.

`ECONNREFUSED 127.0.0.1:9222` ka matlab scraper browser debug endpoint se connect
nahi kar paya. Launcher ab Enter ke baad endpoint dobara check karta hai. Window
band ho gayi ho toh browser restart karke manual readiness dobara poochta hai.
Dedicated window ko poore run ke dauran open rakho. `DEP0169` warning aur
connection-refused error alag messages hain; warning ko suppress karna connection fix nahi hai.

## Script behavior

Python script main page ke rendered DOM se `.main-box .post-image a[href]` links collect karti hai,
duplicates remove karti hai, phir har link ko one by one open karti hai.
Har detail page aur uske iframes mein `.jw-media video.jw-video` se
`currentSrc`, `src`, aur child `<source src>` read hote hain.

## Setup

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Run

Sirf main page ke links `output/post_links.json` mein save karne ke liye:

```powershell
python scrape_videos.py "https://YOUR-WEBSITE.com" --links-only --headed
```

```powershell
python scrape_videos.py "https://YOUR-WEBSITE.com"
```

Browser dikhane, lazy-loaded posts ke liye scroll karne, aur video initialize karne ke liye:

```powershell
python scrape_videos.py "https://YOUR-WEBSITE.com" --headed --scrolls 5 --play --timeout 45
```

Output sirf JSON: `output/post_links.json`, `output/videos.json`.
Har post ke baad results save hote hain. Failed post record hota hai aur next post continue hota hai.
Dobara run karne par same output files overwrite hongi; alag folder ke liye `--output results2` use karo.

Sirf supplied listing page ke loaded links collect hote hain; pagination automatic nahi hai.
Empty source timeout tak wait karta hai, phir `not_found` record hota hai.
`--play` muted playback try karta hai; custom player button ki zarurat ho toh site-specific adjustment chahiye.
`blob:` URL browser session ka temporary reference hai, direct downloadable video link nahi.
Script sirf DOM sources extract karti hai; media download nahi karti.

Playwright setup/API reference: https://playwright.dev/python/docs/library

## JSON se MP4 download

```powershell
python download_videos.py output/videos.json
```

MP4 files `downloads/` mein aur status/errors `downloads/download_report.json` mein save honge.
Downloader Python standard library use karta hai, extra package nahi chahiye.
Duplicate URLs ek baar download hote hain; existing nonempty files skip hoti hain.
Failed download ki temporary file remove hoti hai aur next video continue hota hai.
Download ke dauran `.mp4.part` temporary file dikhegi; successful completion par
`.mp4` banegi. Terminal mein downloaded MB aur available hone par percentage dikhte hain.
Running download ko sirf `.part` extension dekhkar failed mat samjho.
Output folder badalne ke liye `--output my-videos` use karo.

Direct MP4 responses supported hain. `blob:`, HLS (`.m3u8`), DASH, ya login cookies
required sources is script se download nahi honge. Expired links ke liye scraper dobara run karo.

## Saved links aur human verification

```powershell
python scrape_videos.py --input-links output/post_links.json --headed --play --timeout 60 --verification-wait 180
```

Detail page par recognizable human-verification text detect hone par script browser mein
manual verification ke liye wait karti hai, phir source collection continue karti hai.
Checkbox automatically click nahi hota. Detection text-based hai, har challenge detect hona guaranteed nahi.
Verification timeout par `verification_required` aur reason JSON mein save hote hain.
Source timeout par `not_found` ke saath explanation save hoti hai.

Player ke `div[data-cl-overlay]` par script automatically ek baar click karti hai.
Us detail page se khulne wale popup tabs close hote hain; original tab mein
`.jw-media video.jw-video` ka source wait/read hota hai. Dynamic CSS class ki jagah
`data-cl-overlay` attribute use hota hai. Ye player overlay click hai; human
verification ab bhi manually complete karni hoti hai.

Current flow: visible overlay ke liye timeout tak wait (iframes included), click,
popup ke liye up to 5s wait/close, original tab focus, phir video source ke liye
fresh timeout. `div.p6driy29haev` class fallback bhi included hai. Popup na aaye toh
original tab par video check continue hota hai. Overlay na mile toh
`overlay_not_found` reason save hota hai aur next post process hota hai.
`--timeout 60` ke saath overlay aur video phases ko alag 60s budgets milte hain.

Browser session/cookies ko runs ke beech reuse karne ke liye:

```powershell
python scrape_videos.py --input-links output/post_links.json --headed --play --timeout 60 --verification-wait 180 --profile browser-profile
```

Pehli verification manually complete karo. Agle runs mein wahi `--profile` folder
use karo. Site dobara challenge kar sakti hai; automatic verification ki guarantee nahi.
Ek profile se ek waqt mein ek hi scraper run karo. Profile folder mein session data hota hai.

Saved links process karte waqt posts ek hi visible tab mein one by one open hote hain.
Terminal mein `Opening post`, HTTP status aur errors dikhte hain. Navigation commit hone
ke baad slow DOM loading ke bawajood player check continue hota hai.
`--input-links` mode input post-links file ko overwrite nahi karta.

Verification reload ke beech temporary disappearance ko success nahi maana jata:
page ko kam se kam 3 seconds challenge-free aur loaded rehna hota hai.
Challenge dobara aaye toh remaining verification wait use hota hai, turant failure nahi.

## Manually opened Chrome session se connect

```powershell
powershell -ExecutionPolicy Bypass -File .\start_browser.ps1
```

Opened Chrome window mein website manually open karke login/verification complete karo.
Window open rakho, phir same terminal mein:

```powershell
python scrape_videos.py --input-links output/post_links.json --cdp-url http://127.0.0.1:9222 --play --timeout 60 --verification-wait 300
```

Script isi browser context ke session mein ek apna tab banati hai. Finish hone par
sirf apna tab close karti hai; manually opened browser/tabs open rehte hain.
Agli baar same launcher use karne se dedicated session reuse hota hai.
Edge ke liye launcher mein `-Browser edge` use karo.

Ye tumhari normal Chrome profile import/copy nahi karta. Chrome 136+ default user-data
directory ke saath remote-debugging switches support nahi karta, isliye dedicated
`manual-chrome-profile` use hota hai. Site phir bhi challenge de sakti hai.
Sources: https://developer.chrome.com/blog/remote-debugging-port
and https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect-over-cdp
