Add-Type -AssemblyName System.Drawing

function Create-StageManagerIcon($size, $path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background rounded rect or circle with subtle dark gradient
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($size, $size)),
        [System.Drawing.Color]::FromArgb(255, 30, 32, 42),
        [System.Drawing.Color]::FromArgb(255, 12, 14, 20)
    )
    $pathObj = New-Object System.Drawing.Drawing2D.GraphicsPath
    $radius = [Math]::Max(2, [int]($size * 0.22))
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    
    # Draw rounded rect bg
    $d = $radius * 2
    $pathObj.AddArc(0, 0, $d, $d, 180, 90)
    $pathObj.AddArc($size - $d, 0, $d, $d, 270, 90)
    $pathObj.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $pathObj.AddArc(0, $size - $d, $d, $d, 90, 90)
    $pathObj.CloseFigure()
    $g.FillPath($bgBrush, $pathObj)

    # Accent color (Apple-like vibrant blue / cyan)
    $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 122, 255))
    $stripBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 160, 175, 200))
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 255, 255, 255), [Math]::Max(1, $size * 0.03))

    # Stage Strip on Left: 3 small rounded cards
    $stripW = $size * 0.22
    $stripH = $size * 0.18
    $stripX = $size * 0.12
    $gap = $size * 0.08
    $startY = $size * 0.16

    for ($i = 0; $i -lt 3; $i++) {
        $y = $startY + $i * ($stripH + $gap)
        $g.FillRectangle($stripBrush, $stripX, $y, $stripW, $stripH)
        $g.DrawRectangle($borderPen, $stripX, $y, $stripW, $stripH)
    }

    # Center Active Stage window
    $mainX = $size * 0.42
    $mainY = $size * 0.18
    $mainW = $size * 0.46
    $mainH = $size * 0.64

    # Main window body
    $g.FillRectangle($accentBrush, $mainX, $mainY, $mainW, $mainH)
    $g.DrawRectangle($borderPen, $mainX, $mainY, $mainW, $mainH)

    # Top titlebar of main window
    $titlebarH = [Math]::Max(2, $mainH * 0.18)
    $titlebarBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.FillRectangle($titlebarBrush, $mainX, $mainY, $mainW, $titlebarH)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

$baseDir = "c:\Users\QsJul\Documents\antigravity\vibrant-meitner\stage-manager-extension\icons"
Create-StageManagerIcon 16 "$baseDir\icon16.png"
Create-StageManagerIcon 48 "$baseDir\icon48.png"
Create-StageManagerIcon 128 "$baseDir\icon128.png"
Write-Output "Icons generated successfully."
