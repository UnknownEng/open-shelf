param([string]$LinesJson, [string]$OutDir, [string]$Voice = 'Microsoft Zira Desktop', [int]$Rate = 0)
# Reads a JSON array of strings, writes OutDir\NN.wav for each, prints JSON of durations (seconds).
Add-Type -AssemblyName System.Speech
$lines = Get-Content -Raw -Encoding UTF8 $LinesJson | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$durations = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($Voice)
  $s.Rate = $Rate
  $path = Join-Path $OutDir ('{0:D2}.wav' -f $i)
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($path, $fmt)
  $s.Speak([string]$lines[$i])
  $s.Dispose()
  $bytes = (Get-Item $path).Length - 44
  $durations += [math]::Round($bytes / (44100 * 2), 3)
}
$durations | ConvertTo-Json -Compress
