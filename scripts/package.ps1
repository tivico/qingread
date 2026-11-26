$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version in manifest.json' }
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appText = Get-Content -LiteralPath (Join-Path $projectRoot 'companion/app.py') -Raw -Encoding UTF8
$appVersion = [regex]::Match($appText, '(?m)^VERSION = "(\d+\.\d+\.\d+)"').Groups[1].Value
if ($package.version -ne $manifest.version -or $appVersion -ne $manifest.version) {
    throw 'Extension, package.json and companion versions must match before packaging.'
}

# Explicit product files: an extra note, credential or local fixture is never
# copied simply because it happens to be next to a shipping module.
$extensionFiles = @(
    'manifest.json', 'INSTALL.txt', 'background.js', 'panel.html', 'panel.js',
    'panel.css', 'playful.css', 'mascot.svg', 'content.js', 'core.js', 'frames.js',
    'local-client.js', 'summary.js', 'video-summary-core.js', 'video-summary.js',
    'transcript-content.js', 'text.js', 'caption-state.js', 'speech-state.js',
    'audio-worklet.js', 'media-content.js', 'video.js', 'video-pipeline.js',
    'video-background.js', 'video-clock.js', 'video-offscreen.html', 'video-offscreen.js',
    'workspace.html', 'workspace.js', 'workspace.css'
)
$companionFiles = @(
    'app.py', 'inference.py', 'pairing.py', 'runtime_status.py', 'launcher.py', 'pdf_progress.py', 'pdf_worker.py',
    'prepare.py', 'install.cmd', 'start.cmd', 'requirements.txt', 'requirements-lock.txt',
    'licenses/BabelDOC-AGPL-3.0.txt'
)
$files = @('QingRead-Install.pdf', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY.md', 'package.json', '.gitignore', '.gitattributes', 'docs/PROGRESS.md', 'scripts/package.ps1')
$files += $extensionFiles | ForEach-Object { 'extension/' + $_ }
$files += $companionFiles | ForEach-Object { 'companion/' + $_ }
# Test source and the known fixture directory only; never bytecode, recordings,
# PDFs, profiles or recursively collected temporary directories.
$files += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -File |
    Where-Object { $_.Extension -in @('.cjs', '.py', '.html') } |
    ForEach-Object { 'tests/' + $_.Name }
$files += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests/fixtures') -File |
    Where-Object { $_.Extension -in @('.html', '.json') } |
    ForEach-Object { 'tests/fixtures/' + $_.Name }

$releasePath = Join-Path $projectRoot 'releases'
$buildRoot = Join-Path $projectRoot 'build'
New-Item -ItemType Directory -Path $releasePath, $buildRoot -Force | Out-Null
foreach ($directory in @($releasePath, $buildRoot)) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Build and release directories must not be links.'
    }
}
$stage = [IO.Path]::GetFullPath((Join-Path $buildRoot ('package-' + [guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($relative in $files) {
        $source = Join-Path $projectRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing release file: $relative" }
        if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Release file must not be a link: $relative" }
        $destination = Join-Path $stage $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
    $archivePath = Join-Path $releasePath ('qingread-' + $manifest.version + '.zip')
    $fullArchive = Join-Path $releasePath ('qingread-complete-' + $manifest.version + '.zip')
    Compress-Archive -Path (Join-Path $stage 'extension/*') -DestinationPath $archivePath -Force
    # Enumerate with -Force so the source bundle also retains .gitignore and
    # .gitattributes across PowerShell versions.
    $topLevel = @(Get-ChildItem -LiteralPath $stage -Force | ForEach-Object { $_.FullName })
    Compress-Archive -LiteralPath $topLevel -DestinationPath $fullArchive -Force
    $artifacts = @(
        foreach ($archive in @($archivePath, $fullArchive)) {
            [ordered]@{ name = [IO.Path]::GetFileName($archive); bytes = (Get-Item -LiteralPath $archive).Length; sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
    )
    $checksums = Join-Path $releasePath ('qingread-' + $manifest.version + '-SHA256SUMS.txt')
    $artifacts | ForEach-Object { $_.sha256 + '  ' + $_.name } | Set-Content -LiteralPath $checksums -Encoding ASCII
    $releaseInfo = [ordered]@{ version = $manifest.version; channel = 'windows-local-preview'; createdUtc = [DateTime]::UtcNow.ToString('o'); artifacts = $artifacts }
    $metadataPath = Join-Path $releasePath ('qingread-' + $manifest.version + '-release.json')
    $releaseInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    Write-Output $archivePath
    Write-Output $fullArchive
    Write-Output $checksums
    Write-Output $metadataPath
} finally {
    # Only this invocation's verified direct child of build/ may be removed.
    if ((Split-Path -Parent $stage) -eq $buildRoot -and [IO.Path]::GetFileName($stage) -like 'package-*') {
        Remove-Item -LiteralPath $stage -Recurse -Force
    } else { throw 'Refusing to clean a staging path outside build/.' }
}
