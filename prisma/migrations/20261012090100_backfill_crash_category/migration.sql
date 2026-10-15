-- Separate from add_rule_tiers: a value added with ALTER TYPE ... ADD VALUE
-- cannot be used in the same transaction. Same mapping as categoryForRule.
UPDATE "findings" SET "category" = 'CRASH'
WHERE "source" = 'STATIC' AND "ruleId" IN ('code.syntax_error', 'code.debugger_left');
