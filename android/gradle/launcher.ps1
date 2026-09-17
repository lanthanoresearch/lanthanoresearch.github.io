# Lanthano Research - downloads the Gradle version named in
# gradle/wrapper/gradle-wrapper.properties (once) and runs it with the given
# arguments. Called by gradlew.bat when gradle-wrapper.jar is not present.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$appHome = Split-Path -Parent $PSScriptRoot
$propsFile = Join-Path $PSScriptRoot 'wrapper\gradle-wrapper.properties'

$props = @{}
foreach ($line in Get-Content -LiteralPath $propsFile) {
    if ($line -match '^\s*([^#=][^=]*)=(.*)$') {
        $props[$Matches[1].Trim()] = $Matches[2].Trim().Replace('\:', ':')
    }
}
$url = $props['distributionUrl']
if (-not $url) { throw "distributionUrl is not set in $propsFile" }

$zipName = [System.IO.Path]::GetFileName($url)
$distName = [System.IO.Path]::GetFileNameWithoutExtension($zipName) -replace '-(bin|all)$', ''
$userHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE '.gradle' }
$base = Join-Path $userHome 'wrapper\dists\lanthano-launcher'
$gradleHome = Join-Path $base $distName
$gradleBat = Join-Path $gradleHome 'bin\gradle.bat'

if (-not (Test-Path -LiteralPath $gradleBat)) {
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $part = Join-Path $base "$distName.download.zip"  # Expand-Archive needs a .zip extension
    $unpack = Join-Path $base "$distName.unpack"
    Remove-Item -LiteralPath $part, $unpack -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "Downloading $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing

    $expected = $props['distributionSha256Sum']
    if ($expected) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLowerInvariant()
        if ($actual -ne $expected.ToLowerInvariant()) {
            Remove-Item -LiteralPath $part -Force
            throw "Checksum mismatch for $zipName"
        }
    }

    Expand-Archive -LiteralPath $part -DestinationPath $unpack -Force
    if (-not (Test-Path -LiteralPath (Join-Path $unpack "$distName\bin\gradle.bat"))) {
        throw "Unexpected layout in $zipName"
    }
    Remove-Item -LiteralPath $gradleHome -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath (Join-Path $unpack $distName) -Destination $gradleHome
    Remove-Item -LiteralPath $unpack, $part -Recurse -Force -ErrorAction SilentlyContinue
}

& $gradleBat -p $appHome @args
exit $LASTEXITCODE
