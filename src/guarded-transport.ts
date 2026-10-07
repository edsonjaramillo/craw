import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import ipaddr from "ipaddr.js";

export interface TransportRequest {
  url: URL;
  address: string;
  identity: string;
  signal: AbortSignal;
}
export type AuditTransport = (request: TransportRequest) => Promise<Response>;
export type AuditDns = (hostname: string) => Promise<string[]>;
export const publicDns: AuditDns = async (hostname) =>
  (await lookup(hostname, { all: true, order: "verbatim" })).map((answer) => answer.address);

export class DestinationRefused extends Error {}

export async function validateDestination(url: URL, dns: AuditDns): Promise<string> {
  if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) {
    throw new DestinationRefused("Only standard-port HTTP(S) without credentials is permitted.");
  }
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, "");
  const addresses = ipaddr.isValid(hostname) ? [hostname] : await dns(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) => !ipaddr.isValid(address) || ipaddr.parse(address).range() !== "unicast",
    )
  ) {
    throw new DestinationRefused("Destination has non-public or unavailable network addresses.");
  }
  return addresses[0]!;
}

/** No redirects or secondary DNS lookup. TLS verifies the logical hostname using system trust. */
export const productionTransport: AuditTransport = ({ url, address, identity, signal }) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: { "user-agent": identity, accept: "*/*", "accept-encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          const family = ipaddr.parse(address).kind() === "ipv6" ? 6 : 4;
          if (options.all === true) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 500;
        const body = [204, 205, 304].includes(status)
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        if (body === null) incoming.resume();
        resolve(new Response(body, { status, headers }));
      },
    );
    request.on("error", reject);
    request.end();
  });
