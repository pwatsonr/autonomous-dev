// SPEC-015-2-05 §MockIntakeRouter — Standalone Hono app that records the
// commands sent to it. Used by IntakeRouterClient and end-to-end approval
// flow tests so we can assert on what the portal sent without running a
// real daemon.
//
// Behavior modes:
//   - 'ok'             → 200 always
//   - 'fail-permanent' → 422 (drives the no-retry path)
//   - 'fail-transient' → 503 (drives the retry-exhaustion path)
//   - 'fail-then-ok'   → first N requests 503, then 200

import { serve, type Server } from "bun";
import { Hono } from "hono";

type AnyServer = Server<unknown>;

export type RouterBehavior =
    | "ok"
    | "fail-permanent"
    | "fail-transient"
    | "fail-then-ok";

export interface RecordedCommand {
    command: string;
    body: Record<string, unknown>;
    receivedAt: number;
    responseStatus: number;
}

export class MockIntakeRouter {
    private server: AnyServer | null = null;
    private commands: RecordedCommand[] = [];
    private behavior: RouterBehavior = "ok";
    private failuresRemaining = 0;

    /** Bound port — populated after `start()`. */
    port = 0;

    async start(): Promise<void> {
        const app = new Hono();
        app.post("/router/command", async (c) => {
            let body: Record<string, unknown> = {};
            try {
                body = (await c.req.json()) as Record<string, unknown>;
            } catch {
                body = {};
            }
            const status = this.computeStatus();
            this.commands.push({
                command:
                    typeof body["command"] === "string"
                        ? (body["command"] as string)
                        : "",
                body,
                receivedAt: Date.now(),
                responseStatus: status,
            });
            if (status >= 200 && status < 300) {
                return c.json(
                    {
                        commandId: `mock-${String(this.commands.length)}`,
                        data: {},
                    },
                    status as 200,
                );
            }
            return c.json(
                {
                    error: this.computeErrorMessage(status),
                    errorCode: this.computeErrorCode(status),
                },
                status as 422 | 503,
            );
        });
        app.get("/router/health", (c) =>
            c.json({ version: "1.0-mock" }),
        );
        app.post("/router/health", (c) =>
            c.json({ version: "1.0-mock" }),
        );

        this.server = serve({ port: 0, fetch: app.fetch }) as AnyServer;
        // Bun's Server type exposes `port` at runtime.
        this.port = (this.server as unknown as { port: number }).port;
    }

    async stop(): Promise<void> {
        if (this.server !== null) {
            this.server.stop();
            this.server = null;
        }
    }

    setBehavior(b: RouterBehavior, count = 1): void {
        this.behavior = b;
        this.failuresRemaining = count;
    }

    getReceivedCommands(): RecordedCommand[] {
        return [...this.commands];
    }

    reset(): void {
        this.commands = [];
        this.behavior = "ok";
        this.failuresRemaining = 0;
    }

    private computeStatus(): number {
        if (this.behavior === "ok") return 200;
        if (this.behavior === "fail-permanent") return 422;
        if (this.behavior === "fail-transient") return 503;
        if (this.behavior === "fail-then-ok") {
            if (this.failuresRemaining > 0) {
                this.failuresRemaining -= 1;
                return 503;
            }
            return 200;
        }
        return 200;
    }

    private computeErrorMessage(status: number): string {
        if (status === 422) return "Mock validation error";
        if (status === 503) return "Mock service unavailable";
        return `HTTP ${String(status)}`;
    }

    private computeErrorCode(status: number): string {
        if (status === 422) return "INVALID_TRANSITION";
        if (status === 503) return "SERVICE_UNAVAILABLE";
        return `HTTP_${String(status)}`;
    }
}
