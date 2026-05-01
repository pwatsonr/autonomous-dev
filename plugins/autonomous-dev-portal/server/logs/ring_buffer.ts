// SPEC-015-3-03 — Per-client ring buffer with byte budget.
//
// FIFO eviction. JSON.stringify length is used as a UTF-8 byte
// approximation (close enough for budgeting). One instance per SSE
// client; max 1MB by default.

const DEFAULT_MAX_BYTES = 1024 * 1024;

interface Slot<T> {
    entry: T;
    bytes: number;
}

export class RingBuffer<T extends { timestamp: string }> {
    private slots: Slot<T>[] = [];
    private bytes = 0;
    private readonly maxBytes: number;

    constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
        this.maxBytes = maxBytes;
    }

    /** Push an entry; evict oldest until size().bytes <= maxBytes. */
    push(entry: T): { evicted: number } {
        const cost = JSON.stringify(entry).length;
        this.slots.push({ entry, bytes: cost });
        this.bytes += cost;
        let evicted = 0;
        while (this.bytes > this.maxBytes && this.slots.length > 0) {
            const removed = this.slots.shift();
            if (!removed) break;
            this.bytes -= removed.bytes;
            evicted += 1;
        }
        return { evicted };
    }

    /** Oldest-to-newest copy. */
    snapshot(): T[] {
        return this.slots.map((s) => s.entry);
    }

    /**
     * Return entries with timestamp > lastTimestamp. ISO-8601 strings
     * compare lexically, so no parsing required for this hot path.
     */
    takeSince(lastTimestamp: string | undefined): T[] {
        if (lastTimestamp === undefined) return this.snapshot();
        const out: T[] = [];
        for (const s of this.slots) {
            if (s.entry.timestamp > lastTimestamp) out.push(s.entry);
        }
        return out;
    }

    size(): { count: number; bytes: number } {
        return { count: this.slots.length, bytes: this.bytes };
    }

    clear(): void {
        this.slots = [];
        this.bytes = 0;
    }
}
