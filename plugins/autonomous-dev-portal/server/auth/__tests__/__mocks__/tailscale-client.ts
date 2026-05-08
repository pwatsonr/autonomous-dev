// SPEC-030-1-03: typed mock for ../tailscale-client.
//
// Imports the production TailscaleClient interface so a production-side
// rename or signature change breaks the mock at compile time (TDD-030
// §8.4 mock-drift mitigation, OQ-05). Use createMock() from tests; the
// default returns a valid identity so happy-path tests need no overrides.

import type { TailscaleClient, TailscaleWhois } from "../../tailscale-client";

export const DEFAULT_WHOIS: TailscaleWhois = {
    login: "alice@example.com",
    display_name: "Alice",
};

export function createMock(overrides: Partial<TailscaleClient> = {}): TailscaleClient {
    const base: TailscaleClient = {
        ensureAvailable: jest.fn().mockResolvedValue(undefined),
        getInterfaceIp: jest.fn().mockResolvedValue("100.64.1.2"),
        getTailnetCIDRs: jest
            .fn()
            .mockResolvedValue(["100.64.0.0/10", "fd7a:115c:a1e0::/48"]),
        whois: jest.fn().mockResolvedValue(DEFAULT_WHOIS),
    };
    return { ...base, ...overrides };
}
