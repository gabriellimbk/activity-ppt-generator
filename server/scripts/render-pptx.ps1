param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputDirectory,[int]$Dpi=150)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$powerpoint = New-Object -ComObject PowerPoint.Application
try { $deck = $powerpoint.Presentations.Open($InputPath, $true, $false, $false); $deck.Export($OutputDirectory, 'PNG', [int](13.333*$Dpi), [int](7.5*$Dpi)); $deck.Close() }
finally { $powerpoint.Quit(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint) | Out-Null }
