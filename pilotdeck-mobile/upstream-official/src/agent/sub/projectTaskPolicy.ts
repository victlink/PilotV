import { toolPolicyToRuleSet } from '../../permission/index.js';

type Policy = Parameters<typeof toolPolicyToRuleSet>[0];

/** A delegated session has no approval UI: approval-required actions fail closed. */
export function projectTaskPolicy(policy: Policy) {
  return toolPolicyToRuleSet({
    ...policy,
    deny: [...(policy.deny ?? []), ...(policy.ask ?? [])],
  });
}
