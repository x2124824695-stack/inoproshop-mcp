param(
    [Parameter(Mandatory=$true)][string]$EngineDir,
    [Parameter(Mandatory=$true)][string]$StdLib
)
$ErrorActionPreference = 'Stop'
# Run under Windows PowerShell 5.1/.NET Framework, without starting InoProShop.
foreach ($name in @('Microsoft.Scripting.Metadata.dll','Microsoft.Scripting.dll','Microsoft.Dynamic.dll','IronPython.dll','IronPython.Modules.dll')) {
    [void][Reflection.Assembly]::LoadFrom((Join-Path $EngineDir $name))
}
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('inoproshop-ironpython-' + [Guid]::NewGuid())
node (Join-Path $PSScriptRoot 'ironpython-fixtures.cjs') $fixtureDir
if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed' }
$engine = [IronPython.Hosting.Python]::CreateEngine()
$engine.SetSearchPaths([string[]]@($StdLib))
$scope = $engine.CreateScope()
$scope.SetVariable('FIXTURE_DIR', $fixtureDir)
$source = $engine.CreateScriptSourceFromFile((Join-Path $PSScriptRoot 'ironpython-smoke.py'))
try {
    $source.Execute($scope)
} catch {
    $service = $engine.GetType().GetMethods() | Where-Object { $_.Name -eq 'GetService' -and $_.IsGenericMethod }
    $closed = $service.MakeGenericMethod([Microsoft.Scripting.Hosting.ExceptionOperations])
    $formatter = $closed.Invoke($engine, (,([object[]]@())))
    Write-Output ($formatter.FormatException($_.Exception.InnerException))
    throw
}
Write-Output ('IronPython fixture artifacts: ' + $fixtureDir)
