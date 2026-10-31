# Installs the latest Candor release on Windows:
#   irm https://raw.githubusercontent.com/devnullada/candor/master/install.ps1 | iex
# The binary goes to ~\.candor\bin (CANDOR_INSTALL to change it) and onto the user's PATH,
# checked against the release's SHA256SUMS (CANDOR_URL fetches from another place than GitHub).
# Candor builds with Go.
$ErrorActionPreference = 'Stop'

$dir = if ($env:CANDOR_INSTALL) { $env:CANDOR_INSTALL } else { Join-Path $HOME '.candor\bin' }
$base = if ($env:CANDOR_URL) { $env:CANDOR_URL } else { 'https://github.com/devnullada/candor/releases/latest/download' }
$file = 'candor-windows-x64.exe'
$tmp = Join-Path $dir 'candor.tmp'
$sums = Join-Path $dir 'candor.sums'
New-Item -ItemType Directory -Force $dir | Out-Null
Write-Host "downloading $base/$file"
Invoke-WebRequest "$base/$file" -OutFile $tmp
Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sums

# The binary must match its line in the release's SHA256SUMS.
$want = Get-Content $sums | ForEach-Object { $f = $_ -split '\s+'; if ($f[1] -eq $file) { $f[0] } } | Select-Object -First 1
Remove-Item $sums
if (-not $want -or (Get-FileHash -Algorithm SHA256 $tmp).Hash -ne $want) {
  Remove-Item $tmp
  throw "candor: $file doesn't match the release's SHA256SUMS; nothing installed"
}
$exe = Join-Path $dir 'candor.exe'
# An installed candor.exe (maybe running) is renamed aside, which Windows allows, then replaced.
if (Test-Path $exe) {
  $old = Join-Path $dir 'candor.old.exe'
  try { Remove-Item -Force $old -ErrorAction Stop } catch {}
  if (Test-Path $old) { $old = Join-Path $dir "candor.old.$(Get-Random).exe" }
  Move-Item $exe $old
}
Move-Item $tmp $exe
Write-Host "installed $((& $exe version)[0]) in $dir"

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($path -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'User')
  Write-Host 'added it to your PATH; open a new terminal'
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Host "candor builds with Go, which isn't on the PATH: winget install GoLang.Go"
}
