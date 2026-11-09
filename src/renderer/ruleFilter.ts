import type { CategoryRule, RuleField } from "../shared/ipc";

/**
 * Says whether a rule matches the filter typed above the rules: its pattern, its category or what it looks
 * at ("Website is"), ignoring case. A blank rule always shows, so a row just added while filtering doesn't vanish.
 * @param rule The rule.
 * @param query What was typed.
 * @param fieldLabels What each field is called on screen.
 * @returns True to show the rule.
 */
export function ruleMatches(rule: CategoryRule, query: string, fieldLabels: Record<RuleField, string>): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted || (!rule.pattern.trim() && !rule.category.trim())) {
    return true;
  }
  return [rule.pattern, rule.category, fieldLabels[rule.field]].some((text) => text.toLowerCase().includes(wanted));
}
