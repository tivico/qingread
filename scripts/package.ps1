$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $projectRoot 'extension'
$manifest = Get-Content -LiteralPath (Join-Path $extensionPath 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version in manifest.json' }
$releasePath = Join-Path $projectRoot 'releases'
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
$archivePath = Join-Path $releasePath ('qingread-' + $manifest.version + '.zip')
Compress-Archive -Path (Join-Path $extensionPath '*') -DestinationPath $archivePath -Force
Write-Output $archivePath
$stage = Join-Path $projectRoot ('build/package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $stage 'companion') -Force | Out-Null
Copy-Item -LiteralPath $extensionPath -Destination $stage -Recurse
Copy-Item -Path (Join-Path $projectRoot 'companion/*.py'), (Join-Path $projectRoot 'companion/*.cmd'), (Join-Path $projectRoot 'companion/requirements*.txt') -Destination (Join-Path $stage 'companion')
Copy-Item -LiteralPath (Join-Path $projectRoot 'companion/licenses') -Destination (Join-Path $stage 'companion') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md'), (Join-Path $projectRoot 'THIRD_PARTY.md'), (Join-Path $projectRoot 'package.json') -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot 'tests'), (Join-Path $projectRoot 'scripts') -Destination $stage -Recurse
$fullArchive = Join-Path $releasePath ('qingread-complete-' + $manifest.version + '.zip')
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $fullArchive -Force
Write-Output $fullArchive
