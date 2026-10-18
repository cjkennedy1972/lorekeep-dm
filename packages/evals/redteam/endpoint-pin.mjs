export function assertNoSecretParts(url) {
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Endpoint URL must not contain credentials, a query, or a fragment',
    );
}

export function assertPinnedHost(endpointHost, expectedHost) {
  if (!expectedHost) throw new Error('REDTEAM_EXPECTED_HOST is required');
  if (endpointHost !== expectedHost)
    throw new Error(
      `Endpoint host ${endpointHost} does not match REDTEAM_EXPECTED_HOST ${expectedHost}`,
    );
}
