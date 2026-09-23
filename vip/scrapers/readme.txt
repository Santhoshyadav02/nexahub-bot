# ==============================================================================
# 1. KOREA / BJ (bo_table=korea)
# ==============================================================================
# Scrape:
uv run python bj_scraper.py --start 1 --end 20
uv run python bj_scraper.py

# Download:
uv run python bj_downloader.py --limit 10
uv run python bj_downloader.py


# ==============================================================================
# 2. JP / CAPTION (bo_table=caption)
# ==============================================================================
# Scrape:
uv run python jp_scraper.py --start 1 --end 10
uv run python jp_scraper.py

# Download:
uv run python jp_downloader.py --limit 5
uv run python jp_downloader.py


# ==============================================================================
# 3. KR / KOREAN AV (eporner tag: korean-av)
# ==============================================================================
# Scrape:
uv run python kr_scraper.py --start 1 --end 5
uv run python kr_scraper.py

# Download:
uv run python kr_downloader.py --limit 5
uv run python kr_downloader.py


# ==============================================================================
# 4. XCHINA SERIES (GET + BeautifulSoup)
# ==============================================================================
# Scrape:
uv run python xchina_scraper.py --start 1 --end 3
uv run python xchina_scraper.py

# Download:
uv run python xchina_downloader.py --limit 5
uv run python xchina_downloader.py


# ==============================================================================
# 5. AV (AVsee Caption: bo_table=caption)
# ==============================================================================
# Scrape:
uv run python av_scraper.py --start 1 --end 10
uv run python av_scraper.py

# Download:
uv run python av_downloader.py --limit 5
uv run python av_downloader.py


# ==============================================================================
# 6. 18+ (KRX18: https://krx18.com/genre/korea/)
# ==============================================================================
# Scrape:
uv run python krx_scraper.py --start 1 --end 3
uv run python krx_scraper.py

# Download:
uv run python krx_downloader.py --limit 5
uv run python krx_downloader.py

https://koreanpornmovie.com/