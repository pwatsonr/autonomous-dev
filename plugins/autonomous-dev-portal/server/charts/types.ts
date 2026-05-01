// SPEC-015-3-02 — Chart type definitions.
//
// Chart inputs are intentionally decoupled from cost-aggregation outputs
// so the renderers stay reusable for future series (latency, queue
// depth, etc.). Route handlers map domain types into these shapes.

export interface ChartDataPoint {
    date: string; // YYYY-MM-DD (or YYYY-MM)
    value: number; // USD
    label?: string;
}

export interface StackedSeries {
    date: string;
    segments: { name: string; value: number }[];
}

export interface ChartDimensions {
    width: number;
    height: number;
    margins: { top: number; right: number; bottom: number; left: number };
}

export interface AccessibilityMeta {
    title: string;
    description: string;
    data_summary: string;
}

export interface ChartOptions {
    dimensions?: Partial<ChartDimensions>;
    a11y: AccessibilityMeta;
    yAxisLabel?: string;
    showGridlines?: boolean; // default true
    showDataLabels?: boolean; // default false on line, true on stacked bar
}

export interface SparklineOptions {
    width?: number;
    height?: number;
    color?: string;
    a11yLabel?: string;
}

export const DEFAULT_DIMENSIONS: ChartDimensions = {
    width: 800,
    height: 360,
    margins: { top: 24, right: 32, bottom: 48, left: 64 },
};

export const SPARKLINE_DIMENSIONS: ChartDimensions = {
    width: 120,
    height: 24,
    margins: { top: 2, right: 2, bottom: 2, left: 2 },
};

export function mergeDimensions(
    user: Partial<ChartDimensions> | undefined,
    defaults: ChartDimensions,
): ChartDimensions {
    if (!user) return defaults;
    return {
        width: user.width ?? defaults.width,
        height: user.height ?? defaults.height,
        margins: {
            top: user.margins?.top ?? defaults.margins.top,
            right: user.margins?.right ?? defaults.margins.right,
            bottom: user.margins?.bottom ?? defaults.margins.bottom,
            left: user.margins?.left ?? defaults.margins.left,
        },
    };
}
