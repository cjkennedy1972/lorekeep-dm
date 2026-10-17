export function assertPinnedHost(endpointHost, expectedHost) {
  if (!expectedHost) throw new Error('REDTEAM_EXPECTED_HOST is required');
  if (endpointHost !== expectedHost)
    throw new Error(
      `Endpoint host ${endpointHost} does not match REDTEAM_EXPECTED_HOST ${expectedHost}`,
    );
}
