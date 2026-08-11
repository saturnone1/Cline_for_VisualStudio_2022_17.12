param(
    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"
function Fail([string]$Message) { throw "[Menu contract failed] $Message" }

$vsctPath = Join-Path $RepoRoot "src\extension\VsClineAgentPackage.vsct"
$packagePath = Join-Path $RepoRoot "src\extension\VsClineAgentPackage.cs"
[xml]$vsct = Get-Content -LiteralPath $vsctPath -Raw -Encoding utf8
$namespace = [System.Xml.XmlNamespaceManager]::new($vsct.NameTable)
$namespace.AddNamespace("v", "http://schemas.microsoft.com/VisualStudio/2005-10-18/CommandTable")

$button = $vsct.SelectSingleNode("//v:Button[@id='cmdOpenChatWindow']", $namespace)
if (-not $button) { Fail "cmdOpenChatWindow is missing." }
$icon = $button.SelectSingleNode("v:Icon", $namespace)
if (-not $icon -or $icon.guid -ne "ImageCatalogGuid" -or $icon.id -ne "MessageBubble") {
    Fail "cmdOpenChatWindow must use the Visual Studio MessageBubble image moniker."
}
$flags = @($button.SelectNodes("v:CommandFlag", $namespace) | ForEach-Object InnerText)
if (-not $flags.Contains("IconIsMoniker")) { Fail "cmdOpenChatWindow is missing IconIsMoniker." }
$include = $vsct.SelectSingleNode("//v:Include[@href='KnownImageIds.vsct']", $namespace)
if (-not $include) { Fail "KnownImageIds.vsct is not included." }

$packageSource = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8
if ($packageSource -notmatch '\[ProvideMenuResource\("Menus\.ctmenu",\s*1\)\]') {
    Fail "VsClineAgentPackage does not register Menus.ctmenu."
}

Write-Host "LIG VS menu command and image moniker contract passed."
