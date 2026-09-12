param(
    [Parameter(Position = 0)]
    [string]$Url = '',
    [string]$InputLinks = '',
    [string]$Output = 'output',
    [string]$Downloads = 'downloads',
    [ValidateRange(1, 8)]
    [int]$Workers = 4,
    [ValidateRange(1, 600)]
    [double]$Interval = 15.0,
    [ValidateRange(1, 1000)]
    [int]$QueueCap = 150,
    [ValidateRange(1, 600)]
    [double]$Timeout = 60.0,
    [switch]$Once,
    [switch]$NoPlay,
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'chrome',
    [ValidateRange(1024, 65535)]
    [int]$Port = 9222,
    [switch]$Standalone,
    [switch]$Headed,
    [ValidateRange(1, 100000)]
    [int]$TargetLinks = 100,
    [ValidateRange(1, 1000)]
    [int]$MaxPages = 50
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot

try {
    # 1. Locate Python executable (prefer local .venv if present)
    $venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
        $pythonExe = $venvPython
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $pythonExe = 'python'
    } else {
        throw 'Python not found. Please set up the virtual environment or install Python.'
    }

    $outputDir = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $PSScriptRoot $Output }
    $downloadsDir = if ([System.IO.Path]::IsPathRooted($Downloads)) { $Downloads } else { Join-Path $PSScriptRoot $Downloads }
    $defaultLinksPath = Join-Path $outputDir 'post_links.json'

    $argsList = @(
        'pipeline.py',
        '--output', $outputDir,
        '--downloads', $downloadsDir,
        '--workers', "$Workers",
        '--interval', "$Interval",
        '--queue-cap', "$QueueCap",
        '--timeout', "$Timeout",
        '--target-links', "$TargetLinks",
        '--max-pages', "$MaxPages"
    )

    if ($Once) {
        $argsList += '--once'
    }
    if (-not $NoPlay) {
        $argsList += '--play'
    }

    if ($InputLinks -and $InputLinks.Trim().Length -gt 0) {
        if (-not (Test-Path -LiteralPath $InputLinks -PathType Leaf)) {
            throw "Input links file not found: $InputLinks"
        }
        $argsList += @('--input-links', $InputLinks)
    } elseif ($Url -and $Url.Trim().Length -gt 0) {
        $argsList += $Url.Trim()
    } elseif (Test-Path -LiteralPath $defaultLinksPath -PathType Leaf) {
        $argsList += @('--input-links', $defaultLinksPath)
    }

    if ($Standalone) {
        # Old behavior: plain Playwright browser, no persistent verified session.
        # Sites with bot-verification (Cloudflare, etc.) will block this in headless mode.
        if ($Headed) {
            $argsList += '--headed'
        } else {
            $argsList += '--headless'
        }
    } else {
        # Default: reuse (or start) one dedicated, persistent browser session via CDP so a
        # verification challenge only ever needs solving once per session, not once per run.
        Write-Host '============================================================'
        Write-Host 'Ensuring a verified browser session is available...'
        Write-Host '============================================================'
        # Invoke via a bypassed child process, not the '&' call operator: start_browser.ps1
        # may carry Windows' internet "Mark of the Web", which the current execution policy
        # can refuse to load in-process even though this script itself runs fine.
        powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start_browser.ps1') -Browser $Browser -Port $Port -QuietInstructions
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to start/verify the dedicated browser session (start_browser.ps1 exited with code $LASTEXITCODE)."
        }
        $argsList += @('--cdp-url', "http://127.0.0.1:$Port")

        Write-Host ''
        Write-Host 'If the browser window shows a "verify you are human" / Cloudflare check,'
        Write-Host 'solve it there now. The pipeline below retries automatically every'
        Write-Host "$Interval`s and will start scraping/downloading on its own as soon as it clears -"
        Write-Host 'no need to run anything else.'
        Write-Host ''
    }

    & $pythonExe @argsList
    $exitCode = $LASTEXITCODE
    exit $exitCode

} finally {
    Pop-Location
}
