Add-Type -AssemblyName System.Drawing

function New-OutlineIconGradient {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Diagonal background: blue top-left to green bottom-right.
    $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.Point]::new(0, 0),
        [System.Drawing.Point]::new($Size, $Size),
        [System.Drawing.Color]::FromArgb(255, 41, 121, 255),
        [System.Drawing.Color]::FromArgb(255, 0, 200, 83)
    )
    $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)
    $bgBrush.Dispose()

    $scale = $Size / 100.0
    $white = [System.Drawing.Color]::White

    # Same shrink-and-center transform as make-outline-icon.ps1, so this matches that icon's proportions.
    $margin = 10.0
    $contentScale = (100.0 - 2 * $margin) / 100.0
    $g.TranslateTransform($margin * $scale, $margin * $scale)
    $g.ScaleTransform($contentScale, $contentScale)

    $strokeWidth = [Math]::Max(2.0, 6.5 * $scale)
    $pen = [System.Drawing.Pen]::new($white, $strokeWidth)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    # Speaker outline: box + flared cone (see make-outline-icon.ps1 for the coordinate reasoning).
    [System.Drawing.PointF[]]$speakerPoints = @(
        [System.Drawing.PointF]::new(3 * $scale, 34 * $scale),
        [System.Drawing.PointF]::new(16 * $scale, 34 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 14 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 86 * $scale),
        [System.Drawing.PointF]::new(16 * $scale, 66 * $scale),
        [System.Drawing.PointF]::new(3 * $scale, 66 * $scale)
    )
    $g.DrawPolygon($pen, $speakerPoints)

    # Three faders: unfilled ring knobs, each with the line behind it broken.
    $yTop = 12 * $scale
    $yBottom = 88 * $scale
    $r = 6.5 * $scale

    $tracks = @(
        @{ x = 55; knobY = 42 },
        @{ x = 71; knobY = 60 },
        @{ x = 87; knobY = 26 }
    )

    foreach ($t in $tracks) {
        $x = $t.x * $scale
        $knobY = $t.knobY * $scale

        $g.DrawLine($pen, $x, $yTop, $x, ($knobY - $r))
        $g.DrawLine($pen, $x, ($knobY + $r), $x, $yBottom)
        $g.DrawEllipse($pen, ($x - $r), ($knobY - $r), ($r * 2), ($r * 2))
    }

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $pen.Dispose()
}

$outDir = "X:\-- WORK\-- GitHub\Stream-Deck-Dial-Multi-Volume-Control\volume-control-multi-dials\scripts"
New-OutlineIconGradient -Size 512 -OutPath "$outDir\outline-icon-gradient_512.png"

Write-Output "Generated outline-icon-gradient_512.png in $outDir"
