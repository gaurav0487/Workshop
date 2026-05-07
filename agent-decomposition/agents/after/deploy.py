# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
from agents import cma
from agents.after.agent import build_config


def main() -> dict:
    return cma.deploy("after", build_config)


if __name__ == "__main__":
    main()
