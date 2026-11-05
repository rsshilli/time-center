import { useEffect, useRef, useState } from "react";
import type { CategoryRule, RuleField, TimelineItem } from "../shared/ipc";
import { formatDuration } from "./format";
import { FIELD_LABELS } from "./RulesEditor";
import { knownCategories, uncategorizedGroups, type UncategorizedGroup } from "./uncategorized";

/**
 * The day's uncategorized time, one row per website, WebStorm project or app, each with a rule filled in
 * that would sort it. Picking a category and pressing Add rule saves the rule at the end of the list, so
 * it can only sort time no other rule already sorts.
 * @param props.timeline The day's stretches.
 * @param props.onClose Called to hide the panel.
 * @param props.onRuleAdded Called after a rule is saved, to re-read the day.
 */
export function UncategorizedPanel({
  timeline,
  onClose,
  onRuleAdded,
}: {
  timeline: TimelineItem[];
  onClose: () => void;
  onRuleAdded: () => void;
}) {
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const groups = uncategorizedGroups(timeline);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.timeCenter.getRules().then((rules) => setCategories(knownCategories(rules)));
    // The panel opens below the totals, often off screen, so bring it into view.
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /**
   * Adds a rule at the end of the saved list. The list is read again first, so a rule saved from
   * Settings in the meantime isn't lost.
   * @param rule The new rule.
   */
  const addRule = async (rule: CategoryRule) => {
    try {
      const saved = await window.timeCenter.saveRules([...(await window.timeCenter.getRules()), rule]);
      setCategories(knownCategories(saved));
      setMessage(`Added: ${FIELD_LABELS[rule.field]} "${rule.pattern}" → ${rule.category}.`);
      onRuleAdded();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(`Couldn't add the rule: ${text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  };

  return (
    <div className="card uncategorized" ref={panel}>
      <header className="uncategorized-header">
        <h2>Uncategorized time</h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="muted">
        Pick a category for each one to add a rule. New rules go at the end of the list in Settings, so they
        only sort time that's still uncategorized, on this day and every other.
      </p>
      {message && <p className="message">{message}</p>}
      {groups.length === 0 ? (
        <p className="muted">Nothing uncategorized on this day.</p>
      ) : (
        <ul className="uncategorized-list">
          {groups.map((group) => (
            <GroupRow key={`${group.field}\n${group.pattern}`} group={group} categories={categories} onAdd={addRule} />
          ))}
        </ul>
      )}
      <datalist id="known-categories">
        {categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * One thing that took uncategorized time, with an editable rule for it.
 * @param props.group The thing.
 * @param props.categories The categories already in use, offered while typing.
 * @param props.onAdd Called with the finished rule.
 */
function GroupRow({
  group,
  categories,
  onAdd,
}: {
  group: UncategorizedGroup;
  categories: string[];
  onAdd: (rule: CategoryRule) => Promise<void>;
}) {
  const [field, setField] = useState<RuleField>(group.field);
  const [pattern, setPattern] = useState(group.pattern);
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const fields = (Object.keys(FIELD_LABELS) as RuleField[]).filter((name) => group.sample[name]);
  const ready = pattern.trim() !== "" && category.trim() !== "" && !saving;

  /**
   * Switches the field the rule looks at, filling in this thing's value for it.
   * @param next The new field.
   */
  const changeField = (next: RuleField) => {
    setField(next);
    setPattern(group.sample[next] ?? "");
  };

  /** Saves the rule. */
  const add = async () => {
    setSaving(true);
    await onAdd({ field, pattern: pattern.trim(), category: category.trim() });
    setSaving(false);
  };

  return (
    <li className="uncategorized-row">
      <div className="uncategorized-what">
        <strong title={group.pattern}>{group.pattern}</strong>
        <span className="total-ms">{formatDuration(group.ms)}</span>
        {group.examples.length > 0 && (
          <span className="muted uncategorized-examples" title={group.examples.join("\n")}>
            {group.examples.join(" · ")}
          </span>
        )}
      </div>
      <div className="rule">
        <select value={field} onChange={(event) => changeField(event.target.value as RuleField)} aria-label="Match on">
          {fields.map((name) => (
            <option key={name} value={name}>
              {FIELD_LABELS[name]}
            </option>
          ))}
        </select>
        <input value={pattern} onChange={(event) => setPattern(event.target.value)} aria-label="Pattern" />
        <span className="arrow">→</span>
        <input
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ready) {
              void add();
            }
          }}
          list="known-categories"
          placeholder={categories[0] ? `e.g. ${categories[0]}` : "Category"}
          aria-label="Category"
        />
        <button disabled={!ready} onClick={() => void add()}>
          Add rule
        </button>
      </div>
    </li>
  );
}
