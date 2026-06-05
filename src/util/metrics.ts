/**
 * Tool-call latency ring buffer for performance observability.
 *
 * Keeps the last 1000 durationMs samples per tool name and exposes
 * p50/p95/max/mean stats through the `doctor` tool.
 *
 * Singleton instance: import `metrics` and call `record()` on every
 * completed tool call. Tests that need isolation can construct their own
 * Metrics instance.
 */

const RING_SIZE = 1000;

export interface MetricStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export class Metrics {
  private buffers: Map<string, number[]> = new Map();
  private order: string[] = [];
  private writeIndex: Map<string, number> = new Map();
  private totalWrites: Map<string, number> = new Map();

  /** Record a durationMs sample for the named tool. */
  record(toolName: string, durationMs: number): void {
    let buf = this.buffers.get(toolName);
    if (!buf) {
      buf = new Array<number>(RING_SIZE).fill(0);
      this.buffers.set(toolName, buf);
      this.order.push(toolName);
      this.writeIndex.set(toolName, 0);
      this.totalWrites.set(toolName, 0);
    }
    const idx = this.writeIndex.get(toolName)!;
    buf[idx] = durationMs;
    this.writeIndex.set(toolName, (idx + 1) % RING_SIZE);
    this.totalWrites.set(toolName, (this.totalWrites.get(toolName) ?? 0) + 1);
  }

  /** Get stats for one tool, or aggregate across all tools. */
  stats(toolName?: string): MetricStats {
    if (toolName !== undefined) {
      return this.computeStats(this.liveSamples(toolName));
    }
    const all: number[] = [];
    for (const name of this.order) {
      all.push(...this.liveSamples(name));
    }
    return this.computeStats(all);
  }

  /** Stats for every tracked tool. */
  byTool(): Record<string, MetricStats> {
    const out: Record<string, MetricStats> = {};
    for (const name of this.order) {
      const samples = this.liveSamples(name);
      if (samples.length > 0) {
        out[name] = this.computeStats(samples);
      }
    }
    return out;
  }

  /** Clear all recorded samples. Mostly for tests. */
  reset(): void {
    this.buffers.clear();
    this.order.length = 0;
    this.writeIndex.clear();
    this.totalWrites.clear();
  }

  private liveSamples(toolName: string): number[] {
    const buf = this.buffers.get(toolName);
    if (!buf) return [];
    const total = this.totalWrites.get(toolName) ?? 0;
    if (total < RING_SIZE) {
      return buf.slice(0, total);
    }
    // Ring is full — all RING_SIZE slots contain the most recent samples.
    return buf.slice();
  }

  private computeStats(samples: number[]): MetricStats {
    if (samples.length === 0) {
      return { count: 0, p50: 0, p95: 0, max: 0, mean: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      count: sorted.length,
      p50: round(this.percentile(sorted, 0.5)),
      p95: round(this.percentile(sorted, 0.95)),
      max: round(sorted[sorted.length - 1]),
      mean: round(sum / sorted.length),
    };
  }

  /** Nearest-rank percentile on a pre-sorted ascending array. */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 1) return sorted[0];
    const rank = Math.ceil(p * sorted.length);
    const idx = Math.max(0, Math.min(rank - 1, sorted.length - 1));
    return sorted[idx];
  }
}

/** Singleton shared across the process. */
export const metrics = new Metrics();
