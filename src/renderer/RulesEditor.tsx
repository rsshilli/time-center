import { useEffect, useState } from "react";
import type { CategoryRule, RuleField } from "../shared/ipc";

/** The fields a rule can look at, as the user reads them. */
export const FIELD_LABELS: Record<RuleField, string> = {
  app: "App name contains",
  domain: "Website is",
  url: "Web address contains",
  title: "Window title contains",
  project: "WebStorm project contains",
};

/**
 * Edits the rules that sort time into categories. The first rule that matches wins; time no rule
 * matches is "Uncategorized". Saved rules re-sort past days as well.
 */
export function RulesEditor() {
  const [rules, setRules] = useState<CategoryRule[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.timeCenter.getRules().then(setRules);
  }, []);

  if (!rules) {
    return null;
  }

  /**
   * Changes one field of one rule.
   * @param index The rule's position.
   * @param change The new values.
   */
  const edit = (index: number, change: Partial<CategoryRule>) => {
    setRules(rules.map((rule, position) => (position === index ? { ...rule, ...change } : rule)));
    setMessage(null);
  };

  /**
   * Swaps a rule with its neighbour, since order decides which rule wins.
   * @param index The rule's position.
   * @param direction -1 to move it up, 1 to move it down.
   */
  const move = (index: number, direction: -1 | 1) => {
    const next = [...rules];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setRules(next);
    setMessage(null);
  };

  /** Saves the rules, dropping empty rows the user added but never filled in. */
  const save = async () => {
    const filled = rules.filter((rule) => rule.pattern.trim() || rule.category.trim());
    try {
      setRules(await window.timeCenter.saveRules(filled));
      setMessage("Saved. The dashboard now sorts every day with these rules.");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(`Couldn't save: ${text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  };

  return (
    <section className="rules">
      <h1>Categories</h1>
      <p className="lead">
        These rules sort your time into categories, top to bottom: the first rule that matches wins. Changes
        apply to past days too.
      </p>
      <div className="settings">
        {rules.map((rule, index) => (
          <div className="rule" key={index}>
            <select value={rule.field} onChange={(event) => edit(index, { field: event.target.value as RuleField })}>
              {(Object.keys(FIELD_LABELS) as RuleField[]).map((field) => (
                <option key={field} value={field}>
                  {FIELD_LABELS[field]}
                </option>
              ))}
            </select>
            <input
              value={rule.pattern}
              onChange={(event) => edit(index, { pattern: event.target.value })}
              placeholder="e.g. github.com"
              aria-label="Pattern"
            />
            <span className="arrow">→</span>
            <input
              value={rule.category}
              onChange={(event) => edit(index, { category: event.target.value })}
              placeholder="Category"
              aria-label="Category"
            />
            <div className="rule-actions">
              <button className="secondary" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                ↑
              </button>
              <button
                className="secondary"
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
              <button
                className="secondary"
                onClick={() => setRules(rules.filter((_, position) => position !== index))}
                aria-label="Remove rule"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <div className="actions">
          <button className="secondary" onClick={() => setRules([...rules, { field: "app", pattern: "", category: "" }])}>
            Add rule
          </button>
          <button onClick={() => void save()}>Save rules</button>
        </div>
      </div>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
