# Draws a daily/weekly report card (JSON spec from run.js) as a PNG with GDI+.
# Windows PowerShell 5.1 + System.Drawing only: no npm packages, uses the system CJK font.
# Keep this file ASCII-only: PowerShell 5.1 reads BOM-less scripts in the ANSI codepage.
param(
    [Parameter(Mandatory = $true)][string]$SpecPath,
    [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
# Game themes: CS2 blue, Valorant red.
$headBg = '#16263a'; $accent = '#3d8bd9'; $timeColor = '#2f6fb0'
if ([string]$spec.theme -eq 'valorant') { $headBg = '#2b1519'; $accent = '#ff4655'; $timeColor = '#d23a48' }
elseif ([string]$spec.theme -ne 'cs2') { $headBg = '#202b38'; $accent = '#5a8fc1'; $timeColor = '#2f6fa7' }
$scale = 2
$W = 640
$pad = 24
$headerH = 84
$footerH = 40
$heights = @{ section = 46; group = 32; row = 36; note = 28 }

$height = $headerH + 6 + $footerH
foreach ($item in $spec.items) { if ($heights.ContainsKey([string]$item.t)) { $height += $heights[[string]$item.t] } }

$installed = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
$family = @('Microsoft YaHei UI', 'Microsoft YaHei', 'DengXian', 'SimHei', 'SimSun') |
    Where-Object { $installed -contains $_ } | Select-Object -First 1
if (-not $family) { $family = [System.Drawing.FontFamily]::GenericSansSerif.Name }

$fonts = @{}
function Get-Font([double]$size, [bool]$bold = $false) {
    $key = "$size|$bold"
    if (-not $fonts.ContainsKey($key)) {
        $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
        $fonts[$key] = New-Object System.Drawing.Font($family, [single]$size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    }
    $fonts[$key]
}
$brushes = @{}
function Get-Brush([string]$hex) {
    if (-not $brushes.ContainsKey($hex)) { $brushes[$hex] = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }
    $brushes[$hex]
}
function Fill([string]$hex, [double]$x, [double]$y, [double]$w, [double]$h) {
    $g.FillRectangle((Get-Brush $hex), [single]$x, [single]$y, [single]$w, [single]$h)
}
function Text([string]$text, $font, [string]$hex, [double]$x, [double]$y, [double]$w, [double]$h, [string]$align = 'Near') {
    if (-not $text) { return }
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::$align
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $rect = New-Object System.Drawing.RectangleF([single]$x, [single]$y, [single]$w, [single]$h)
    $g.DrawString($text, $font, (Get-Brush $hex), $rect, $format)
    $format.Dispose()
}

$bitmap = New-Object System.Drawing.Bitmap ([int]($W * $scale)), ([int]($height * $scale))
$g = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $g.ScaleTransform($scale, $scale)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#ffffff'))

    # Header band in the site's navy with the accent rule underneath.
    Fill $headBg 0 0 $W $headerH
    Fill $accent 0 ($headerH - 3) $W 3
    Text ([string]$spec.title) (Get-Font 24 $true) '#f5f7fa' $pad 14 ($W - 2 * $pad - 90) 34
    Text ([string]$spec.subtitle) (Get-Font 13) '#bac5d2' $pad 48 ($W - 2 * $pad) 22
    Text 'PRPICK' (Get-Font 14 $true) '#91b9dc' ($W - $pad - 90) 14 90 34 'Far'

    $y = $headerH + 6
    $content = $W - 2 * $pad
    $stripe = $false
    foreach ($item in $spec.items) {
        switch ([string]$item.t) {
            'section' {
                Fill $accent $pad ($y + 16) 4 20
                Text ([string]$item.text) (Get-Font 17 $true) '#1b2633' ($pad + 12) ($y + 12) ($content - 12) 28
                $y += $heights.section
            }
            'group' {
                Fill '#eef2f6' $pad ($y + 4) $content 26
                Text ([string]$item.text) (Get-Font 13 $true) '#4a5b6e' ($pad + 10) ($y + 4) ($content - 20) 26
                $stripe = $false
                $y += $heights.group
            }
            'row' {
                $rowH = $heights.row
                if ($stripe) { Fill '#f7f9fb' $pad $y $content $rowH }
                $stripe = -not $stripe
                Fill '#e6eaef' $pad ($y + $rowH - 1) $content 1
                $idW = 56
                $timeW = if ([string]$item.time) { 118 } else { 0 }
                $metaW = 100
                $midW = 60
                $teamsX = $pad + $idW + $timeW
                $sideW = ($content - $idW - $timeW - $metaW - $midW) / 2
                $win = [int]$item.win
                $scored = [string]$item.mid -ne 'vs'
                $teamA = if ($win -eq 2) { '#8a96a3' } else { '#1b2633' }
                $teamB = if ($win -eq 1) { '#8a96a3' } else { '#1b2633' }
                Text ('#' + $item.id) (Get-Font 12) '#8a96a3' ($pad + 8) $y ($idW - 8) $rowH
                Text ([string]$item.time) (Get-Font 14 $true) $timeColor ($pad + $idW) $y $timeW $rowH
                $nameA = [string]$item.a; if ($item.atag) { $nameA = '(' + $item.atag.text + ') ' + $nameA }
                $nameB = [string]$item.b; if ($item.btag) { $nameB = $nameB + ' (' + $item.btag.text + ')' }
                Text $nameA (Get-Font 14 ($win -eq 1)) $teamA $teamsX $y ($sideW - 6) $rowH 'Far'
                Text ([string]$item.mid) (Get-Font 15 $scored) $(if ($scored) { '#1b2633' } else { '#9aa6b2' }) ($teamsX + $sideW) $y $midW $rowH 'Center'
                Text $nameB (Get-Font 14 ($win -eq 2)) $teamB ($teamsX + $sideW + $midW + 6) $y ($sideW - 6) $rowH
                $meta = [string]$item.meta; if (-not $meta) { $meta = [string]$item.round }
                if ([string]$item.round -and [string]$item.meta) {
                    Text ([string]$item.round) (Get-Font 11) '#6b7887' ($W - $pad - $metaW) ($y + 3) ($metaW - 8) ($rowH / 2) 'Far'
                    Text ([string]$item.meta) (Get-Font 11) '#6b7887' ($W - $pad - $metaW) ($y + $rowH / 2 - 3) ($metaW - 8) ($rowH / 2) 'Far'
                } else {
                    Text $meta (Get-Font 12) '#6b7887' ($W - $pad - $metaW) $y ($metaW - 8) $rowH 'Far'
                }
                $y += $rowH
            }
            'note' {
                Text ([string]$item.text) (Get-Font 13) '#6b7887' ($pad + 8) $y ($content - 16) $heights.note
                $y += $heights.note
            }
        }
    }

    Fill '#f2f4f7' 0 ($height - $footerH) $W $footerH
    Text ([string]$spec.footer) (Get-Font 12) '#8a96a3' $pad ($height - $footerH) $content $footerH
    $bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $g.Dispose()
    $bitmap.Dispose()
    foreach ($font in $fonts.Values) { $font.Dispose() }
    foreach ($brush in $brushes.Values) { $brush.Dispose() }
}
