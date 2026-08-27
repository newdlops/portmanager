import { X509Certificate } from "node:crypto";

export interface ParsedBrowserTlsCertificate {
  readonly certificate?: X509Certificate;
  readonly validToMs?: number;
}

/** Parses one PEM leaf for the two facts browser readiness needs. */
export function parseBrowserTlsCertificate(pem: string): ParsedBrowserTlsCertificate {
  try {
    const certificate = new X509Certificate(pem);
    const parsedExpiry = Date.parse(certificate.validTo);
    return {
      certificate,
      ...(Number.isNaN(parsedExpiry) ? {} : { validToMs: parsedExpiry }),
    };
  } catch {
    return {};
  }
}

/** Evaluates hostname coverage against the signed leaf, not a sidecar marker. */
export function browserTlsCertificateCoversHostname(
  certificate: X509Certificate | undefined,
  hostname: string,
): boolean {
  if (certificate === undefined) {
    return false;
  }

  try {
    return certificate.checkHost(hostname) !== undefined;
  } catch {
    return false;
  }
}
