/**
 * Throwaway self-signed EC P-256 key and certificate (CN and SAN hooks.example.test, 100 years) for
 * the webhook HTTP adapter spec only. It protects nothing: it never leaves the test process.
 */
export const TEST_TLS_HOST = 'hooks.example.test';

export const TEST_TLS_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIHGVeOFFUccge8uVRYkKnhCs0vQV3NDAgFghNyC/lgTjoAoGCCqGSM49
AwEHoUQDQgAEq5Y276a6pQsbqZPG0tPvqYTxg4EjdGr+XUkbko1tfEEmsggONt2U
qrQDMb+1U0m9rwsHRQGhj8iHiUQQTh/fKw==
-----END EC PRIVATE KEY-----
`;

export const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBsTCCAVagAwIBAgIUJv5eiiRlJKVC4wUgJoPNnjwmNq4wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSaG9va3MuZXhhbXBsZS50ZXN0MCAXDTI2MTAwMjIzMjkxNFoY
DzIxMjYwOTA4MjMyOTE0WjAdMRswGQYDVQQDDBJob29rcy5leGFtcGxlLnRlc3Qw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASrljbvprqlCxupk8bS0++phPGDgSN0
av5dSRuSjW18QSayCA423ZSqtAMxv7VTSb2vCwdFAaGPyIeJRBBOH98ro3IwcDAd
BgNVHQ4EFgQUI2ONeeLVynC4FV6cc8U6JByy8KMwHwYDVR0jBBgwFoAUI2ONeeLV
ynC4FV6cc8U6JByy8KMwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHREEFjAUghJob29r
cy5leGFtcGxlLnRlc3QwCgYIKoZIzj0EAwIDSQAwRgIhAMq07RUa1tGXCEKZgDBy
k9oPdEV5Awyv1l7AQnxCbh76AiEA6O31ixdNi85QfImTactsvC/pNvKjBglY3fbw
5G3hgjw=
-----END CERTIFICATE-----
`;
