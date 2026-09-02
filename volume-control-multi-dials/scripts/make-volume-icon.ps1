Add-Type -AssemblyName System.Drawing

function New-SpeakerIcon {
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
    $brush = [System.Drawing.SolidBrush]::new($white)

    # Speaker body: box + flared cone, in a 0-100 local coordinate space.
    [System.Drawing.PointF[]]$points = @(
        [System.Drawing.PointF]::new(28 * $scale, 36 * $scale),
        [System.Drawing.PointF]::new(44 * $scale, 36 * $scale),
        [System.Drawing.PointF]::new(64 * $scale, 16 * $scale),
        [System.Drawing.PointF]::new(64 * $scale, 84 * $scale),
        [System.Drawing.PointF]::new(44 * $scale, 64 * $scale),
        [System.Drawing.PointF]::new(28 * $scale, 64 * $scale)
    )
    $g.FillPolygon($brush, $points)

    # Sound wave arcs, opening to the right of the speaker.
    $penWidth = [Math]::Max(2.0, 5 * $scale)
    $pen = [System.Drawing.Pen]::new($white, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $cx = 66 * $scale
    $cy = 50 * $scale

    foreach ($r in @(13, 24)) {
        $radius = $r * $scale
        $rect = [System.Drawing.RectangleF]::new(($cx - $radius), ($cy - $radius), ($radius * 2), ($radius * 2))
        $g.DrawArc($pen, $rect, -40, 80)
    }

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $pen.Dispose()
    $brush.Dispose()
}

$dir = "com.morgan-scruggs.volume-control-multi-dials.sdPlugin\imgs\actions\volume"
New-SpeakerIcon -Size 20 -OutPath "$dir\icon.png"
New-SpeakerIcon -Size 40 -OutPath "$dir\icon@2x.png"
New-SpeakerIcon -Size 72 -OutPath "$dir\key.png"
New-SpeakerIcon -Size 144 -OutPath "$dir\key@2x.png"

Write-Output "Generated icons in $dir"
