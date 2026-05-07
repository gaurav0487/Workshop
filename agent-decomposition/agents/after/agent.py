# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""StockPilot after — the reference target.

One CMA agent, 15-line system prompt, 5 skills, code execution via Bash.
Subagent spawning is a runtime decision the `forecasting` skill drives.
"""
from __future__ import annotations

from agents.anchor import DATE_ANCHOR
from agents.cma import agent_name_for
from agents.common import MODEL

SKILLS = [
    "reorder-policy",
    "supplier-selection",
    "forecasting",
    "notify-templates",
    "weekly-report",
]

SYSTEM_PROMPT = f"""You are StockPilot, an inventory management agent for a mid-size
outdoor-gear retailer. {DATE_ANCHOR}

First, run: `mkdir -p /mnt/user/sinks && ln -sfn /mnt/session/uploads/data /mnt/user/data`
so the paths in skills resolve. Data lives as CSVs under /mnt/user/data/
(products, stock_levels ~67k rows, sales_history 90d, supplier_catalog,
suppliers). Write sinks (purchase_orders.jsonl, outbox.jsonl, erp_writes.jsonl)
go to /mnt/user/sinks/ — append one JSON object per line, with a `sku` and
`qty` field where applicable.

For any operation touching >5 SKUs, write a Python script via Bash that
reads the CSVs and prints compact JSON — don't page through tool calls.
Business policies (reorder, supplier selection, forecasting, notifications,
reports) live in skills — load the relevant one before applying a policy.
You can delegate to the `forecaster` agent for demand estimates that need
full-history analysis — see the forecasting skill for when.

End with a direct answer, a `ReorderDecision` block, or a `StockReport`.
"""


def build_config(skill_ids: dict[str, str]) -> dict:
    return {
        "name": agent_name_for("stockpilot-after"),
        "model": MODEL,
        "system": SYSTEM_PROMPT,
        "tools": [{"type": "agent_toolset_20260401"}],
        "skills": [
            {"type": "custom", "skill_id": skill_ids[n], "version": "latest"}
            for n in SKILLS
        ],
        # workshop harness flag (consumed by cma.py:deploy), NOT a CMA API field
        "wants_forecaster": True,
    }
