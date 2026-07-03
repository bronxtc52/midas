#!/usr/bin/env bash
# Create/update the MIDAS state-machine labels on bronxtc52/midas.
# Idempotent: gh label create --force overwrites color/description if the label exists.
# Usage: ./scripts/bootstrap-labels.sh
set -euo pipefail

REPO="bronxtc52/midas"

# state:* — shades of blue, darker = further along the pipeline.
gh label create "state:ready"     --repo "$REPO" --color "C5DEF5" --description "Issue ready for Planner"        --force
gh label create "state:planning"  --repo "$REPO" --color "9DC6ED" --description "Planner is drafting a plan"     --force
gh label create "state:coding"    --repo "$REPO" --color "6FA8DC" --description "Worker is implementing the plan" --force
gh label create "state:review"    --repo "$REPO" --color "3D85C6" --description "PR open, awaiting Reviewer"     --force
gh label create "state:blocked"   --repo "$REPO" --color "1155CC" --description "Blocked, needs owner input"     --force
gh label create "state:accepted"  --repo "$REPO" --color "0B5394" --description "Accepted by Acceptor"           --force
gh label create "state:rejected"  --repo "$REPO" --color "073763" --description "Rejected, back to coding"       --force

# midas:accept / midas:reject — Acceptor verdict, green/red.
gh label create "midas:accept" --repo "$REPO" --color "2DA44E" --description "Acceptor: DoD met"     --force
gh label create "midas:reject" --repo "$REPO" --color "CF222E" --description "Acceptor: DoD not met" --force

echo "Labels bootstrapped on $REPO."
