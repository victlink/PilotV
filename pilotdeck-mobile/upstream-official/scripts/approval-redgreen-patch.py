#!/usr/bin/env python3
"""Red/green regression guard for the unified approval center (batch B).

The production behaviour of the batch B is *good*; a regression test only
proves something when it can fail. This script therefore flips the shipped
behaviour back to its pre-batch-B shape for a moment, so the focused tests
can be observed failing (red) and passing again (restore -> green).

It is a *guard*, not a change: in its default state it does not touch a
single file. An explicit action argument is required.

    python3 scripts/approval-redgreen-patch.py revert    # -> red
    python3 scripts/approval-redgreen-patch.py restore   # -> green

Patches
-------

T1  `src/cli/createLocalGateway.ts`
    The gateway factory does not attach the approval runtime any more, so a
    permission request never reaches the approval center.

T4  `src/gateway/client/InProcessGateway.ts`
    A decision refused by the approval guard no longer returns the refusal
    reason to the caller.

T5  `src/gateway/server/GatewayWsConnection.ts`
    The websocket entry point no longer validates `sessionKey` / `requestId` /
    `decision` of a `permission_decide` payload.

Every patch is an exact string replacement, so `restore` restores the byte
identical original text.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (new_text, old_text) — `revert` replaces new_text by old_text, `restore`
# does the opposite.
PATCHES: list[dict[str, object]] = [
    {
        "id": "T1",
        "file": "src/cli/createLocalGateway.ts",
        "replacements": [
            (
                """  approvalHandle = attachApprovalRuntime({
    gateway,
    pilotHome,
    ...(options.resolveApprovalChannel
      ? { resolveChannel: options.resolveApprovalChannel }
      : {}),
    logger: options.approvalLogger ?? {},
  });
""",
                """  // RED-GREEN PATCH (temporary revert): the approval runtime is not
  // attached by the gateway factory any more.
  approvalHandle = undefined as unknown as ApprovalRuntimeHandle;
""",
            ),
            (
                """      approvalHandle.stop();
""",
                """      approvalHandle?.stop();
""",
            ),
        ],
    },
    {
        "id": "T4",
        "file": "src/gateway/client/InProcessGateway.ts",
        "replacements": [
            (
                """      // The refusal reason must reach the caller, otherwise the Web client
      // and the chat adapter cannot tell "refused" from "expired"
      // (contract §4 state semantics).
      return { delivered: false, reason: guard.reason ?? "approval_decision_blocked" };
""",
                """      // RED-GREEN PATCH (temporary revert): the refusal reason is dropped.
      return { delivered: false };
""",
            ),
        ],
    },
    {
        "id": "T5",
        "file": "src/gateway/server/GatewayWsConnection.ts",
        "replacements": [
            (
                """  const sessionKey = params.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.trim().length === 0) {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidSessionKey,
      "Invalid permission_decide params: sessionKey must be a non-empty string.",
    );
  }
""",
                """  // RED-GREEN PATCH (temporary revert): the sessionKey is not validated.
  const sessionKey = String(params.sessionKey ?? "");
""",
            ),
            (
                """  const requestId = params.requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidRequestId,
      "Invalid permission_decide params: requestId must be a non-empty string.",
    );
  }
""",
                """  // RED-GREEN PATCH (temporary revert): the requestId is not validated.
  const requestId = String(params.requestId ?? "");
""",
            ),
            (
                """  const decision = params.decision;
  if (decision !== "allow" && decision !== "deny") {
    throw new WebPermissionDecisionValidationError(
      WEB_PERMISSION_DECISION_REASONS.invalidDecision,
      "Invalid permission decision; expected allow or deny.",
    );
  }
""",
                """  // RED-GREEN PATCH (temporary revert): the decision is not validated.
  const decision = params.decision === "deny" ? "deny" : "allow";
""",
            ),
        ],
    },
]


def apply(action: str) -> int:
    if action not in ("revert", "restore"):
        print(f"unknown action: {action}", file=sys.stderr)
        return 2

    failures = 0
    for patch in PATCHES:
        path = ROOT / str(patch["file"])
        text = path.read_text(encoding="utf-8")
        for new_text, old_text in patch["replacements"]:  # type: ignore[misc]
            source, target = (new_text, old_text) if action == "revert" else (old_text, new_text)
            count = text.count(source)
            if count != 1:
                print(
                    f"[{patch['id']}] SKIP {patch['file']}: expected exactly one occurrence, "
                    f"found {count} — the file is not in the expected shape",
                    file=sys.stderr,
                )
                failures += 1
                continue
            text = text.replace(source, target, 1)
        path.write_text(text, encoding="utf-8")
        print(f"[{patch['id']}] {action} applied to {patch['file']}")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in ("revert", "restore"):
        print(
            "usage: python3 scripts/approval-redgreen-patch.py {revert|restore}\n"
            "  revert  — put the batch B behaviour back into its pre-batch-B shape\n"
            "  restore — restore the shipped batch B behaviour",
            file=sys.stderr,
        )
        return 2
    return apply(argv[1])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
