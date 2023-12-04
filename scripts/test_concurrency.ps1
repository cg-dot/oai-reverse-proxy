$NumThreads = 10

$runspacePool = [runspacefactory]::CreateRunspacePool(1, $NumThreads)
$runspacePool.Open()
$runspaces = @()

$headers = @{
    "Authorization" = "Bearer test"
    "anthropic-version" = "2023-01-01"
    "Content-Type" = "application/json"
}

$payload = @{
    model = "claude-v2"
    max_tokens_to_sample = 40
    temperature = 0
    stream = $true
    prompt = "Test prompt, please reply with lorem ipsum`n`n:Assistant:"
} | ConvertTo-Json

for ($i = 1; $i -le $NumThreads; $i++) {
    Write-Host "Starting thread $i"
    $runspace = [powershell]::Create()
    $runspace.AddScript({
        param($i, $headers, $payload)
        $response = Invoke-WebRequest -Uri "http://localhost:7860/proxy/aws/claude/v1/complete" -Method Post -Headers $headers -Body $payload
        Write-Host "Response from server: $($response.StatusCode)"
    }).AddArgument($i).AddArgument($headers).AddArgument($payload)

    $runspace.RunspacePool = $runspacePool
    $runspaces += [PSCustomObject]@{ Pipe = $runspace; Status = $runspace.BeginInvoke() }
}

$runspaces | ForEach-Object {
    $_.Pipe.EndInvoke($_.Status)
    $_.Pipe.Dispose()
}

$runspacePool.Close()
$runspacePool.Dispose()
