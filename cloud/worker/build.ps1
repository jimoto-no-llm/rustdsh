param(
    [Parameter(Mandatory = $true)][string]$RustImage,
    [Parameter(Mandatory = $true)][string]$NodeImage,
    [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = 'Stop'
$digestPattern = '@sha256:[0-9a-fA-F]{64}$'
foreach ($image in @($RustImage, $NodeImage)) {
    if ($image -notmatch $digestPattern) {
        throw "Base image must use an immutable sha256 digest: $image"
    }
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$changes = @(git -C $repo status --porcelain=v1 -uall)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git status' }
if ($changes.Count -ne 0) { throw 'Commit the exact source before building the worker image' }
$head = (git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git HEAD' }

docker build --file (Join-Path $PSScriptRoot 'Dockerfile') --tag $Tag `
    --build-arg "RUST_IMAGE=$RustImage" --build-arg "NODE_IMAGE=$NodeImage" `
    --label "cloud.rdsh.dev/rdsh-commit=$head" $repo
if ($LASTEXITCODE -ne 0) { throw 'Worker image build failed' }
Write-Output "Built $Tag from rustdsh $head and DSH 687f282e8625c6b8d11ff58211a90524be2e4317"
Write-Output 'Record the registry digest after an authorized push; use that digest in SandboxTemplate and SandboxRequest.'
