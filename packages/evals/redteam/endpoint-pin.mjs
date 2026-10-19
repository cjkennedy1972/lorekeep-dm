export function assertNoSecretParts(url, rawUrl = url.href) {
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    rawUrl.includes('?') ||
    rawUrl.includes('#')
  )
    throw new Error(
      'Endpoint URL must not contain credentials, a query, or a fragment',
    );
}

export function canonicalEndpointBaseUrl(endpointUrl) {
  const basePath = endpointUrl.pathname.replace(/\/+$/, '');
  return `${endpointUrl.origin}${basePath}`;
}

export function buildChatCompletionsUrl(endpointUrl) {
  return `${canonicalEndpointBaseUrl(endpointUrl)}/chat/completions`;
}

export function assertPinnedHost(endpointHost, expectedHost) {
  if (!expectedHost) throw new Error('REDTEAM_EXPECTED_HOST is required');
  if (endpointHost !== expectedHost)
    throw new Error(
      `Endpoint host ${endpointHost} does not match REDTEAM_EXPECTED_HOST ${expectedHost}`,
    );
}
