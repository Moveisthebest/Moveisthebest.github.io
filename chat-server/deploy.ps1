# Uploads the chat proxy code, the paper summaries and the original papers (full.md)
# to the server as one archive, then restarts it.
# Usage (from the repo root):  pwsh chat-server/deploy.ps1
param(
  [string]$Server = "flash-vps",
  [string]$PubDir = "C:\Users\Administrator\Desktop\my pub"
)
$ErrorActionPreference = "Stop"
$stage = Join-Path ([IO.Path]::GetTempPath()) "kw-chat-deploy"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$stage/app/knowledge", "$stage/app/papers" | Out-Null

Copy-Item "$PSScriptRoot/server.mjs", "$PSScriptRoot/knowledge.mjs", "$PSScriptRoot/profile.md" "$stage/app"
Copy-Item -Path (Join-Path $PubDir "Paper Summary\*.md") -Destination "$stage/app/knowledge"
# Each paper folder's full.md is uploaded as papers/<folder name with _ for spaces>.md
Get-ChildItem -LiteralPath $PubDir -Directory | Where-Object { Test-Path -LiteralPath "$($_.FullName)\full.md" } | ForEach-Object {
  Copy-Item -LiteralPath "$($_.FullName)\full.md" -Destination "$stage/app/papers/$($_.Name -replace ' ', '_').md"
}

# One archive: uploading many files in a single scp stalled on this link.
tar -czf "$stage/kw-chat.tgz" -C "$stage/app" .
scp -q "$stage/kw-chat.tgz" "${Server}:/tmp/kw-chat.tgz"
ssh -n $Server "rm -f /opt/kw-chat/knowledge/*.md /opt/kw-chat/papers/*.md && mkdir -p /opt/kw-chat && tar -xzf /tmp/kw-chat.tgz -C /opt/kw-chat --no-same-owner && rm -f /tmp/kw-chat.tgz && chmod -R a+rX /opt/kw-chat && systemctl restart kw-chat && sleep 2 && systemctl is-active kw-chat && journalctl -u kw-chat -n 3 --no-pager -o cat"
Remove-Item -Recurse -Force $stage