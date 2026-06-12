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
    /** CSRF token for the inline add-row form. */
    csrfToken?: string;
}

const TONE: Record<AllowlistEntry["status"], "ok" | "warn" | "err"> = {
    ok: "ok",
    missing: "warn",
    "not-a-repo": "err",
};

export const AllowlistTable: FC<Props> = ({ entries, csrfToken }) => {
    const dataAllowlist = entries.map((e) => e.path).join("\n");
    return (
        <>
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
                {entries.length === 0 ? (
                    <tr>
                        <td colspan={3} class="empty dim">
                            No repositories in the allowlist yet — add the
                            first one below.
                        </td>
                    </tr>
                ) : null}
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
                {/* crawl p9 polish (operator request): adding a repo is a
                    ROW in the same table — type the path where paths
                    live, press Add, and the new entry inserts directly
                    above (the row fragment the server returns targets
                    this row with beforebegin — which also fixes the old
                    broken wiring that replaced the WHOLE table with one
                    orphan <tr>). The <form> lives outside the table
                    (tr children must be td); controls reference it via
                    the form= attribute. */}
                <tr class="allowlist-add-row">
                    <td class="mono">
                        <input
                            type="text"
                            id="allowlist-new-path"
                            name="path"
                            form="allowlist-add-form"
                            class="input mono allowlist-add-input"
                            placeholder="/Users/op/repos/foo"
                            data-validate="allowlist-path"
                            autocomplete="off"
                            aria-label="Add repo (absolute path)"
                        />
                    </td>
                    <td>
                        <span class="dim mono">—</span>
                    </td>
                    <td>
                        <Btn
                            kind="primary"
                            size="sm"
                            type="submit"
                            form="allowlist-add-form"
                            disabled
                        >
                            Add
                        </Btn>
                    </td>
                </tr>
            </tbody>
        </table>
        <form
            id="allowlist-add-form"
            hx-post="/api/settings/allowlist"
            hx-target=".allowlist-add-row"
            hx-swap="beforebegin"
        >
            {csrfToken !== undefined && csrfToken.length > 0 ? (
                <input type="hidden" name="_csrf" value={csrfToken} />
            ) : null}
        </form>
        </>
    );
};
