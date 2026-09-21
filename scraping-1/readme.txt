# 1. BJ
uv run python bj_scraper.py --start 1 --end 1
uv run python bj_downloader.py --limit 1

# 2. Category: Leak
uv run python javleak_scraper.py --start 1 --end 1
uv run python javleak_downloader.py --limit 1

# 3. Category: Caption
uv run python caption_scraper.py --start 1 --end 1
uv run python caption_downloader.py --limit 1

# 4. Category: C
uv run python javc_scraper.py --start 1 --end 1
uv run python javc_downloader.py --limit 1

# 5. Category: MGS
uv run python javmgs_scraper.py --start 1 --end 1
uv run python javmgs_downloader.py --limit 1

# 6. Category: FC2
uv run python javfc2_scraper.py --start 1 --end 1
uv run python javfc2_downloader.py --limit 1

# 7. Category: M
uv run python javm_scraper.py --start 1 --end 1
uv run python javm_downloader.py --limit 1

----------------------------------------------------------------------------------
----------------------------------------------------------------------------------

# Scrape all 668+ BJ pages (auto-saves and auto-resumes)
uv run python bj_scraper.py

# Or scrape a specific page range (e.g. pages 1 to 50)
uv run python bj_scraper.py --start 1 --end 50

-------------------------------------------------
# Download all scraped BJ videos one-by-one with live progress percentage
uv run python bj_downloader.py

# Download a specific batch (e.g. first 10 videos)
uv run python bj_downloader.py --limit 10
---------------------------------------------------------------------------
JAV leak
scrapper
uv run python javleak_scraper.py

Download
uv run python javleak_downloader.py
------------------------------------------------------------------------
JAV CAPTION
# Scrape all 111 JAV Caption pages (auto-saves incrementally and auto-resumes):
uv run python caption_scraper.py

# Or scrape a specific page range (e.g. pages 1 to 20):
uv run python caption_scraper.py --start 1 --end 20

# Download all scraped JAV Caption videos into 'downloads/JAV caption/':
uv run python caption_downloader.py

# Or download a test batch (e.g. first 5 videos):
uv run python caption_downloader.py --limit 5
--------------------------------------------------------------------------
# 1. JAV Censored
uv run python javc_scraper.py
uv run python javc_downloader.py

# 2. JAV MGStage
uv run python javmgs_scraper.py
uv run python javmgs_downloader.py

# 3. JAV FC2
uv run python javfc2_scraper.py
uv run python javfc2_downloader.py

# 4. JAV Removed Mosaic
uv run python javm_scraper.py
uv run python javm_downloader.py

--------------------------------------------------------------------------