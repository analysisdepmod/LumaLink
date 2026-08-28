using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace GridData.Server;

/// <summary>
/// Self-contained HTTPS for an air-gapped LAN: generates (and caches) a
/// self-signed certificate whose Subject Alternative Names cover localhost and
/// every current LAN IPv4, so a phone opening https://192.168.x.x:5444 gets a
/// certificate that actually matches the address. No internet, no dev-certs,
/// no manual steps. The browser still warns once (unknown issuer) — that is
/// unavoidable without a real CA, and the camera works after accepting.
/// </summary>
public static class Certificates
{
    private const string Password = "griddata";

    public static X509Certificate2 LoadOrCreate(string pfxPath, IReadOnlyCollection<string> lanIps)
    {
        if (File.Exists(pfxPath))
        {
            try
            {
                var existing = new X509Certificate2(pfxPath, Password, X509KeyStorageFlags.Exportable);
                if (existing.NotAfter > DateTime.Now.AddDays(1) && CoversAll(existing, lanIps))
                    return existing;
            }
            catch { /* corrupt/old cache → regenerate */ }
        }

        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=GridData", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false)); // TLS server auth

        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddIpAddress(IPAddress.Loopback);
        san.AddIpAddress(IPAddress.IPv6Loopback);
        foreach (var ip in lanIps)
            if (IPAddress.TryParse(ip, out var addr)) san.AddIpAddress(addr);
        req.CertificateExtensions.Add(san.Build());

        using var cert = req.CreateSelfSigned(
            DateTimeOffset.Now.AddDays(-1), DateTimeOffset.Now.AddYears(5));
        var pfx = cert.Export(X509ContentType.Pfx, Password);
        try { File.WriteAllBytes(pfxPath, pfx); } catch { /* read-only dir → keep in-memory */ }
        return new X509Certificate2(pfx, Password, X509KeyStorageFlags.Exportable);
    }

    private static bool CoversAll(X509Certificate2 cert, IReadOnlyCollection<string> ips)
    {
        // Regenerate if a LAN IP appeared that the cached cert's SAN text lacks.
        string san = "";
        foreach (var ext in cert.Extensions)
            if (ext.Oid?.Value == "2.5.29.17") san = ext.Format(false);
        foreach (var ip in ips)
            if (!san.Contains(ip)) return false;
        return true;
    }
}
