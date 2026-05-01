// SPEC-014-1-03 §Task 3.2 — IPv4/IPv6 CIDR membership.
//
// Pure-TS, no third-party deps. The Tailscale provider needs membership
// for two ranges (CGNAT 100.64.0.0/10 and Tailscale ULA fd7a:115c:a1e0::/48),
// so the helpers stay focused on what's required for that flow:
//   - parseCIDR(s)        -> { kind, bytes, prefixLen }
//   - ipInCIDR(ip, range) -> boolean
//   - ipInAnyCIDR(ip, ranges)
//
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are normalised to IPv4
// before comparison. Cross-family comparisons are always false.

import { SecurityError } from "./types";

export type CidrKind = "v4" | "v6";

export interface CIDRRange {
    kind: CidrKind;
    /** 4 bytes for v4, 16 for v6. Already AND-ed against the prefix mask. */
    bytes: Uint8Array;
    prefixLen: number;
}

const IPV4_OCTET_RE = /^\d{1,3}$/;

function parseIPv4Bytes(ip: string): Uint8Array | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        const p = parts[i];
        if (typeof p !== "string" || !IPV4_OCTET_RE.test(p)) return null;
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        out[i] = n;
    }
    return out;
}

function parseIPv6Bytes(ip: string): Uint8Array | null {
    // Reject obvious junk before going through the expansion path.
    if (ip.length === 0 || /[^0-9a-f:.]/i.test(ip)) return null;
    // Handle the IPv4-mapped suffix (e.g. ::ffff:127.0.0.1) by translating
    // the trailing v4 literal into two 16-bit groups.
    let work = ip;
    const lastColon = work.lastIndexOf(":");
    if (lastColon !== -1 && work.includes(".", lastColon)) {
        const v4 = parseIPv4Bytes(work.slice(lastColon + 1));
        if (v4 === null) return null;
        const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
        const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
        work =
            work.slice(0, lastColon + 1) +
            hi.toString(16) +
            ":" +
            lo.toString(16);
    }
    // Expand "::" into the necessary number of zero groups.
    const dblIdx = work.indexOf("::");
    let groups: string[];
    if (dblIdx === -1) {
        groups = work.split(":");
    } else {
        const left = work.slice(0, dblIdx);
        const right = work.slice(dblIdx + 2);
        const lParts = left === "" ? [] : left.split(":");
        const rParts = right === "" ? [] : right.split(":");
        const missing = 8 - lParts.length - rParts.length;
        if (missing < 0) return null;
        groups = [
            ...lParts,
            ...Array.from<string>({ length: missing }).fill("0"),
            ...rParts,
        ];
    }
    if (groups.length !== 8) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        const g = groups[i];
        if (typeof g !== "string" || g.length === 0 || g.length > 4) return null;
        if (!/^[0-9a-f]+$/i.test(g)) return null;
        const v = parseInt(g, 16);
        if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
        out[i * 2] = (v >> 8) & 0xff;
        out[i * 2 + 1] = v & 0xff;
    }
    return out;
}

/**
 * Normalise an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d` or
 * `::ffff:hhhh:hhhh`) into its IPv4 dotted form. Returns null when the
 * input is not v4-mapped.
 */
function ipv4FromMappedV6(ip: string): string | null {
    const bytes = parseIPv6Bytes(ip);
    if (bytes === null) return null;
    // First 80 bits zero, next 16 bits 0xffff, then v4 in last 32 bits.
    for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
    if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
    return `${bytes[12] ?? 0}.${bytes[13] ?? 0}.${bytes[14] ?? 0}.${
        bytes[15] ?? 0
    }`;
}

function maskBytes(bytes: Uint8Array, prefixLen: number): Uint8Array {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        const bitsLeft = prefixLen - i * 8;
        if (bitsLeft >= 8) {
            out[i] = bytes[i] ?? 0;
        } else if (bitsLeft <= 0) {
            out[i] = 0;
        } else {
            const mask = (0xff << (8 - bitsLeft)) & 0xff;
            out[i] = (bytes[i] ?? 0) & mask;
        }
    }
    return out;
}

export function parseCIDR(s: string): CIDRRange {
    if (typeof s !== "string" || !s.includes("/")) {
        throw new SecurityError(
            "INVALID_CIDR",
            `CIDR must contain '/': '${String(s)}'`,
        );
    }
    const slash = s.lastIndexOf("/");
    const ipPart = s.slice(0, slash);
    const lenPart = s.slice(slash + 1);
    const prefixLen = Number(lenPart);
    if (!Number.isInteger(prefixLen) || prefixLen < 0) {
        throw new SecurityError(
            "INVALID_CIDR",
            `CIDR prefix must be a non-negative integer: '${s}'`,
        );
    }
    const v4 = parseIPv4Bytes(ipPart);
    if (v4 !== null) {
        if (prefixLen > 32) {
            throw new SecurityError(
                "INVALID_CIDR",
                `IPv4 CIDR prefix must be <= 32: '${s}'`,
            );
        }
        return { kind: "v4", bytes: maskBytes(v4, prefixLen), prefixLen };
    }
    const v6 = parseIPv6Bytes(ipPart);
    if (v6 !== null) {
        if (prefixLen > 128) {
            throw new SecurityError(
                "INVALID_CIDR",
                `IPv6 CIDR prefix must be <= 128: '${s}'`,
            );
        }
        return { kind: "v6", bytes: maskBytes(v6, prefixLen), prefixLen };
    }
    throw new SecurityError("INVALID_CIDR", `Unparseable CIDR address: '${s}'`);
}

/** Returns true iff `ip` falls inside `range`. Cross-family always false. */
export function ipInCIDR(ip: string, range: CIDRRange): boolean {
    if (typeof ip !== "string" || ip.length === 0) return false;

    let kind: CidrKind;
    let bytes: Uint8Array | null;

    // Normalise IPv4-mapped IPv6 down to IPv4 before deciding family.
    const mapped = ip.includes(":") ? ipv4FromMappedV6(ip) : null;
    if (mapped !== null) {
        kind = "v4";
        bytes = parseIPv4Bytes(mapped);
    } else if (ip.includes(":")) {
        kind = "v6";
        bytes = parseIPv6Bytes(ip);
    } else {
        kind = "v4";
        bytes = parseIPv4Bytes(ip);
    }
    if (bytes === null) return false;
    if (kind !== range.kind) return false;
    const masked = maskBytes(bytes, range.prefixLen);
    if (masked.length !== range.bytes.length) return false;
    for (let i = 0; i < masked.length; i++) {
        if (masked[i] !== range.bytes[i]) return false;
    }
    return true;
}

export function ipInAnyCIDR(ip: string, ranges: ReadonlyArray<CIDRRange>): boolean {
    for (const r of ranges) {
        if (ipInCIDR(ip, r)) return true;
    }
    return false;
}
