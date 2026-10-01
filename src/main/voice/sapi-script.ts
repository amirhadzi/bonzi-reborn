// The fixed PowerShell 5.1 script that hosts System.Speech for the SAPI bridge.
// It is passed with -EncodedCommand (UTF-16LE base64) and never changes at run
// time: requests (including the text to speak) arrive as JSON lines on stdin and
// are only ever used as data (ConvertFrom-Json, then [string] arguments to
// SelectVoice / Speak). Speak(string) treats its input as plain text, never SSML.
//
// Protocol (one JSON object per line, UTF-8):
//   host -> {"id":0,"ok":true,"ready":true}              once System.Speech is loaded
//   host -> {"id":0,"ok":false,"fatal":true,"error":"..."} when it cannot be loaded (then exits)
//   in   {"id":n,"op":"voices"}
//   out  {"id":n,"ok":true,"voices":[{name,culture,gender,age,description}]}
//   in   {"id":n,"op":"speak","text":"...","voice":"<installed name or empty>","rate":-10..10,"volume":0..100}
//   out  {"id":n,"ok":true,"sampleRate":22050,"pcm":"<base64 16-bit mono little-endian PCM>"}
//   out  {"id":n,"ok":false,"error":"..."}                 on any failure of request n
// The host exits when stdin closes, so it never outlives the app.

export const SAPI_SAMPLE_RATE = 22050;

/** Max characters the host accepts in one speak request (the IPC limit is lower). */
export const SAPI_MAX_TEXT = 8000;

export const SAPI_HOST_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
function Send([string]$line) { $stdout.WriteLine($line) }
function Str([string]$s) { return (ConvertTo-Json -InputObject $s -Compress) }
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $defaultVoice = [string]$synth.Voice.Name
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(__SAMPLE_RATE__, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
} catch {
  Send ('{"id":0,"ok":false,"fatal":true,"error":' + (Str $_.Exception.Message) + '}')
  exit 3
}
Send '{"id":0,"ok":true,"ready":true}'
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $op = [string]$req.op
    if ($op -eq 'voices') {
      $list = New-Object System.Collections.ArrayList
      foreach ($v in $synth.GetInstalledVoices()) {
        if (-not $v.Enabled) { continue }
        $i = $v.VoiceInfo
        $culture = ''
        if ($null -ne $i.Culture) { $culture = [string]$i.Culture.Name }
        [void]$list.Add([pscustomobject]@{ name = [string]$i.Name; culture = $culture; gender = [string]$i.Gender; age = [string]$i.Age; description = [string]$i.Description })
      }
      Send ('{"id":' + $id + ',"ok":true,"voices":' + (ConvertTo-Json -InputObject @($list.ToArray()) -Compress -Depth 3) + '}')
    } elseif ($op -eq 'speak') {
      $text = [string]$req.text
      if ($text.Length -eq 0 -or $text.Length -gt __MAX_TEXT__) { throw 'Text is empty or too long.' }
      $voice = [string]$req.voice
      if ($voice.Length -eq 0) { $voice = $defaultVoice }
      $synth.SelectVoice($voice)
      $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$req.rate))
      $synth.Volume = [Math]::Max(0, [Math]::Min(100, [int]$req.volume))
      $ms = New-Object System.IO.MemoryStream
      try {
        $synth.SetOutputToAudioStream($ms, $format)
        $synth.Speak($text)
      } finally {
        $synth.SetOutputToNull()
      }
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose()
      Send ('{"id":' + $id + ',"ok":true,"sampleRate":__SAMPLE_RATE__,"pcm":"' + $b64 + '"}')
    } else {
      throw 'Unknown op.'
    }
  } catch {
    Send ('{"id":' + $id + ',"ok":false,"error":' + (Str $_.Exception.Message) + '}')
  }
}
`
  .replaceAll('__SAMPLE_RATE__', String(SAPI_SAMPLE_RATE))
  .replaceAll('__MAX_TEXT__', String(SAPI_MAX_TEXT))
  .trim();

/** The -EncodedCommand argument: the script as UTF-16LE, base64. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
