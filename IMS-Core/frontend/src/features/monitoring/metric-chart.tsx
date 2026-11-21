import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';

export interface Series {
  key: string;
  label: string;
  /** CSS colour, e.g. "var(--color-primary)". */
  color: string;
}

interface MetricChartProps {
  title: string;
  description?: string;
  /** Points with a `collectedAt` ISO timestamp plus one numeric field per series. */
  data: readonly { collectedAt: string }[];
  series: Series[];
  /** Formats values on the axis and in the tooltip. */
  format: (v: number) => string;
  /** Fixed 0..100 domain for percentages. */
  percent?: boolean;
  longRange?: boolean;
  loading?: boolean;
  current?: string;
}

function timeLabel(iso: string, longRange: boolean): string {
  const d = new Date(iso);
  return longRange ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Minimal area chart in the dashboard's visual language (no chart junk, soft gradients). */
export function MetricChart({ title, description, data, series, format, percent, longRange = false, loading, current }: MetricChartProps) {
  const gid = useId().replace(/:/g, '');
  const empty =
    !loading &&
    data.every((p) =>
      series.every((s) => {
        const v = (p as Record<string, unknown>)[s.key];
        return v === null || v === undefined;
      }),
    );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-[15px]">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {current && <span className="tabular text-lg font-semibold">{current}</span>}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-44 w-full" />
        ) : empty ? (
          <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">No data in this range</div>
        ) : (
          <div className="h-44" role="img" aria-label={`${title} chart`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data as { collectedAt: string }[]} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  {series.map((s) => (
                    <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="collectedAt"
                  tickFormatter={(v: string) => timeLabel(v, longRange)}
                  tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  width={52}
                  domain={percent ? [0, 100] : [0, 'auto']}
                  tickFormatter={(v: number) => format(v)}
                  tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  tickCount={5}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--color-border)' }}
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <div className="glass rounded-xl border border-border/70 px-3 py-2 text-[12px] shadow-[var(--shadow-float)]">
                        <p className="mb-1 text-muted-foreground">{new Date(String(label)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
                        {payload.map((p) => (
                          <p key={String(p.dataKey)} className="flex items-center gap-2">
                            <span className="size-2 rounded-full" style={{ background: p.color }} />
                            <span>{series.find((s) => s.key === p.dataKey)?.label}</span>
                            <span className="tabular ml-auto font-medium">{typeof p.value === 'number' ? format(p.value) : '—'}</span>
                          </p>
                        ))}
                      </div>
                    ) : null
                  }
                />
                {series.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={1.75}
                    fill={`url(#${gid}-${s.key})`}
                    isAnimationActive={false}
                    connectNulls={false}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
