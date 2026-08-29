using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using GridData.Server;

// GridData is an air-gapped visual-transfer tool: the entire pipeline
// (compress, chunk, fountain-encode, WHT/Hadamard matrix, CRC, camera decode)
// runs in the browser. The transfer travels optically, screen → camera, and
// never touches the network. This server does one job: serve the built PWA
// over HTTP and HTTPS so devices on the LAN can load it. The browser camera
// API requires HTTPS, so HTTPS is configured here with a self-signed cert that
// covers the machine's LAN IPs (see Certificates.cs) — no internet, no setup.

const int HttpPort = 5081;
const int HttpsPort = 5444;

var builder = WebApplication.CreateBuilder(args);

var lanIps = GetLanIPv4().ToList();
var certPath = Path.Combine(builder.Environment.ContentRootPath, "griddata-https.pfx");
var cert = Certificates.LoadOrCreate(certPath, lanIps);

builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(HttpPort);                              // http://*:5081
    options.ListenAnyIP(HttpsPort, lo => lo.UseHttps(cert));    // https://*:5444
});

var app = builder.Build();

// Opt the PWA into cross-origin isolation. This makes SharedArrayBuffer and
// WebAssembly shared memory available on HTTPS for future cooperative kernels.
// The current LDPC strategy deliberately parallelises whole optical frames
// across the existing worker pool; nested threads inside every worker would
// oversubscribe mobile CPUs and reduce Turbo throughput.
app.Use(async (context, next) =>
{
    context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    context.Response.Headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    context.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
    await next();
});

// Diagnostics travel only over the same LAN connection already used to load the
// PWA; transfer payloads never pass through this endpoint. Each completed optical
// transfer writes a small JSON receipt to disk so performance can be analysed
// later without asking the receiver to copy/paste a report.
var diagnosticsDirectory = Path.Combine(app.Environment.ContentRootPath, "diagnostics");
Directory.CreateDirectory(diagnosticsDirectory);
const int MaxDiagnosticReports = 5000;

app.MapPost("/api/diagnostics", async (HttpRequest request) =>
{
    const int maxReportBytes = 64 * 1024;
    if (request.ContentLength is > maxReportBytes)
        return Results.BadRequest(new { error = "Diagnostic report is too large." });

    try
    {
        using var document = await JsonDocument.ParseAsync(request.Body);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            return Results.BadRequest(new { error = "Diagnostic report must be a JSON object." });

        var id = $"{DateTimeOffset.UtcNow:yyyyMMddTHHmmssfffZ}-{Guid.NewGuid():N}";
        var path = Path.Combine(diagnosticsDirectory, $"{id}.json");
        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, new
        {
            recordedAt = DateTimeOffset.UtcNow,
            remoteIp = request.HttpContext.Connection.RemoteIpAddress?.ToString(),
            report = document.RootElement,
        }, new JsonSerializerOptions { WriteIndented = true });
        // Keep a bounded rolling history: diagnostics must not quietly consume
        // the server disk during long-running field tests.
        foreach (var oldPath in Directory.EnumerateFiles(diagnosticsDirectory, "*.json")
                     .OrderByDescending(File.GetCreationTimeUtc)
                     .Skip(MaxDiagnosticReports))
        {
            try { File.Delete(oldPath); } catch { /* next receipt can retry cleanup */ }
        }
        return Results.Created($"/api/diagnostics/{id}", new { id });
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { error = "Invalid diagnostic JSON." });
    }
});

app.MapGet("/api/diagnostics", () =>
{
    var files = Directory.EnumerateFiles(diagnosticsDirectory, "*.json")
        .OrderByDescending(File.GetCreationTimeUtc)
        .Take(100)
        .Select(path => new { file = Path.GetFileName(path), createdAt = File.GetCreationTimeUtc(path) });
    return Results.Ok(files);
});

app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

 

app.Run();

static IEnumerable<string> GetLanIPv4()
{
    var seen = new HashSet<string>();
    foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
    {
        if (nic.OperationalStatus != OperationalStatus.Up) continue;
        if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
        foreach (var addr in nic.GetIPProperties().UnicastAddresses)
        {
            if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
            var s = addr.Address.ToString();
            if (s.StartsWith("169.254")) continue;
            if (seen.Add(s)) yield return s;
        }
    }
}
