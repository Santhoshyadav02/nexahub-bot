param(
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'chrome',
    [string]$InputLinks = 'output/post_links.json',
    [ValidateRange(1024, 65535)]
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath $InputLinks -PathType Leaf)) {
        throw "Input file not found: $InputLinks"
    }
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        throw 'Python not found. Install Python and run setup from README.md.'
    }
    & python -c 'import playwright.sync_api'
    if ($LASTEXITCODE -ne 0) {
        throw 'Run: python -m pip install -r requirements.txt'
    }
    $browserLauncher = Join-Path $PSScriptRoot 'start_browser.ps1'
    do {
        & $browserLauncher -Browser $Browser -Port $Port -QuietInstructions
        Write-Host ''
        Write-Host 'In the dedicated browser window, open your website manually.'
        Write-Host 'Finish verification/login and confirm a post page opens.'
        Write-Host 'Keep THAT window open while the scraper runs.'
        Write-Host 'This uses a dedicated session, not your everyday Chrome profile.'
        $readyAnswer = Read-Host 'When the post opens, press Enter to start (type q to cancel)'
        if ($readyAnswer.Trim() -match '^(q|quit|cancel)$') {
            Write-Host 'Cancelled. No browser was closed by this launcher.'
            exit 0
        }
        $browserReady = & $browserLauncher -Port $Port -CheckOnly
        if (-not $browserReady) {
            Write-Host "Browser connection on port $Port was lost while waiting. Restarting the dedicated browser."
            Write-Host 'After it reopens, verify the website there before pressing Enter again.'
        }
    } while (-not $browserReady)
    Write-Host "Browser connection verified on port $Port. Starting scraper..."
    & python scrape_videos.py --input-links $InputLinks --cdp-url "http://127.0.0.1:$Port" --play --timeout 60 --verification-wait 300 --stop-on-verification
    $scraperExitCode = $LASTEXITCODE
    if ($scraperExitCode -ne 0) {
        Write-Host 'Scraper stopped. See the error above. If the browser disconnected, rerun this command.'
    }
    exit $scraperExitCode
} finally {
    Pop-Location
}
