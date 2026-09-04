Add-Type -AssemblyName System.Drawing
$img = New-Object System.Drawing.Bitmap 'C:\Users\Professional\.gemini\antigravity-ide\brain\fc1dd73e-f749-4036-b434-fd54d180259e\.user_uploaded\media_1788546670455.png'

$minX = 9999; $maxX = -1; $minY = 9999; $maxY = -1
for ($y = 0; $y -lt $img.Height; $y++) {
    for ($x = 0; $x -lt 700; $x++) {
        $c = $img.GetPixel($x, $y)
        if ($c.G -gt 30 -and $y -gt 40) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
$w = $maxX - $minX + 1
$h = $maxY - $minY + 1

# Panel bounds
$panelMinX = 9999; $panelMaxX = -1; $panelMinY = 9999; $panelMaxY = -1
for ($y = 0; $y -lt $img.Height; $y++) {
    for ($x = 700; $x -lt $img.Width; $x++) {
        $c = $img.GetPixel($x, $y)
        if ($c.G -gt 30) {
            if ($x -lt $panelMinX) { $panelMinX = $x }
            if ($x -gt $panelMaxX) { $panelMaxX = $x }
            if ($y -lt $panelMinY) { $panelMinY = $y }
            if ($y -gt $panelMaxY) { $panelMaxY = $y }
        }
    }
}
$panelW = $panelMaxX - $panelMinX + 1
$gapBetween = $panelMinX - $maxX

Write-Output "Image 2 CRT bezel: X=[$minX, $maxX] width=$w, Y=[$minY, $maxY] height=$h"
Write-Output "Image 2 Panel: X=[$panelMinX, $panelMaxX] width=$panelW"
Write-Output "Image 2 Gap between CRT and Panel: $gapBetween"
Write-Output "Image 1 CRT was X=[158, 865]. If Image 1 CRT didn't move, overlap with panel (at $panelMinX) would be: $(865 - $panelMinX)"
$img.Dispose()
