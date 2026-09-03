Add-Type -AssemblyName System.Drawing

function New-ComboIcon {
    param(
        [int]$Size,
        [string]$OutPath,
        [switch]$WithBackground
    )

    $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($WithBackground) {
        $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Point]::new(0, 0),
            [System.Drawing.Point]::new($Size, $Size),
            [System.Drawing.Color]::FromArgb(255, 43, 47, 56),
            [System.Drawing.Color]::FromArgb(255, 20, 22, 28)
        )
        $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)
        $bgBrush.Dispose()
    }

    $scale = $Size / 100.0
    $white = [System.Drawing.Color]::White
    $brush = [System.Drawing.SolidBrush]::new($white)

    # Speaker body + cone, shifted into the left half of the canvas.
    [System.Drawing.PointF[]]$speakerPoints = @(
        [System.Drawing.PointF]::new(2 * $scale, 36 * $scale),
        [System.Drawing.PointF]::new(18 * $scale, 36 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 16 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 84 * $scale),
        [System.Drawing.PointF]::new(18 * $scale, 64 * $scale),
        [System.Drawing.PointF]::new(2 * $scale, 64 * $scale)
    )
    $g.FillPolygon($brush, $speakerPoints)

    # Three mixer fader tracks with handles, in the right half of the canvas.
    $trackWidth = [Math]::Max(2.0, 5 * $scale)
    $pen = [System.Drawing.Pen]::new($white, $trackWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $tracks = @(
        @{ x = 58; handleY = 45 },
        @{ x = 76; handleY = 65 },
        @{ x = 94; handleY = 30 }
    )

    foreach ($t in $tracks) {
        $x = $t.x * $scale
        $yTop = 18 * $scale
        $yBottom = 86 * $scale
        $g.DrawLine($pen, $x, $yTop, $x, $yBottom)

        $handleY = $t.handleY * $scale
        $r = 7 * $scale
        $g.FillEllipse($brush, ($x - $r), ($handleY - $r), ($r * 2), ($r * 2))
    }

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $pen.Dispose()
    $brush.Dispose()
}

$outDir = "X:\-- WORK\-- GitHub\Stream-Deck-Dial-Multi-Volume-Control\volume-control-multi-dials\scripts"
New-ComboIcon -Size 144 -OutPath "$outDir\combo-icon.png"

$pluginRoot = "X:\-- WORK\-- GitHub\Stream-Deck-Dial-Multi-Volume-Control\volume-control-multi-dials\com.morgan-scruggs.volume-control-multi-dials.sdPlugin\imgs"

# Volume action icons.
$volumeDir = "$pluginRoot\actions\volume"
New-ComboIcon -Size 20 -OutPath "$volumeDir\icon.png"
New-ComboIcon -Size 40 -OutPath "$volumeDir\icon@2x.png"
New-ComboIcon -Size 72 -OutPath "$volumeDir\key.png"
New-ComboIcon -Size 144 -OutPath "$volumeDir\key@2x.png"


# Plugin-level icons.
$pluginDir = "$pluginRoot\plugin"
New-ComboIcon -Size 28 -OutPath "$pluginDir\category-icon.png"
New-ComboIcon -Size 56 -OutPath "$pluginDir\category-icon@2x.png"
New-ComboIcon -Size 288 -OutPath "$pluginDir\marketplace.png" -WithBackground
New-ComboIcon -Size 512 -OutPath "$pluginDir\marketplace@2x.png" -WithBackground

Write-Output "Generated combo-icon.png and updated all plugin icons under $pluginRoot"
