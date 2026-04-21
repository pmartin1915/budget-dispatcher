# create-fleet-shortcut.ps1 -- Creates a Desktop shortcut for the Fleet Dashboard.
# The shortcut opens the GitHub Pages dashboard as a Chrome/Edge app window.
# Right-click the shortcut > "Pin to taskbar" for one-click access.
#
# Usage: powershell -File scripts\create-fleet-shortcut.ps1

$url = "https://pmartin1915.github.io/budget-dispatcher/fleet-dashboard.html"
$shortcutName = "Fleet Dashboard"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$shortcutName.lnk"

# Find browser
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if (Test-Path $chrome) {
    $browser = $chrome
} elseif (Test-Path $edge) {
    $browser = $edge
} else {
    Write-Host "Neither Chrome nor Edge found. Opening in default browser."
    $browser = $null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)

if ($browser) {
    $shortcut.TargetPath = $browser
    $shortcut.Arguments = "--app=$url --window-size=420,700"
    $shortcut.IconLocation = "$browser,0"
} else {
    $shortcut.TargetPath = $url
}

$shortcut.Description = "Budget Dispatcher Fleet Monitor"
$shortcut.Save()

Write-Host "Shortcut created at: $shortcutPath"
Write-Host "Right-click it > 'Pin to taskbar' for one-click access."
