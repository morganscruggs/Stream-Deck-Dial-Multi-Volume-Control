Add-Type -AssemblyName System.Drawing

function New-OutlineIcon {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $scale = $Size / 100.0
    $white = [System.Drawing.Color]::White

    # Shrink and center the whole composition, leaving transparent margin on every edge, rather than
    # having the artwork's own coordinates run edge-to-edge. Applied as a world transform so every
    # shape below can keep using the same plain 0-100 coordinate space.
    $margin = 10.0
    $contentScale = (100.0 - 2 * $margin) / 100.0
    $g.TranslateTransform($margin * $scale, $margin * $scale)
    $g.ScaleTransform($contentScale, $contentScale)

    $strokeWidth = [Math]::Max(2.0, 6.5 * $scale)
    $pen = [System.Drawing.Pen]::new($white, $strokeWidth)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    # Speaker outline: box + flared cone, drawn as a single stroked (unfilled) polygon so the round
    # line-join rounds every corner, matching the reference icon's rounded outline style. Shrunk (and
    # the faders shifted right) versus the first pass, which had the speaker's flare tip and the first
    # fader's knob close enough for their strokes to visually collide, and let the third fader clip past
    # the right edge of the canvas.
    [System.Drawing.PointF[]]$speakerPoints = @(
        [System.Drawing.PointF]::new(3 * $scale, 34 * $scale),
        [System.Drawing.PointF]::new(16 * $scale, 34 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 14 * $scale),
        [System.Drawing.PointF]::new(38 * $scale, 86 * $scale),
        [System.Drawing.PointF]::new(16 * $scale, 66 * $scale),
        [System.Drawing.PointF]::new(3 * $scale, 66 * $scale)
    )
    $g.DrawPolygon($pen, $speakerPoints)

    # Three faders: each an unfilled ring "knob" on a vertical line, with the line broken where it
    # passes behind the ring (rather than running straight through its hollow center) so the knob
    # reads as a distinct handle sitting on the track, not a line seen through a hole.
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
New-OutlineIcon -Size 512 -OutPath "$outDir\outline-icon-512.png"

Write-Output "Generated outline-icon-512.png in $outDir"
