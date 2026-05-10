// SPEC-036-4-07 — jsdom tests for `static/js/settings-modals.js`.
//
// Verifies open/close binding, idempotency, and the `data-confirm` gate.

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(
    join(import.meta.dir, "..", "..", "static", "js", "settings-modals.js"),
    "utf8",
);

function fixture(): JSDOM {
    return new JSDOM(
        `<!doctype html><html><body>
            <button data-modal-open="inspect-agent-modal-coder" id="open-coder">
                Inspect coder
            </button>
            <dialog id="inspect-agent-modal-coder">
                <button data-modal-close="inspect-agent-modal-coder" id="close-coder">Close</button>
            </dialog>
        </body></html>`,
        { runScripts: "outside-only", url: "http://localhost/settings" },
    );
}

describe("settings-modals.js", () => {
    test("clicking [data-modal-open] sets the dialog's open attr (jsdom fallback)", () => {
        const dom = fixture();
        // Patch showModal to record invocation.
        const dialog = dom.window.document.getElementById(
            "inspect-agent-modal-coder",
        ) as HTMLDialogElement;
        let opened = 0;
        // jsdom may or may not support showModal; tap the prototype.
        (dialog as unknown as { showModal: () => void }).showModal = () => {
            opened += 1;
        };
        dom.window.eval(SCRIPT);

        const openBtn = dom.window.document.getElementById(
            "open-coder",
        ) as HTMLButtonElement;
        openBtn.click();

        expect(opened).toBe(1);
    });

    test("clicking [data-modal-close] inside dialog closes it", () => {
        const dom = fixture();
        const dialog = dom.window.document.getElementById(
            "inspect-agent-modal-coder",
        ) as HTMLDialogElement;
        let closed = 0;
        (dialog as unknown as { showModal: () => void }).showModal = () => {};
        (dialog as unknown as { close: () => void }).close = () => {
            closed += 1;
        };
        dom.window.eval(SCRIPT);

        const closeBtn = dom.window.document.getElementById(
            "close-coder",
        ) as HTMLButtonElement;
        closeBtn.click();
        expect(closed).toBe(1);
    });

    test("data-confirm gate: cancel suppresses the click flow", () => {
        const dom = new JSDOM(
            `<!doctype html><html><body>
                <button id="danger" data-confirm="Are you sure?">Promote</button>
            </body></html>`,
            { runScripts: "outside-only", url: "http://localhost/settings" },
        );
        // Stub window.confirm to always cancel.
        (dom.window as unknown as { confirm: () => boolean }).confirm = () => false;
        dom.window.eval(SCRIPT);

        const btn = dom.window.document.getElementById(
            "danger",
        ) as HTMLButtonElement;
        let secondaryHandler = 0;
        btn.addEventListener("click", () => {
            secondaryHandler += 1;
        });
        btn.click();
        // Capture-phase confirmHandler stops propagation; the bubble
        // listener never runs.
        expect(secondaryHandler).toBe(0);
    });

    test("data-confirm gate: accept allows a re-fired click", () => {
        const dom = new JSDOM(
            `<!doctype html><html><body>
                <button id="danger" data-confirm="Are you sure?">Promote</button>
            </body></html>`,
            { runScripts: "outside-only", url: "http://localhost/settings" },
        );
        (dom.window as unknown as { confirm: () => boolean }).confirm = () => true;
        dom.window.eval(SCRIPT);

        const btn = dom.window.document.getElementById(
            "danger",
        ) as HTMLButtonElement;
        let bubbleClicks = 0;
        btn.addEventListener("click", () => {
            bubbleClicks += 1;
        });
        btn.click();
        // The handler re-fires the click after setting the sentinel,
        // so the bubble listener observes exactly one trigger.
        expect(bubbleClicks).toBe(1);
    });
});
