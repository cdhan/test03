# Recent Weather Check - local web server + KMA short-term forecast proxy.
# Runs on stock Windows PowerShell 5.1 (no Node/Python needed).
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8080] [-Open]
param(
    [int]$Port = 8080,
    [switch]$Open
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = [IO.Path]::GetFullPath((Join-Path $Root 'public'))

# --- Service key: .env (KMA_SERVICE_KEY=...) or environment variable ---
$ServiceKey = $env:KMA_SERVICE_KEY
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
    foreach ($line in [IO.File]::ReadAllLines($envFile)) {
        if ($line -match '^\s*KMA_SERVICE_KEY\s*=\s*(.+?)\s*$') { $ServiceKey = $Matches[1] }
    }
}
if (-not $ServiceKey) {
    Write-Host 'KMA_SERVICE_KEY is not set. Put it in .env (see .env.example).' -ForegroundColor Red
    exit 1
}
# Accept both the "Encoding" key (already %-escaped) and the "Decoding" key.
if ($ServiceKey -notmatch '%') { $ServiceKey = [Uri]::EscapeDataString($ServiceKey) }

$Endpoint = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0'
# KMA grid coordinates (nx, ny)
$Regions = @{
    seoul   = @{ nx = 60; ny = 127 }
    daejeon = @{ nx = 67; ny = 100 }
}
$Mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

function Send-Bytes($res, [int]$status, [string]$type, [byte[]]$bytes) {
    $res.StatusCode = $status
    $res.ContentType = $type
    $res.Headers['Cache-Control'] = 'no-store'
    $res.Headers['X-Content-Type-Options'] = 'nosniff'
    $res.ContentLength64 = $bytes.Length
    if (-not $script:IsHead) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    $res.OutputStream.Close()
}

function Send-Json($res, [int]$status, [string]$json) {
    Send-Bytes $res $status 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function Send-Error($res, [int]$status, [string]$code, [string]$message) {
    $json = @{ error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress
    Send-Json $res $status $json
}

# GET /api/forecast?region=seoul|daejeon&base_date=YYYYMMDD&base_time=HH00
function Invoke-Forecast($req, $res) {
    $q = $req.QueryString
    $region = $q['region']
    $baseDate = $q['base_date']
    $baseTime = $q['base_time']

    if (-not $region -or -not $Regions.ContainsKey($region)) {
        return Send-Error $res 400 'BAD_REGION' 'region must be seoul or daejeon'
    }
    if ($baseDate -notmatch '^\d{8}$') {
        return Send-Error $res 400 'BAD_BASE_DATE' 'base_date must be YYYYMMDD'
    }
    if ($baseTime -notmatch '^(02|05|08|11|14|17|20|23)00$') {
        return Send-Error $res 400 'BAD_BASE_TIME' 'base_time must be one of 0200,0500,...,2300'
    }

    $grid = $Regions[$region]
    $url = "$Endpoint/getVilageFcst?serviceKey=$ServiceKey&pageNo=1&numOfRows=1500&dataType=JSON" +
           "&base_date=$baseDate&base_time=$baseTime&nx=$($grid.nx)&ny=$($grid.ny)"

    try {
        $upReq = [Net.HttpWebRequest]::Create($url)
        $upReq.Timeout = 15000
        $upRes = $upReq.GetResponse()
        $reader = New-Object IO.StreamReader($upRes.GetResponseStream(), [Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Close()
        $upRes.Close()
    } catch {
        return Send-Error $res 502 'UPSTREAM_UNREACHABLE' $_.Exception.Message
    }

    if ($body.TrimStart().StartsWith('{')) {
        return Send-Json $res 200 $body
    }

    # Gateway-level errors (bad key, quota, ...) come back as XML.
    $msg = 'Unexpected response from KMA API'
    if ($body -match '<returnAuthMsg>([^<]+)</returnAuthMsg>') { $msg = $Matches[1] }
    elseif ($body -match '<errMsg>([^<]+)</errMsg>') { $msg = $Matches[1] }
    elseif ($body -match '<resultMsg>([^<]+)</resultMsg>') { $msg = $Matches[1] }
    Send-Error $res 502 'UPSTREAM_ERROR' $msg
}

function Send-Static($req, $res) {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $Public $path.TrimStart('/')))
    if (-not $full.StartsWith($Public + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        return Send-Error $res 403 'FORBIDDEN' 'forbidden'
    }
    if (-not [IO.File]::Exists($full)) {
        return Send-Error $res 404 'NOT_FOUND' 'not found'
    }
    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    $type = $Mime[$ext]
    if (-not $type) { $type = 'application/octet-stream' }
    Send-Bytes $res 200 $type ([IO.File]::ReadAllBytes($full))
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
    $listener.Start()
} catch {
    Write-Host "Could not listen on port $Port : $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$siteUrl = "http://localhost:$Port/"
Write-Host ''
Write-Host "  Recent Weather Check is running: $siteUrl" -ForegroundColor Cyan
Write-Host '  Press Ctrl+C to stop.'
Write-Host ''
if ($Open) { Start-Process $siteUrl }

try {
    while ($listener.IsListening) {
        $pending = $listener.GetContextAsync()
        # Poll so Ctrl+C can interrupt between waits.
        while (-not $pending.AsyncWaitHandle.WaitOne(300)) { }
        $ctx = $pending.GetAwaiter().GetResult()
        $req = $ctx.Request
        $res = $ctx.Response
        $script:IsHead = ($req.HttpMethod -eq 'HEAD')
        try {
            if ($req.HttpMethod -ne 'GET' -and -not $script:IsHead) {
                Send-Error $res 405 'METHOD_NOT_ALLOWED' 'GET or HEAD only'
            } elseif ($req.Url.AbsolutePath -eq '/api/forecast') {
                Invoke-Forecast $req $res
            } else {
                Send-Static $req $res
            }
        } catch {
            try { Send-Error $res 500 'SERVER_ERROR' $_.Exception.Message } catch { }
        }
        Write-Host ("{0}  {1} {2} -> {3}" -f (Get-Date -Format 'HH:mm:ss'), $req.HttpMethod, $req.Url.AbsolutePath, $res.StatusCode)
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
