# Automation & Scraping Suite

Modular scrapers and downloaders with live progress percentage, checkpoint auto-resuming, HTTP Range-resuming, and duplicate skipping.

---

## 📁 Available Scrapers & Downloaders

| Category / Target                | Scraper Script                                                          | Downloader Script                                                             | Metadata Database             | Download Folder     |
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- | ------------------- |
| **1. Korea / BJ (600+ Pages)**   | [`bj_scraper.py`](file:///d:/Automation/scraping/bj_scraper.py)         | [`bj_downloader.py`](file:///d:/Automation/scraping/bj_downloader.py)         | `bj_videos.json` / `.csv`     | `downloads/bj/`     |
| **2. JP / Caption (120+ Pages)** | [`jp_scraper.py`](file:///d:/Automation/scraping/jp_scraper.py)         | [`jp_downloader.py`](file:///d:/Automation/scraping/jp_downloader.py)         | `jp_videos.json` / `.csv`     | `downloads/jp/`     |
| **3. KR / Korean AV Tag**        | [`kr_scraper.py`](file:///d:/Automation/scraping/kr_scraper.py)         | [`kr_downloader.py`](file:///d:/Automation/scraping/kr_downloader.py)         | `kr_videos.json` / `.csv`     | `downloads/kr/`     |
| **4. XChina Series**             | [`xchina_scraper.py`](file:///d:/Automation/scraping/xchina_scraper.py) | [`xchina_downloader.py`](file:///d:/Automation/scraping/xchina_downloader.py) | `xchina_videos.json` / `.csv` | `downloads/xchina/` |
| **5. AV (AVsee Caption)**        | [`av_scraper.py`](file:///d:/Automation/scraping/av_scraper.py)         | [`av_downloader.py`](file:///d:/Automation/scraping/av_downloader.py)         | `av_videos.json` / `.csv`     | `downloads/av/`     |
| **6. 18+ (KRX18)**               | [`krx_scraper.py`](file:///d:/Automation/scraping/krx_scraper.py)       | [`krx_downloader.py`](file:///d:/Automation/scraping/krx_downloader.py)       | `krx_videos.json` / `.csv`    | `downloads/18+/`    |

---

## 🚀 1. Korea / BJ Workflow (`bo_table=korea`)

```powershell
uv run python bj_scraper.py --start 1 --end 20
uv run python bj_scraper.py
uv run python bj_downloader.py --limit 10
uv run python bj_downloader.py
```

---

## 🚀 2. JP / Caption Workflow (`bo_table=caption`)

```powershell
uv run python jp_scraper.py --start 1 --end 10
uv run python jp_scraper.py
uv run python jp_downloader.py --limit 5
uv run python jp_downloader.py
```

---

## 🚀 3. KR / South Korea Tag Workflow (`https://missav123.com/en/tags/South%20Korea?page=1`)

```powershell
uv run python kr_scraper.py --start 1 --end 5
uv run python kr_scraper.py
uv run python kr_downloader.py --limit 5
uv run python kr_downloader.py
```

---

## 🚀 4. XChina Series Workflow (`GET` + `BeautifulSoup`)

```powershell
uv run python xchina_scraper.py --start 1 --end 3
uv run python xchina_scraper.py
uv run python xchina_downloader.py --limit 5
uv run python xchina_downloader.py
```

---

## 🚀 5. AV (AVsee Caption) Workflow (`https://02.avsee.is/bbs/board.php?bo_table=caption`)

```powershell
uv run python av_scraper.py --start 1 --end 10
uv run python av_scraper.py
uv run python av_downloader.py --limit 5
uv run python av_downloader.py
```

---

## 🚀 6. 18+ (KRX18) Workflow (`https://krx18.com/genre/korea/`)

```powershell
# Scrape:
uv run python krx_scraper.py --start 1 --end 3
uv run python krx_scraper.py

# Download:
uv run python krx_downloader.py --limit 5
uv run python krx_downloader.py
```
