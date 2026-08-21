param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$extension = [IO.Path]::GetExtension($InputPath).ToLowerInvariant()
if ($extension -eq '.docx') {
  $word = New-Object -ComObject Word.Application
  try { $word.Visible = $false; $doc = $word.Documents.Open($InputPath, $false, $true); $doc.ExportAsFixedFormat($OutputPath, 17); $doc.Close($false) }
  finally { $word.Quit(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
} elseif ($extension -eq '.pptx') {
  $powerpoint = New-Object -ComObject PowerPoint.Application
  try { $deck = $powerpoint.Presentations.Open($InputPath, $true, $false, $false); $deck.SaveAs($OutputPath, 32); $deck.Close() }
  finally { $powerpoint.Quit(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint) | Out-Null }
} else { throw "Unsupported Office file: $extension" }
