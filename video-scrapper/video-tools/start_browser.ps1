param(
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'chrome',
    [ValidateRange(1024, 65535)]
    [int]$Port = 9222,
    [switch]$QuietInstructions,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
function Test-DebugBrowser {
    $debugResponse = $null
    $debugReader = $null
    try {
        # Check the actual local endpoint, without a system HTTP proxy/cache.
        $debugRequest = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/json/version")
        $debugRequest.Proxy = $null
        $debugRequest.Timeout = 2000
        $debugRequest.ReadWriteTimeout = 2000
        $debugRequest.AllowAutoRedirect = $false
        $debugResponse = $debugRequest.GetResponse()
        $debugReader = [System.IO.StreamReader]::new($debugResponse.GetResponseStream())
        $versionInfo = $debugReader.ReadToEnd() | ConvertFrom-Json
        $socketUri = [uri]$versionInfo.webSocketDebuggerUrl
        return ($socketUri.Scheme -eq 'ws' -and $socketUri.Host -in @('127.0.0.1', 'localhost', '[::1]') -and $socketUri.Port -eq $Port)
    } catch {
        return $false
    } finally {
        if ($null -ne $debugReader) { $debugReader.Dispose() }
        if ($null -ne $debugResponse) { $debugResponse.Dispose() }
    }
}
if ($CheckOnly) {
    Test-DebugBrowser
    return
}
if ($Browser -eq 'chrome') {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
} else {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
}
$browserExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browserExe) { throw "$Browser installation not found." }
$debugProfile = Join-Path $PSScriptRoot "manual-$Browser-profile"
$browserArguments = @(
    "--remote-debugging-port=$Port",
    '--remote-debugging-address=127.0.0.1',
    ('--user-data-dir="{0}"' -f $debugProfile),
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
)
if (Test-DebugBrowser) {
    Write-Host "Reusing browser already listening on port $Port."
} else {
    # This is the interactive browser the user needs to verify/login in.
    Start-Process -FilePath $browserExe -ArgumentList $browserArguments
    $startupDeadline = (Get-Date).AddSeconds(25)
    while (-not (Test-DebugBrowser)) {
        if ((Get-Date) -ge $startupDeadline) {
            throw "Browser debugging did not start on port $Port. Close only the dedicated browser window and retry."
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "Browser ready with dedicated session folder: $debugProfile"
}
if (-not $QuietInstructions) {
    Write-Host 'Open your website manually in this window and finish login/verification.'
    Write-Host 'Keep this window open, then run:'
    Write-Host "python scrape_videos.py --input-links output/post_links.json --cdp-url http://127.0.0.1:$Port --play --timeout 60 --verification-wait 300"
}
