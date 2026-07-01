import * as dgram from "node:dgram";

export interface BrowserDnsRecord {
  /** Browser-facing host exposed through the local resolver, such as alpha1 or alpha1.pm. */
  readonly hostname: string;
  /** Network-specific loopback address returned as an A record. */
  readonly address: string;
}

export interface BrowserDnsServerOptions {
  /** UDP address used by the local resolver client. */
  readonly host?: string;
  /** UDP port used by the local resolver client. */
  readonly port?: number;
}

interface ParsedQuestion {
  /** Hostname requested by the resolver, without a trailing dot. */
  readonly name: string;
  /** DNS record type, e.g. A or AAAA. */
  readonly type: number;
  /** DNS class, normally IN. */
  readonly klass: number;
  /** Offset immediately after the question section. */
  readonly endOffset: number;
}

const DNS_PORT = 53_153;
const DNS_HOST = "127.0.0.1";
const DNS_TYPE_A = 1;
const DNS_TYPE_ANY = 255;
const DNS_CLASS_IN = 1;
const RESPONSE_TTL_SECONDS = 1;

/**
 * Tiny local DNS server for browser-facing development aliases.
 *
 * macOS can route single-label names or private suffixes through
 * `/etc/resolver/<name>` files. The extension keeps this unprivileged UDP
 * server on a high port and only answers A records for current logical-network
 * browser aliases.
 */
export class BrowserDnsServer {
  /** UDP socket that answers local resolver queries. */
  private socket: dgram.Socket | undefined;

  /** Current hostname-to-loopback table, normalized to lower case. */
  private readonly records = new Map<string, string>();

  /** Last startup failure. Callers use this to fall back to numeric loopback URLs. */
  private lastError: Error | undefined;

  constructor(private readonly options: BrowserDnsServerOptions = {}) {}

  /** Starts the DNS server if it is not already running. */
  async start(): Promise<void> {
    if (this.socket !== undefined) {
      return;
    }

    const socket = dgram.createSocket("udp4");
    socket.on("message", (message, remote) => {
      const response = this.buildResponse(message);
      if (response !== undefined) {
        socket.send(response, remote.port, remote.address);
      }
    });
    socket.on("error", (error) => {
      this.lastError = error;
    });

    try {
      await bind(socket, this.getPort(), this.options.host ?? DNS_HOST);
      this.socket = socket;
      this.lastError = undefined;
    } catch (error) {
      socket.close();
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw this.lastError;
    }
  }

  /** Replaces the active DNS table. Invalid hostnames and addresses are ignored. */
  sync(records: Iterable<BrowserDnsRecord>): void {
    this.records.clear();

    for (const record of records) {
      const hostname = normalizeDnsRecordName(record.hostname);
      const address = parseIpv4Address(record.address);
      if (hostname === undefined || address === undefined) {
        continue;
      }

      this.records.set(hostname, address.join("."));
    }
  }

  /** Returns true only when the UDP DNS server is accepting queries. */
  isRunning(): boolean {
    return this.socket !== undefined && this.lastError === undefined;
  }

  /** Local UDP port used by generated resolver configuration. */
  getPort(): number {
    const address = this.socket?.address();
    if (typeof address === "object" && address !== null) {
      return address.port;
    }

    return this.options.port ?? DNS_PORT;
  }

  /** Last startup/runtime error, useful for diagnostics. */
  getLastError(): Error | undefined {
    return this.lastError;
  }

  /** Stops the UDP DNS server during extension shutdown. */
  dispose(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.close();
    }
  }

  private buildResponse(query: Buffer): Buffer | undefined {
    if (query.length < 12) {
      return undefined;
    }

    const id = query.readUInt16BE(0);
    const flags = query.readUInt16BE(2);
    const questionCount = query.readUInt16BE(4);
    if (questionCount < 1) {
      return buildHeader(id, flags, 0, 0, 0);
    }

    const question = parseQuestion(query, 12);
    if (question === undefined) {
      return buildHeader(id, flags, 0, 0, 1);
    }

    const questionBytes = query.subarray(12, question.endOffset);
    const address = this.records.get(normalizeDnsQueryName(question.name));
    const canAnswer =
      address !== undefined &&
      question.klass === DNS_CLASS_IN &&
      (question.type === DNS_TYPE_A || question.type === DNS_TYPE_ANY);

    if (!canAnswer) {
      const responseCode = address === undefined ? 3 : 0;
      return Buffer.concat([buildHeader(id, flags, 1, 0, responseCode), questionBytes]);
    }

    const answer = buildARecordAnswer(address);
    return Buffer.concat([buildHeader(id, flags, 1, 1, 0), questionBytes, answer]);
  }
}

export function browserDnsPort(): number {
  return DNS_PORT;
}

export function normalizeBrowserDnsHostname(value: string): string | undefined {
  return normalizeHostname(value);
}

function normalizeDnsRecordName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".");
  if (labels.length === 0 || normalized.length > 253) {
    return undefined;
  }

  const normalizedLabels: string[] = [];
  for (const label of labels) {
    const normalizedLabel = normalizeHostname(label);
    if (normalizedLabel === undefined) {
      return undefined;
    }
    normalizedLabels.push(normalizedLabel);
  }

  return normalizedLabels.join(".");
}

function bind(socket: dgram.Socket, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("listening", onListening);
    };

    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, host);
  });
}

function parseQuestion(packet: Buffer, offset: number): ParsedQuestion | undefined {
  const nameParts: string[] = [];
  let cursor = offset;

  while (cursor < packet.length) {
    const length = packet[cursor];
    cursor += 1;

    if (length === 0) {
      break;
    }

    if ((length & 0xc0) !== 0) {
      return undefined;
    }

    if (cursor + length > packet.length) {
      return undefined;
    }

    nameParts.push(packet.subarray(cursor, cursor + length).toString("ascii"));
    cursor += length;
  }

  if (cursor + 4 > packet.length || nameParts.length === 0) {
    return undefined;
  }

  return {
    name: nameParts.join("."),
    type: packet.readUInt16BE(cursor),
    klass: packet.readUInt16BE(cursor + 2),
    endOffset: cursor + 4,
  };
}

function buildHeader(
  id: number,
  requestFlags: number,
  questionCount: number,
  answerCount: number,
  responseCode: number,
): Buffer {
  const header = Buffer.alloc(12);
  const responseFlags = 0x8000 | (requestFlags & 0x0100) | 0x0080 | (responseCode & 0x000f);

  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(responseFlags, 2);
  header.writeUInt16BE(questionCount, 4);
  header.writeUInt16BE(answerCount, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return header;
}

function buildARecordAnswer(address: string): Buffer {
  const octets = parseIpv4Address(address);
  if (octets === undefined) {
    throw new Error(`Invalid browser DNS address: ${address}`);
  }

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(DNS_TYPE_A, 2);
  answer.writeUInt16BE(DNS_CLASS_IN, 4);
  answer.writeUInt32BE(RESPONSE_TTL_SECONDS, 6);
  answer.writeUInt16BE(4, 10);

  for (let index = 0; index < octets.length; index++) {
    answer[12 + index] = octets[index];
  }

  return answer;
}

function normalizeDnsQueryName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

function normalizeHostname(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");

  if (trimmed.length === 0 || trimmed.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function parseIpv4Address(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }

  return octets;
}
