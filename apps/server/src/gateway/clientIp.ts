import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';

export type TrustProxy = boolean | number | string[];

type ProxyAddress = {
  all: (
    request: IncomingMessage,
    trust: (address: string, hop: number) => boolean,
  ) => string[];
  compile: (trust: string[]) => (address: string, hop: number) => boolean;
};

// Use the same proxy-addr implementation Fastify uses for request.ip.
const fastifyRequire = createRequire(createRequire(import.meta.url).resolve('fastify'));
const proxyAddress = fastifyRequire('@fastify/proxy-addr') as ProxyAddress;

export function getClientIp(request: IncomingMessage, trustProxy: TrustProxy): string {
  const socketAddress = request.socket.remoteAddress;
  if (!socketAddress) return 'unknown';
  if (!trustProxy) return socketAddress;

  let trust: (address: string, hop: number) => boolean;
  if (trustProxy === true) {
    trust = () => true;
  } else if (typeof trustProxy === 'number') {
    trust = (_address, hop) => hop < trustProxy;
  } else {
    trust = proxyAddress.compile(trustProxy);
  }

  try {
    const header = request.headers['x-forwarded-for'];
    if (typeof header === 'string') {
      const addresses = header.split(',').map((address) => address.trim());
      if (addresses.some((address) => isIP(address) === 0)) return socketAddress;
    }
    const addresses = proxyAddress.all(request, trust);
    return addresses.at(-1) ?? socketAddress;
  } catch {
    return socketAddress;
  }
}
