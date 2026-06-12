// SPEC-036-4-05 §Repo allowlist table — fragment for snapshot testing.
//
// Columns: Path (mono), Status (Chip), Added at, Action (remove).
// Empty state renders the kit's empty-state with a primary CTA.
// `data-allowlist` mirrors the current set of paths so trust-tab client
// validators can reference it without re-querying the DOM.

import type { FC } from "hono/jsx";

import { Btn, Chip } from "../../components/primitives";
import type { AllowlistEntry } from "../../types/render";

interface Props {
    entries: AllowlistEntry[];
}

const TONE: Record<AllowlistEntry["status"], "ok" | "warn" | "err"> = {
    ok: "ok",
    missing: "warn",
    "not-a-repo": "err",
};

export const AllowlistTable: FC<Props> = ({ entries }) => {
    const dataAllowlist = entries.map((e) => e.path).join("\n");
    if (entries.length === 0) {
        return (
            <div
                class="empty"
                data-fragment="allowlist-table"
                data-allowlist=""
            >
                <p>No repos allowlisted.</p>
                <Btn kind="primary" data-action="focus-allowlist-input">
                    Add your first repo
                </Btn>
            </div>
        );
    }
    return (
        <table
            class="tbl"
            data-fragment="allowlist-table"
            data-allowlist={dataAllowlist}
        >
            <thead>
                <tr>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                {entries.map((entry) => (
                    <tr data-allowlist-id={entry.id}>
                        <td class="mono">{entry.path}</td>
                        <td>
                            <Chip variant="status" tone={TONE[entry.status]}>
                                {entry.status}
                            </Chip>
                        </td>
                        <td>
                            <Btn
                                kind="ghost"
                                size="sm"
                                data-confirm={`Remove ${entry.path} from allowlist? Active requests for this repo will be aborted.`}
                                data-action="remove-allowlist-entry"
                                data-allowlist-id={entry.id}
                            >
                                Remove
                            </Btn>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};
