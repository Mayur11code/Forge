"use client";

import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
} from "recharts";

interface Props {
    data: {
        name: string;
        value: number;
    }[];
}

export default function PriorityChart({ data }: Props) {
    return (
        <div className="w-full h-64">
            <ResponsiveContainer>
                <BarChart data={data}>
                    <XAxis
                        dataKey="name"
                        stroke="#52525b"
                        tick={{ fill: "#71717a", fontSize: 12 }}
                    />

                    <YAxis
                        stroke="#52525b"
                        tick={{ fill: "#71717a", fontSize: 12 }}
                    />
                    <Tooltip
                        cursor={{ fill: "rgba(255,255,255,0.04)" }}
                        contentStyle={{
                            backgroundColor: "#18181b",
                            border: "1px solid #27272a",
                            borderRadius: "12px",
                        }}
                        labelStyle={{ color: "#e4e4e7" }}
                        itemStyle={{ color: "#a1a1aa" }}
                    />

                    <defs>
                        <linearGradient id="colorPriority" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.2} />
                        </linearGradient>
                    </defs>

                    <Bar
                        dataKey="value"
                        fill="url(#colorPriority)"
                        
                        radius={[8, 8, 0, 0]}
                        activeBar={false}
                    />

                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
