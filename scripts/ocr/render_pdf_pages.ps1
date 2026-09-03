param(
  [Parameter(Mandatory = $true)]
  [string]$InputPdf,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [int]$FirstPage = 1,
  [int]$LastPage = 20,
  [int]$Dpi = 144
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
pdftoppm -png -r $Dpi -f $FirstPage -l $LastPage $InputPdf (Join-Path $OutputDir "page")
Get-ChildItem $OutputDir -Filter "*.png" | Sort-Object Name | Select-Object Name, Length
