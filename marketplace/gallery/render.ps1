# Renders gallery.html slides to 1920x960 PNGs (Elgato Marketplace gallery size) with headless Edge.
# Each slide id in the list maps to section #s<id> and is written as gallery-<id>.png.
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$html = (Resolve-Path "$PSScriptRoot\gallery.html").Path
$uri = ([System.Uri]$html).AbsoluteUri

foreach ($n in @("1", "1.2", "1.3", "2", "3", "4", "5")) {
    $out = Join-Path $PSScriptRoot ("gallery-{0}.png" -f $n)
    & $edge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files `
        --force-device-scale-factor=1 --window-size=1920,960 --virtual-time-budget=1500 `
        "--screenshot=$out" "$uri#$n" | Out-Null
    Write-Output "Wrote $out"
}
