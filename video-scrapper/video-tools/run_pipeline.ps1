param(
    [Parameter(Position = 0)]
    [string]$Url = '',
    [string]$InputLinks = '',
    [string]$Output = 'output',
    [string]$Downloads = 'downloads',
    [ValidateRange(1, 8)]
    [int]$Workers = 4,
    [ValidateRange(1, 600)]
    [double]$Timeout = 60,
    [switch]$NoPlay,
    [switch]$SkipScrape
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot

try {
    Write-Host '============================================================'
    Write-Host 'VIDEO AUTOMATION PIPELINE'
    Write-Host '============================================================'

    # 1. Locate Python executable (prefer local .venv if present)
    $venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
        $pythonExe = $venvPython
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $pythonExe = 'python'
    } else {
        throw 'Python not found. Please set up the virtual environment or install Python.'
    }

    # 2. Determine scraper input & output directories
    $outputDir = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $PSScriptRoot $Output }
    $downloadsDir = if ([System.IO.Path]::IsPathRooted($Downloads)) { $Downloads } else { Join-Path $PSScriptRoot $Downloads }
    $videosJsonPath = Join-Path $outputDir 'videos.json'
    $defaultLinksPath = Join-Path $outputDir 'post_links.json'

    if (-not $SkipScrape) {
        $scraperArgs = @('scrape_videos.py', '--headless', '--output', $outputDir, '--timeout', "$Timeout")
        if (-not $NoPlay) {
            $scraperArgs += '--play'
        }

        if ($InputLinks -and $InputLinks.Trim().Length -gt 0) {
            if (-not (Test-Path -LiteralPath $InputLinks -PathType Leaf)) {
                throw "Input links file not found: $InputLinks"
            }
            $scraperArgs += @('--input-links', $InputLinks)
        } elseif ($Url -and $Url.Trim().Length -gt 0) {
            $scraperArgs += $Url.Trim()
        } elseif (Test-Path -LiteralPath $defaultLinksPath -PathType Leaf) {
            $scraperArgs += @('--input-links', $defaultLinksPath)
        } else {
            throw "No URL or input links provided, and default '$defaultLinksPath' was not found."
        }

        # 3. [1/5] & [2/5] Run Playwright scraper in headless mode
        Write-Host ''
        Write-Host '[1/5] Starting Playwright Headless...'
        Write-Host '[2/5] Discovering video links...'

        & $pythonExe @scraperArgs
        $scraperExitCode = $LASTEXITCODE
        if ($scraperExitCode -ne 0) {
            Write-Host "Scraper failed with exit code $scraperExitCode."
            exit $scraperExitCode
        }
    }

    # 4. [3/5] Validate videos.json completely before invoking downloader
    if (-not (Test-Path -LiteralPath $videosJsonPath -PathType Leaf)) {
        Write-Host 'videos.json validation failed: file does not exist.'
        exit 1
    }

    try {
        $jsonRaw = Get-Content -LiteralPath $videosJsonPath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($jsonRaw)) {
            throw 'File is empty.'
        }
        $records = $jsonRaw | ConvertFrom-Json
    } catch {
        Write-Host 'videos.json validation failed.'
        Write-Host "JSON parse error: $_"
        exit 1
    }

    $recordsList = @()
    if ($null -ne $records) {
        if ($records -is [System.Array] -or $records -is [System.Collections.IList]) {
            $recordsList = $records
        } else {
            $recordsList = @($records)
        }
    }

    $uniqueVideoUrls = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($rec in $recordsList) {
        if ($null -eq $rec) { continue }
        $vUrls = $rec.video_urls
        if ($null -ne $vUrls) {
            if ($vUrls -is [string]) {
                $vUrls = @($vUrls)
            }
            foreach ($u in $vUrls) {
                if ($u -is [string] -and $u.Trim().Length -gt 0) {
                    $trimmed = $u.Trim()
                    if ($trimmed -match '^https?://.+') {
                        [void]$uniqueVideoUrls.Add($trimmed)
                    }
                }
            }
        }
    }

    $totalRecords = $recordsList.Count
    $totalVideoUrls = $uniqueVideoUrls.Count

    Write-Host "[3/5] videos.json generated."
    Write-Host "      Records: $totalRecords"
    Write-Host "      Video URLs: $totalVideoUrls"

    if ($totalVideoUrls -eq 0) {
        Write-Host ''
        Write-Host 'No downloadable video URLs discovered.'
        Write-Host '============================================================'
        Write-Host 'PIPELINE COMPLETE (NO DOWNLOADS REQUIRED)'
        Write-Host '============================================================'
        exit 0
    }

    # 5. [4/5] Launch bounded parallel downloader
    Write-Host ''
    Write-Host '[4/5] Starting parallel downloader...'
    Write-Host "      Workers: $Workers"

    $downloaderArgs = @(
        'download_videos.py',
        $videosJsonPath,
        '--output', $downloadsDir,
        '--workers', "$Workers",
        '--timeout', "$Timeout"
    )

    & $pythonExe @downloaderArgs
    $downloaderExitCode = $LASTEXITCODE

    if ($downloaderExitCode -ne 0) {
        Write-Host ''
        Write-Host "Downloader failed with exit code $downloaderExitCode."
        exit $downloaderExitCode
    }

    # 6. [5/5] Pipeline completion
    Write-Host ''
    Write-Host '[5/5] Downloader completed.'
    Write-Host ''
    Write-Host '============================================================'
    Write-Host 'PIPELINE COMPLETE'
    Write-Host '============================================================'
    exit 0

} finally {
    Pop-Location
}
